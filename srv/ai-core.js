'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const axios = require('axios');

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

class AiCoreError extends Error {
  constructor(message, status = 502, detail = '') {
    super(message);
    this.name = 'AiCoreError';
    this.status = status;
    this.detail = detail;
  }
}

function projectRoot() {
  try {
    const cds = require('@sap/cds');
    if (cds.root) return cds.root;
  } catch (error) {
    /* tests can load this file before CAP starts */
  }
  return path.join(__dirname, '..');
}

function readDefaultEnv() {
  const file = path.join(projectRoot(), 'default-env.json');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new AiCoreError('default-env.json is not valid JSON.', 500);
  }
}

function readVcap() {
  if (!process.env.VCAP_SERVICES) return {};
  let parsed;
  try {
    parsed = JSON.parse(process.env.VCAP_SERVICES);
  } catch (error) {
    return {};
  }
  const services = Object.values(parsed).flat().filter(service => service && service.credentials);
  const hit = services.find(service => {
    const name = `${service.label || ''} ${service.name || ''}`.toLowerCase();
    return name.includes('aicore') || name.includes('ai-core') || name.includes('ai core');
  });
  if (!hit) return {};
  const credentials = hit.credentials;
  const urls = credentials.serviceurls || {};
  return {
    authUrl: credentials.url || '',
    clientId: credentials.clientid || '',
    clientSecret: credentials.clientsecret || '',
    apiUrl: urls.AI_API_URL || credentials.AI_API_URL || ''
  };
}

function pick(file, key) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  if (file[key] != null && file[key] !== '') return String(file[key]);
  return '';
}

function tokenUrlFrom(authUrl) {
  if (!authUrl) return '';
  const value = String(authUrl).trim().replace(/\/+$/, '');
  return value.endsWith('/oauth/token') ? value : `${value}/oauth/token`;
}

function apiBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/+$/, '').replace(/\/v2$/i, '');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (error) {
    return '';
  }
}

function loadConfig() {
  const file = readDefaultEnv();
  const vcap = readVcap();
  const apiVersion = pick(file, 'AICORE_API_VERSION') || '2023-05-15';
  return {
    tokenUrl: tokenUrlFrom(pick(file, 'AICORE_AUTH_URL') || vcap.authUrl),
    apiUrl: apiBase(pick(file, 'AICORE_BASE_URL') || vcap.apiUrl),
    clientId: pick(file, 'AICORE_CLIENT_ID') || vcap.clientId,
    clientSecret: pick(file, 'AICORE_CLIENT_SECRET') || vcap.clientSecret,
    resourceGroup: pick(file, 'AICORE_RESOURCE_GROUP') || 'default',
    deploymentId: pick(file, 'AICORE_DEPLOYMENT_ID'),
    geminiDeploymentId: pick(file, 'AICORE_GEMINI_DEPLOYMENT_ID'),
    geminiModel: pick(file, 'AICORE_GEMINI_MODEL') || 'gemini-2.5-flash',
    apiVersion
  };
}

function missingKeys(config) {
  const missing = [];
  if (!config.tokenUrl) missing.push('AICORE_AUTH_URL');
  if (!config.clientId) missing.push('AICORE_CLIENT_ID');
  if (!config.clientSecret) missing.push('AICORE_CLIENT_SECRET');
  if (!config.apiUrl) missing.push('AICORE_BASE_URL');
  if (!config.deploymentId) missing.push('AICORE_DEPLOYMENT_ID');
  return missing;
}

function publicStatus() {
  const config = loadConfig();
  const missing = missingKeys(config);
  return {
    configured: missing.length === 0,
    missing,
    tokenHost: hostOf(config.tokenUrl),
    apiHost: hostOf(config.apiUrl),
    resourceGroup: config.resourceGroup || 'default',
    deploymentId: config.deploymentId || '',
    geminiDeploymentId: config.geminiDeploymentId || '',
    geminiModel: config.geminiModel || 'gemini-2.5-flash'
  };
}

function safeDetail(data) {
  if (data == null) return '';
  if (typeof data === 'string') {
    if (data.includes('<html') || data.includes('<!DOCTYPE')) return 'The host returned an HTML page instead of JSON.';
    return data.slice(0, 400);
  }
  if (typeof data === 'object') {
    if (data.error && data.error.message) return String(data.error.message);
    if (data.error_description) return String(data.error_description);
    if (data.message) return String(data.message);
  }
  try {
    return JSON.stringify(data).slice(0, 400);
  } catch (error) {
    return '';
  }
}

async function getToken(config) {
  let response;
  try {
    response = await axios.post(config.tokenUrl, new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials'
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new AiCoreError(`Could not reach the SAP AI Core authentication service. ${error.message}`, 502);
  }
  if (response.status !== 200 || !response.data || !response.data.access_token) {
    const detail = safeDetail(response.data);
    if (response.status === 404) {
      throw new AiCoreError('The authentication URL returned 404. Use the url from the SAP AI Core service key, without /oauth/token.', 502, detail);
    }
    throw new AiCoreError(`SAP AI Core rejected the service key (${response.status}). ${detail}`.trim(), 502, detail);
  }
  return response.data.access_token;
}

function fieldLines(fields) {
  return fields.map(field => {
    const detail = field.description ? ` — ${field.description}` : '';
    return `- ${field.name} (${field.type || 'string'}): ${field.label || field.name}${detail}`;
  }).join('\n');
}

const OUTPUT_TOKENS = 16384;
const SYSTEM_PROMPT = 'You extract business documents into the requested JSON schema. Reply with JSON only.';
const TEXT_CHUNK_CHARS = 12000;
const PAGE_TEXT_CHARS = 40;
const EXTRACT_CONCURRENCY = 3;

function extractionPrompt(schema, scope) {
  const coverage = scope && Array.isArray(scope.pages) && scope.pages.length
    ? `This part is page ${scope.pages.join(', ')} of ${scope.pageCount}.`
    : 'Read every page of the document.';
  return [
    `Extract the attached document into the schema "${schema.name}".`,
    'Return one JSON object and nothing else.',
    coverage,
    'Read the document even if it is a commercial invoice, packing list, or purchase order rather than an Indian GST tax invoice.',
    'Fill every schema field that is printed. Map the closest fact onto the field: invoice or packing-list number, PO, dates, supplier, buyer, currency, amounts, and each line row.',
    'Return every line item in this part, in the order printed. Include a row even when HSN or GST columns are blank. Do not stop after the first row or the first page, and do not return a sample row.',
    'Use an empty string only when that fact is not printed. Do not invent GSTINs or values that are not on the document.',
    'confidence is your own estimate from 0 to 1, or null when the value is empty.',
    'Dates use YYYY-MM-DD. Numbers are JSON numbers, without currency symbols.',
    'header is an object keyed by field name. lineItems is an array of objects keyed by field name.',
    'Each field is {"value": "...", "confidence": 0.0}.',
    '',
    'Header fields:',
    fieldLines(schema.headerFields),
    '',
    'Line item fields:',
    fieldLines(schema.lineItemFields)
  ].join('\n');
}

function decodePdfLiteral(body) {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[index + 1];
    if (next == null) break;
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next >= '0' && next <= '7') {
      let octal = next;
      for (let extra = 0; extra < 2; extra += 1) {
        const digit = body[index + 1];
        if (digit == null || digit < '0' || digit > '7') break;
        octal += digit;
        index += 1;
      }
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function textFromContent(content) {
  const source = content.toString('latin1');
  if (!/Tj|TJ|'|"/.test(source)) return '';
  const parts = [];
  const literals = /\((?:\\.|[^\\)])*\)/g;
  let match = literals.exec(source);
  while (match) {
    const value = decodePdfLiteral(match[0].slice(1, -1)).replace(/\s+/g, ' ').trim();
    if (value) parts.push(value);
    match = literals.exec(source);
  }
  return parts.join(' ');
}

function pdfStreamText(buffer) {
  const source = buffer.toString('latin1');
  const parts = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('stream', index);
    if (start < 0) break;
    const before = source.slice(Math.max(0, start - 300), start);
    let dataStart = start + 'stream'.length;
    if (source[dataStart] === '\r' && source[dataStart + 1] === '\n') dataStart += 2;
    else if (source[dataStart] === '\n' || source[dataStart] === '\r') dataStart += 1;
    const end = source.indexOf('endstream', dataStart);
    if (end < 0) break;
    let data = Buffer.from(source.slice(dataStart, end), 'latin1');
    if (data.length && data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 1);
    if (data.length && data[data.length - 1] === 0x0d) data = data.subarray(0, data.length - 1);
    if (/FlateDecode/.test(before)) {
      try {
        data = zlib.inflateSync(data);
      } catch (error) {
        try {
          data = zlib.inflateRawSync(data);
        } catch (rawError) {
          data = Buffer.alloc(0);
        }
      }
    }
    const text = textFromContent(data);
    if (text) parts.push(text);
    index = end + 'endstream'.length;
  }
  return parts.join('\n');
}

function linesFromItems(items) {
  const rows = [];
  (items || []).forEach(item => {
    const text = String((item && item.str) || '');
    if (!text.trim()) return;
    const y = item.transform ? Number(item.transform[5]) : 0;
    const x = item.transform ? Number(item.transform[4]) : 0;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) <= 2) last.parts.push({ x, text });
    else rows.push({ y, parts: [{ x, text }] });
  });
  return rows.map(row => row.parts
    .sort((left, right) => left.x - right.x)
    .map(part => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()).filter(Boolean).join('\n');
}

function pageHasText(page) {
  return String((page && page.text) || '').replace(/\s/g, '').length >= PAGE_TEXT_CHARS;
}

function groupPages(pages, maxChars = TEXT_CHUNK_CHARS) {
  const groups = [];
  let current = [];
  let size = 0;
  (pages || []).forEach(page => {
    const length = String(page.text || '').length + 20;
    if (current.length && size + length > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(page);
    size += length;
  });
  if (current.length) groups.push(current);
  return groups;
}

function planPdfJobs(pages, pageCount) {
  const byNumber = new Map((pages || []).map(page => [page.number, page]));
  const known = [...byNumber.keys()];
  const count = Math.max(pageCount || 0, known.length ? Math.max(...known) : 0);
  const jobs = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    groupPages(run).forEach(group => {
      jobs.push({
        kind: 'text',
        pages: group.map(page => page.number),
        text: group.map(page => `Page ${page.number}\n${page.text}`).join('\n\n')
      });
    });
    run = [];
  };
  for (let number = 1; number <= count; number += 1) {
    const page = byNumber.get(number) || { number, text: '' };
    if (pageHasText(page)) run.push(page);
    else {
      flush();
      jobs.push({ kind: 'file', pages: [number] });
    }
  }
  flush();
  return jobs;
}

function splitText(text) {
  const source = String(text || '');
  if (source.length < 800) return [source];
  const lines = source.split('\n');
  if (lines.length < 4) {
    const mid = Math.floor(source.length / 2);
    return [source.slice(0, mid), source.slice(mid)].filter(part => part.trim());
  }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')].filter(part => part.trim());
}

function textCoversDocument(pages, pageCount) {
  const usable = (pages || []).filter(pageHasText);
  const chars = usable.reduce((sum, page) => sum + page.text.replace(/\s/g, '').length, 0);
  const count = Math.max(pageCount || 0, (pages || []).length);
  if (!count) return false;
  return usable.length >= Math.ceil(count / 2) && chars >= count * 80;
}

async function pdfjsPages(buffer) {
  let pdfjs;
  const log = console.log;
  console.log = () => {};
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (error) {
    throw new AiCoreError(`The PDF text library failed to load (${error.message}).`, 500);
  } finally {
    console.log = log;
  }
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: `${fontDir}${path.sep}`
  }).promise;
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push({ number, text: linesFromItems(content.items) });
  }
  return pages;
}

async function readPdfPages(buffer) {
  try {
    const pages = await pdfjsPages(buffer);
    if (pages.some(page => page.text.replace(/\s/g, '').length >= 20)) return pages;
  } catch (error) {
    /* a compressed or unusual PDF can still be read from its streams */
  }
  const text = pdfStreamText(buffer);
  return text ? [{ number: 1, text }] : [];
}

async function readPdfText(buffer) {
  const pages = await readPdfPages(buffer);
  return pages.map(page => page.text).filter(Boolean).join('\n\n');
}

async function pdfPageCount(buffer) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const document = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return document.getPageCount();
  } catch (error) {
    return 0;
  }
}

async function slicePdf(buffer, pageNumber) {
  const { PDFDocument } = require('pdf-lib');
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const output = await PDFDocument.create();
  const [page] = await output.copyPages(source, [pageNumber - 1]);
  output.addPage(page);
  return Buffer.from(await output.save());
}

async function prepareDocument(buffer, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (extension === '.tif' || extension === '.tiff') {
    throw new AiCoreError('SAP AI Core vision models do not accept TIFF. Export the page as PNG or JPEG.', 400);
  }
  if (IMAGE_TYPES[extension]) {
    return {
      kind: 'image',
      mediaType: IMAGE_TYPES[extension],
      base64: buffer.toString('base64')
    };
  }
  if (extension === '.pdf') {
    return {
      kind: 'pdf',
      filename: path.basename(filename || 'invoice.pdf'),
      base64: buffer.toString('base64')
    };
  }
  throw new AiCoreError('Upload a PDF, PNG, or JPEG invoice.', 400);
}

function usableText(text) {
  return String(text || '').replace(/\s/g, '').length >= PAGE_TEXT_CHARS;
}

function userContent(schema, prepared, scope) {
  const prompt = extractionPrompt(schema, scope);
  const printed = prepared.text || (scope && scope.fallbackText) || '';
  const promptWithText = usableText(printed) ? `${prompt}\n\nDOCUMENT TEXT:\n${printed}` : prompt;
  if (prepared.kind === 'image') {
    return [
      {
        type: 'image_url',
        image_url: { url: `data:${prepared.mediaType};base64,${prepared.base64}` }
      },
      { type: 'text', text: promptWithText }
    ];
  }
  if (prepared.kind === 'pdf') {
    return [
      {
        type: 'file',
        file: {
          filename: prepared.filename || 'invoice.pdf',
          file_data: `data:application/pdf;base64,${prepared.base64}`
        }
      },
      { type: 'text', text: promptWithText }
    ];
  }
  return `${prompt}\n\nDOCUMENT TEXT:\n${prepared.text}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const gemini = payload.usageMetadata || payload.usage_metadata;
  if (gemini && typeof gemini === 'object') {
    const prompt = finiteNumber(gemini.promptTokenCount);
    const completion = finiteNumber(gemini.candidatesTokenCount);
    const thoughts = finiteNumber(gemini.thoughtsTokenCount);
    const total = finiteNumber(gemini.totalTokenCount);
    return {
      model: payload.modelVersion || payload.model || '',
      inputTokens: prompt,
      outputTokens: completion,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total != null ? total : [prompt, completion, thoughts].reduce((sum, value) => sum + (value || 0), 0),
      cachedTokens: finiteNumber(gemini.cachedContentTokenCount),
      reasoningTokens: thoughts,
      promptDetails: tokenDetails(gemini.promptTokensDetails),
      completionDetails: tokenDetails(gemini.candidatesTokensDetails)
    };
  }
  const openai = payload.usage;
  if (!openai || typeof openai !== 'object') return null;
  const prompt = finiteNumber(openai.prompt_tokens != null ? openai.prompt_tokens : openai.input_tokens != null ? openai.input_tokens : openai.inputTokens);
  const completion = finiteNumber(openai.completion_tokens != null ? openai.completion_tokens : openai.output_tokens != null ? openai.output_tokens : openai.outputTokens);
  const total = finiteNumber(openai.total_tokens != null ? openai.total_tokens : openai.totalTokens);
  const promptDetails = openai.prompt_tokens_details || {};
  const completionDetails = openai.completion_tokens_details || {};
  return {
    model: payload.model || payload.modelName || '',
    inputTokens: prompt,
    outputTokens: completion,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total != null ? total : (prompt || 0) + (completion || 0),
    cachedTokens: finiteNumber(promptDetails.cached_tokens != null ? promptDetails.cached_tokens : openai.cache_read_input_tokens),
    reasoningTokens: finiteNumber(completionDetails.reasoning_tokens),
    promptDetails: [],
    completionDetails: []
  };
}

function tokenDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.map(item => ({
    modality: String((item && (item.modality || item.type)) || 'text'),
    tokens: finiteNumber(item && (item.tokenCount || item.tokens))
  })).filter(item => item.tokens != null);
}

function combineUsage(parts, context) {
  const rows = (parts || []).filter(Boolean);
  if (!rows.length) return null;
  const sum = key => {
    const values = rows.map(row => row[key]).filter(value => value != null);
    if (!values.length) return null;
    return values.reduce((total, value) => total + value, 0);
  };
  const mergeDetails = key => {
    const totals = new Map();
    rows.forEach(row => (row[key] || []).forEach(item => {
      totals.set(item.modality, (totals.get(item.modality) || 0) + item.tokens);
    }));
    return [...totals.entries()].map(([modality, tokens]) => ({ modality, tokens }));
  };
  const last = [...rows].reverse().find(row => row.model) || rows[rows.length - 1];
  const extra = context || {};
  return {
    model: extra.modelName || last.model || '',
    reportedModel: last.model || extra.modelName || '',
    deploymentId: extra.deploymentId || '',
    resourceGroup: extra.resourceGroup || '',
    executableId: extra.executableId || '',
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    totalTokens: sum('totalTokens'),
    cachedTokens: sum('cachedTokens'),
    reasoningTokens: sum('reasoningTokens'),
    promptDetails: mergeDetails('promptDetails'),
    completionDetails: mergeDetails('completionDetails'),
    calls: rows.length
  };
}

function partsText(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.text) return part.text;
    if (part.json != null) return typeof part.json === 'string' ? part.json : JSON.stringify(part.json);
    return '';
  }).filter(Boolean).join('\n');
}

function messageText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload.body === 'string') {
    try {
      const nested = messageText(JSON.parse(payload.body));
      if (nested) return nested;
    } catch (error) {
      if (payload.body.trim()) return payload.body;
    }
  } else if (payload.body && typeof payload.body === 'object' && payload.body !== payload) {
    const nested = messageText(payload.body);
    if (nested) return nested;
  }
  const geminiParts = payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts;
  const geminiText = partsText(geminiParts);
  if (geminiText) return geminiText;
  const converseText = partsText(payload.output && payload.output.message && payload.output.message.content);
  if (converseText) return converseText;
  const direct = partsText(payload.content);
  if (direct) return direct;
  const choice = payload.choices && payload.choices[0];
  const content = choice && choice.message && choice.message.content;
  return partsText(content);
}

function parseModelContent(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new AiCoreError('SAP AI Core did not return JSON for the schema.', 502);
  }
}

function readCell(raw) {
  if (raw == null || raw === '') return { value: '', confidence: null };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw.value == null ? '' : raw.value;
    const confidence = raw.confidence == null || raw.confidence === '' ? null : Number(raw.confidence);
    return {
      value,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
    };
  }
  return { value: raw, confidence: null };
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function lookupRaw(source, field) {
  if (source == null) return undefined;
  if (Array.isArray(source)) {
    const wanted = new Set([field.name, field.label].map(normalizeKey).filter(Boolean));
    const hit = source.find(item => wanted.has(normalizeKey(item && (item.name || item.label || item.key || item.field))));
    if (!hit) return undefined;
    return Object.prototype.hasOwnProperty.call(hit, 'value') ? hit : { value: hit.text || hit.content || '' };
  }
  if (typeof source !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(source, field.name)) return source[field.name];
  const wanted = new Set([field.name, field.label].map(normalizeKey).filter(Boolean));
  const key = Object.keys(source).find(name => wanted.has(normalizeKey(name)));
  return key ? source[key] : undefined;
}

function rowObject(row) {
  if (Array.isArray(row)) {
    return Object.fromEntries(row.filter(cell => cell && cell.name).map(cell => [cell.name, cell]));
  }
  return row && typeof row === 'object' ? row : {};
}

function headerSourceFrom(body) {
  if (Array.isArray(body.header) && body.header.length) return body.header;
  if (body.header && typeof body.header === 'object' && Object.keys(body.header).length) return body.header;
  if (Array.isArray(body.headerFields) && body.headerFields.length) return body.headerFields;
  if (body.headerFields && typeof body.headerFields === 'object' && Object.keys(body.headerFields).length) return body.headerFields;
  return body;
}

function mapExtraction(schema, parsed) {
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  const headerSource = headerSourceFrom(body);
  const header = schema.headerFields.map(field => {
    const cell = readCell(lookupRaw(headerSource, field));
    return { ...field, value: cell.value, confidence: cell.confidence };
  });
  const rows = body.lineItems || body.lineItemFields || body.items || [];
  const lineItems = (Array.isArray(rows) ? rows : []).map(row => {
    const source = rowObject(row);
    return schema.lineItemFields.map(field => {
      const raw = lookupRaw(source, field);
      const cell = readCell(raw != null ? raw : lookupRaw(row, field));
      return { ...field, value: cell.value, confidence: cell.confidence };
    });
  });
  return { header, lineItems };
}

function parameterValue(bindings, key) {
  const wanted = String(key).toLowerCase();
  const found = (Array.isArray(bindings) ? bindings : []).find(item => {
    const name = String((item && (item.key || item.name)) || '').toLowerCase();
    return name === wanted;
  });
  if (!found || found.value == null) return '';
  return String(found.value).trim();
}

function modelFromDeployment(deployment) {
  const details = (deployment && deployment.details) || {};
  const resources = details.resources || {};
  const scaling = details.scaling || {};
  const backend = resources.backendDetails
    || resources.backend_details
    || scaling.backendDetails
    || scaling.backend_details
    || details.backendDetails
    || details.backend_details
    || {};
  const model = backend.model || deployment.model || {};
  const modelName = model.name || deployment.modelName || parameterValue(deployment && deployment.parameterBindings, 'modelName');
  const modelVersion = model.version || deployment.modelVersion || parameterValue(deployment && deployment.parameterBindings, 'modelVersion');
  return {
    modelName: String(modelName || '').trim(),
    modelVersion: String(modelVersion || '').trim()
  };
}

function modelRole(name) {
  const model = String(name || '').trim().toLowerCase();
  if (!model) return 'unknown';
  if (model.includes('embed')) return 'embedding';
  if (
    model.includes('realtime')
    || model.includes('whisper')
    || model.includes('tts')
    || model.includes('dall')
    || model.includes('transcrib')
    || model.includes('imagen')
    || model.includes('-image')
    || model.endsWith('image')
    || model.includes('sap-rpt')
    || model.includes('rpt-')
    || model.includes('codex')
  ) return 'other';
  return 'chat';
}

function isChatModel(name) {
  return modelRole(name) === 'chat';
}

function providerFor(model) {
  const executable = String((model && model.executableId) || '').toLowerCase();
  const name = String((model && model.modelName) || model || '').toLowerCase();
  if (executable === 'gcp-vertexai' || name.startsWith('gemini')) return 'gemini';
  if (executable === 'aws-bedrock' || executable.includes('anthropic') || name.includes('claude') || name.includes('anthropic')) {
    return 'anthropic';
  }
  return 'openai';
}

function executableFor(model) {
  const provider = providerFor(model);
  if (provider === 'gemini') return 'gcp-vertexai';
  if (provider === 'anthropic') return 'aws-bedrock';
  return 'azure-openai';
}

function modelUse(name) {
  const role = modelRole(name);
  if (role === 'chat') return { usable: true, reason: '' };
  if (role === 'embedding') {
    return {
      usable: false,
      reason: `${name} is an embedding model. It cannot read an invoice. Deploy a Gemini chat model on the gcp-vertexai executable, with modelName gemini-2.5-flash and modelVersion latest.`
    };
  }
  return { usable: false, reason: `${name} cannot extract an invoice.` };
}

function reasoningModel(modelName) {
  const name = String(modelName || '').trim().toLowerCase();
  return /^o\d/.test(name) || name.startsWith('gpt-5');
}

function supportedModelNames(executable) {
  const parameters = (executable && (executable.parameters || executable.parameterDefinitions)) || [];
  const model = parameters.find(item => String(item && item.name || '').toLowerCase() === 'modelname');
  const text = String((model && model.description) || '');
  const match = text.match(/supportedModels:\s*([\s\S]+)/i);
  if (!match) return [];
  return match[1]
    .replace(/\.\.\..*$/, '')
    .split(/[,\n]/)
    .map(item => item.replace(/\.$/, '').trim())
    .filter(item => item && !/\s/.test(item));
}

function joinModelCatalog({ configurations, deployments }) {
  const configs = new Map((configurations || []).filter(item => item && item.id).map(item => [item.id, item]));
  const deployed = [];
  (deployments || []).forEach(deployment => {
    if (!deployment || String(deployment.status || '').toUpperCase() !== 'RUNNING') return;
    const configuration = configs.get(deployment.configurationId) || {};
    const bindings = configuration.parameterBindings || deployment.parameterBindings || [];
    const fromDetails = modelFromDeployment(deployment);
    const modelName = parameterValue(bindings, 'modelName') || fromDetails.modelName;
    const modelVersion = parameterValue(bindings, 'modelVersion') || fromDetails.modelVersion || 'latest';
    const scenarioId = configuration.scenarioId || deployment.scenarioId || '';
    if (scenarioId && scenarioId !== 'foundation-models') return;
    if (!isChatModel(modelName)) return;
    const use = modelUse(modelName);
    deployed.push({
      modelName,
      modelVersion,
      deploymentId: deployment.id,
      executableId: configuration.executableId || deployment.executableId || executableFor(modelName),
      configurationName: configuration.name || deployment.configurationName || '',
      deployed: true,
      usable: use.usable,
      reason: use.reason
    });
  });
  return deployed.sort((left, right) => left.modelName.localeCompare(right.modelName));
}

function configuredGemini(config) {
  const deploymentId = String((config && config.geminiDeploymentId) || '').trim();
  if (!deploymentId) return null;
  const modelName = String((config && config.geminiModel) || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';
  const use = modelUse(modelName);
  return {
    modelName,
    modelVersion: 'latest',
    deploymentId,
    executableId: 'gcp-vertexai',
    configurationName: 'AICORE_GEMINI_DEPLOYMENT_ID',
    deployed: true,
    usable: use.usable,
    reason: use.reason
  };
}

function mergeConfiguredModels(models, config) {
  const list = (models || []).map(item => ({ ...item }));
  const gemini = configuredGemini(config);
  if (!gemini) return list;
  const existing = list.find(item => item.deploymentId === gemini.deploymentId);
  if (existing) {
    if (!existing.modelName) existing.modelName = gemini.modelName;
    existing.executableId = existing.executableId || 'gcp-vertexai';
    existing.deployed = true;
    existing.usable = gemini.usable;
    existing.reason = gemini.reason;
    return list;
  }
  const runningSameName = list.find(item => item.deployed && String(item.modelName || '').toLowerCase() === gemini.modelName.toLowerCase());
  if (runningSameName) {
    runningSameName.executableId = runningSameName.executableId || 'gcp-vertexai';
    return list;
  }
  if (list.length) return list;
  return [gemini];
}

function configuredIds(config) {
  return [config && config.deploymentId, config && config.geminiDeploymentId]
    .map(id => String(id || '').trim())
    .filter(Boolean);
}

function runningDeployments(deployments) {
  return (deployments || []).filter(item => {
    if (!item || !item.id) return false;
    const status = String(item.status || '').toUpperCase();
    return !status || status === 'RUNNING';
  });
}

function catalogRank(catalog, wanted) {
  const running = new Set(runningDeployments(catalog && catalog.deployments).map(item => item.id));
  return (wanted || []).filter(id => running.has(id)).length;
}

function chooseCatalog(preferredGroup, catalogs, wanted) {
  const preferred = (catalogs || []).find(item => item.resourceGroup === preferredGroup) || (catalogs || [])[0];
  return (catalogs || []).reduce((best, item) => (
    catalogRank(item, wanted) > catalogRank(best, wanted) ? item : best
  ), preferred);
}

function includeConfiguredDeployments(models, deployments, config) {
  const running = new Map(runningDeployments(deployments).map(item => [item.id, item]));
  const list = (models || []).map(item => ({ ...item }));
  const add = (id, fallbackName, executableId) => {
    if (!id || !running.has(id)) return;
    const deployment = running.get(id);
    const fromDetails = modelFromDeployment(deployment);
    const modelName = fromDetails.modelName || fallbackName;
    if (modelName && !isChatModel(modelName)) return;
    const executable = deployment.executableId || executableId || executableFor(modelName);
    const existing = list.find(item => item.deploymentId === id);
    if (existing) {
      if (!existing.modelName && modelName) existing.modelName = modelName;
      if (!existing.executableId) existing.executableId = executable;
      return;
    }
    list.push({
      modelName: modelName || 'GPT',
      modelVersion: fromDetails.modelVersion || 'latest',
      deploymentId: id,
      executableId: executable,
      deployed: true,
      usable: true,
      reason: ''
    });
  };
  add(String((config && config.deploymentId) || '').trim(), '', 'azure-openai');
  add(String((config && config.geminiDeploymentId) || '').trim(), String((config && config.geminiModel) || '').trim(), 'gcp-vertexai');
  return list;
}

function pickDeployment(models, modelName, deploymentId) {
  const wanted = String(modelName || '').trim().toLowerCase();
  if (!wanted) return null;
  const matches = (models || []).filter(item => item.deployed && item.usable !== false && item.modelName.toLowerCase() === wanted);
  if (!matches.length) return null;
  if (deploymentId) return matches.find(item => item.deploymentId === deploymentId) || null;
  return matches[0];
}

function geminiParts(content) {
  const items = Array.isArray(content) ? content : [typeof content === 'string' ? { type: 'text', text: content } : content];
  return items.map(item => {
    if (!item) return null;
    if (typeof item === 'string') return { text: item };
    if (item.type === 'text') return { text: item.text || '' };
    const source = item.type === 'image_url'
      ? (item.image_url && item.image_url.url) || ''
      : (item.file && item.file.file_data) || '';
    const match = String(source).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { inlineData: { mimeType: match[1], data: match[2] } };
  }).filter(Boolean);
}

function geminiPayload(content, options = {}) {
  const generationConfig = { temperature: 0, maxOutputTokens: OUTPUT_TOKENS };
  if (options.json !== false) generationConfig.responseMimeType = 'application/json';
  if (options.thinking !== false) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: [{ role: 'user', parts: geminiParts(content) }],
    generationConfig
  };
}

function chatPayload(modelName, content) {
  const payload = {
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT
      },
      { role: 'user', content }
    ]
  };
  if (reasoningModel(modelName)) payload.max_completion_tokens = OUTPUT_TOKENS;
  else {
    payload.temperature = 0;
    payload.max_tokens = OUTPUT_TOKENS;
  }
  return payload;
}

function dataUrlParts(source) {
  const match = String(source || '').match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function contentHasMedia(content) {
  return Array.isArray(content) && content.some(item => item && (item.type === 'file' || item.type === 'image_url' || item.type === 'image'));
}

function anthropicBlocks(content) {
  if (typeof content === 'string') return content;
  const blocks = (Array.isArray(content) ? content : [content]).map(item => {
    if (!item) return null;
    if (typeof item === 'string') return { type: 'text', text: item };
    if (item.type === 'text') return { type: 'text', text: item.text || '' };
    if (item.type === 'image_url') {
      const parts = dataUrlParts(item.image_url && item.image_url.url);
      if (!parts) return null;
      return { type: 'image', source: { type: 'base64', media_type: parts.mediaType, data: parts.data } };
    }
    if (item.type === 'file') {
      const parts = dataUrlParts(item.file && item.file.file_data);
      if (!parts) return null;
      if (String(parts.mediaType).startsWith('image/')) {
        return { type: 'image', source: { type: 'base64', media_type: parts.mediaType, data: parts.data } };
      }
      const document = {
        type: 'document',
        source: { type: 'base64', media_type: parts.mediaType || 'application/pdf', data: parts.data }
      };
      if (item.file && item.file.filename) document.title = item.file.filename;
      return document;
    }
    return null;
  }).filter(Boolean);
  return [...blocks.filter(item => item.type !== 'text'), ...blocks.filter(item => item.type === 'text')];
}

function anthropicPayload(content) {
  return {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: anthropicBlocks(content) }]
  };
}

function converseBlocks(content) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : anthropicBlocks(content);
  const items = Array.isArray(blocks) ? blocks : [{ type: 'text', text: String(blocks || '') }];
  return items.map(item => {
    if (item.type === 'text') return { text: item.text || '' };
    if (item.type === 'image' && item.source) {
      const format = String(item.source.media_type || '').replace('image/', '') || 'png';
      return { image: { format, source: { bytes: item.source.data } } };
    }
    if (item.type === 'document' && item.source) {
      const format = String(item.source.media_type || '').includes('pdf') ? 'pdf' : 'txt';
      return { document: { format, name: 'invoice', source: { bytes: item.source.data } } };
    }
    return null;
  }).filter(Boolean);
}

function conversePayload(content) {
  return {
    inferenceConfig: { maxTokens: OUTPUT_TOKENS },
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: converseBlocks(content) }]
  };
}

function inferenceUrl(config, deploymentId) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/chat/completions`;
}

function geminiUrl(config, deploymentId, modelName) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/models/${encodeURIComponent(modelName)}:generateContent`;
}

function anthropicUrl(config, deploymentId) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/invoke`;
}

function converseUrl(config, deploymentId) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/converse`;
}

async function aiCoreGet(config, token, group, pathname, params) {
  let response;
  try {
    response = await axios.get(`${config.apiUrl}${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': group,
        Accept: 'application/json'
      },
      params,
      timeout: 30000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new AiCoreError(`Could not reach SAP AI Core. ${error.message}`, 502);
  }
  if (response.status !== 200) {
    throw new AiCoreError(
      `SAP AI Core did not list deployments (${response.status}). ${safeDetail(response.data)}`.trim(),
      response.status >= 400 && response.status < 500 ? response.status : 502,
      safeDetail(response.data)
    );
  }
  return response.data || {};
}

async function listResources(config, token, group, pathname, params) {
  const resources = [];
  const seen = new Set();
  let skip = 0;
  const top = 100;
  for (let page = 0; page < 10; page += 1) {
    const data = await aiCoreGet(config, token, group, pathname, { ...params, $top: top, $skip: skip });
    const batch = Array.isArray(data.resources) ? data.resources : [];
    let added = 0;
    batch.forEach(item => {
      const id = item && item.id;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      resources.push(item);
      added += 1;
    });
    if (!added || batch.length < top) break;
    skip += batch.length;
  }
  return resources;
}

async function hydrateConfigurations(config, token, group, deployments, listed) {
  const byId = new Map((listed || []).filter(item => item && item.id).map(item => [item.id, item]));
  const ids = [...new Set((deployments || []).map(item => item && item.configurationId).filter(Boolean))];
  await Promise.all(ids.slice(0, 30).map(async id => {
    const current = byId.get(id);
    if (current && parameterValue(current.parameterBindings, 'modelName')) return;
    try {
      const full = await aiCoreGet(config, token, group, `/v2/lm/configurations/${encodeURIComponent(id)}`);
      byId.set(id, { ...(current || {}), ...full, id });
    } catch (error) {
      /* deployment details can still name the model */
    }
  }));
  return [...byId.values()];
}

const catalogMemory = new Map();

async function loadCatalog(config, token, group) {
  const key = `${config.apiUrl}|${group}`;
  const hit = catalogMemory.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.catalog;
  const [configurations, deployments] = await Promise.all([
    listResources(config, token, group, '/v2/lm/configurations', { scenarioId: 'foundation-models' }),
    listResources(config, token, group, '/v2/lm/deployments', { scenarioId: 'foundation-models', status: 'RUNNING' })
  ]);
  const hydrated = await hydrateConfigurations(config, token, group, deployments, configurations);
  const catalog = {
    resourceGroup: group,
    deployments,
    models: joinModelCatalog({ configurations: hydrated, deployments })
  };
  catalogMemory.set(key, { at: Date.now(), catalog });
  return catalog;
}

async function listResourceGroups(config, token, preferredGroup) {
  try {
    const data = await aiCoreGet(config, token, preferredGroup || 'default', '/v2/admin/resourceGroups');
    const resources = Array.isArray(data.resources) ? data.resources : [];
    return resources
      .map(item => String((item && (item.resourceGroupId || item.id || item.name)) || '').trim())
      .filter(Boolean)
      .slice(0, 20);
  } catch (error) {
    return [];
  }
}

async function resolveModelCatalog(config, token, preferredGroup) {
  const wanted = configuredIds(config);
  const preferred = await loadCatalog(config, token, preferredGroup);
  const catalogs = [preferred];
  if (wanted.length && catalogRank(preferred, wanted) < wanted.length) {
    const groups = await listResourceGroups(config, token, preferredGroup);
    for (const group of groups) {
      if (!group || group === preferredGroup) continue;
      try {
        catalogs.push(await loadCatalog(config, token, group));
      } catch (error) {
        /* this key cannot read that resource group */
      }
      if (catalogRank(chooseCatalog(preferredGroup, catalogs, wanted), wanted) === wanted.length) break;
    }
  }
  const best = chooseCatalog(preferredGroup, catalogs, wanted);
  return {
    resourceGroup: best.resourceGroup,
    deployments: best.deployments,
    models: includeConfiguredDeployments(best.models, best.deployments, config)
  };
}

async function listChatModels({ resourceGroup } = {}) {
  const config = loadConfig();
  const group = String(resourceGroup || config.resourceGroup || 'default').trim() || 'default';
  const saved = mergeConfiguredModels([], config);
  const missing = missingKeys(config).filter(key => key !== 'AICORE_DEPLOYMENT_ID');
  if (missing.length) {
    return {
      resourceGroup: group,
      models: saved,
      error: `Add ${missing.join(', ')} to default-env.json to list deployed models.`
    };
  }
  try {
    const token = await getToken(config);
    const catalog = await resolveModelCatalog(config, token, group);
    return {
      resourceGroup: catalog.resourceGroup,
      models: catalog.models,
      error: ''
    };
  } catch (error) {
    return {
      resourceGroup: group,
      models: saved,
      error: error.message || 'Could not list foundation-model deployments.'
    };
  }
}

function deploymentExecutable(requested) {
  return executableFor(requested);
}

function directDeployment(requested, explicit, executableId) {
  const use = modelUse(requested);
  if (requested && !use.usable) throw new AiCoreError(use.reason, 400);
  return {
    deploymentId: explicit,
    modelName: requested,
    modelVersion: 'latest',
    executableId: executableId || (requested ? deploymentExecutable(requested) : ''),
    usable: true,
    reason: ''
  };
}

async function resolveChatDeployment(config, token, group, { modelName, deploymentId, executableId }, knownModels) {
  const requested = String(modelName || '').trim();
  const explicit = String(deploymentId || config.deploymentId || '').trim();
  const executable = String(executableId || '').trim();
  if (!requested && !explicit) {
    throw new AiCoreError('Add AICORE_DEPLOYMENT_ID to default-env.json, or choose a deployed model.', 400);
  }
  let models = knownModels;
  let resolvedGroup = group;
  if (models == null) {
    try {
      const catalog = await resolveModelCatalog(config, token, group);
      models = catalog.models;
      resolvedGroup = catalog.resourceGroup;
    } catch (error) {
      if (requested && explicit) return { ...directDeployment(requested, explicit, executable), resourceGroup: group };
      if (requested) throw error;
      return { ...directDeployment('', explicit, executable), resourceGroup: group };
    }
  }
  const withGroup = (match) => ({ ...match, resourceGroup: resolvedGroup });
  if (!requested) {
    const found = models.find(item => item.deployed && item.deploymentId === explicit);
    if (found && found.usable === false) throw new AiCoreError(found.reason, 400);
    return withGroup(found || directDeployment('', explicit, executable));
  }
  const match = pickDeployment(models, requested, explicit) || pickDeployment(models, requested, '');
  if (match && match.usable === false) throw new AiCoreError(match.reason, 400);
  if (match) return withGroup(match);
  if (explicit) return withGroup(directDeployment(requested, explicit, executable));
  throw new AiCoreError(
    `${requested} has no RUNNING deployment in resource group ${resolvedGroup}. Create a ${deploymentExecutable(requested)} configuration with modelName ${requested} and modelVersion latest, deploy it, and wait until the status is RUNNING.`,
    400
  );
}

async function postInference(config, token, group, url, body, params) {
  try {
    return await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': group,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      params,
      timeout: 180000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new AiCoreError(`Could not reach SAP AI Core. ${error.message}`, 502);
  }
}

function subpathRejected(response) {
  const detail = `${safeDetail(response && response.data)} ${response && response.status}`.toLowerCase();
  return response && response.status === 400 && detail.includes('subpath');
}

function documentRejected(response) {
  const detail = `${safeDetail(response && response.data)}`.toLowerCase();
  if (!response || response.status === 200) return false;
  return /document|pdf|media|content.?type|unsupported|invalid/.test(detail);
}

async function completeAnthropic(config, token, group, deployment, content) {
  const invoke = () => postInference(config, token, group, anthropicUrl(config, deployment), anthropicPayload(content), {});
  const converse = () => postInference(config, token, group, converseUrl(config, deployment), conversePayload(content), {});
  if (contentHasMedia(content)) {
    const conversed = await converse();
    if (conversed.status === 200) return conversed;
    const invoked = await invoke();
    if (invoked.status === 200) return invoked;
    return documentRejected(conversed) ? invoked : conversed;
  }
  const invoked = await invoke();
  if (invoked.status === 200 || !subpathRejected(invoked)) return invoked;
  return converse();
}

async function completeChat(config, token, group, deployment, content, model) {
  const modelName = typeof model === 'string' ? model : (model && model.modelName) || '';
  const executableId = typeof model === 'object' && model ? model.executableId : '';
  const provider = providerFor({ modelName, executableId });
  if (provider === 'gemini') {
    if (modelRole(modelName) === 'embedding') throw new AiCoreError(modelUse(modelName).reason, 400);
    const url = geminiUrl(config, deployment, modelName);
    const response = await postInference(config, token, group, url, geminiPayload(content), {});
    if (response.status !== 400) return response;
    return postInference(config, token, group, url, geminiPayload(content, { json: false, thinking: false }), {});
  }
  if (provider === 'anthropic') return completeAnthropic(config, token, group, deployment, content);
  const params = {};
  if (config.apiVersion && config.apiVersion.toLowerCase() !== 'none') params['api-version'] = config.apiVersion;
  return postInference(config, token, group, inferenceUrl(config, deployment), chatPayload(modelName, content), params);
}

function failedChat(response) {
  throw new AiCoreError(
    `SAP AI Core did not complete the extraction (${response.status}). ${safeDetail(response.data)}`.trim(),
    response.status >= 400 && response.status < 500 ? response.status : 502,
    safeDetail(response.data)
  );
}

function responseTruncated(payload) {
  const reason = payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason;
  if (reason === 'length') return true;
  const gemini = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].finishReason;
  if (gemini === 'MAX_TOKENS') return true;
  const anthropic = payload && (payload.stop_reason || payload.stopReason);
  return anthropic === 'max_tokens';
}

function matchingBrace(source, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function salvageModelContent(text) {
  const source = String(text || '');
  const itemsAt = source.indexOf('"lineItems"');
  if (itemsAt < 0) return null;
  const arrayStart = source.indexOf('[', itemsAt);
  if (arrayStart < 0) return null;
  const rows = [];
  let index = arrayStart + 1;
  while (index < source.length) {
    const start = source.indexOf('{', index);
    if (start < 0) break;
    const end = matchingBrace(source, start);
    if (end < 0) break;
    try {
      rows.push(JSON.parse(source.slice(start, end + 1)));
    } catch (error) {
      break;
    }
    index = end + 1;
  }
  if (!rows.length) return null;
  let header = {};
  const headerAt = source.indexOf('"header"');
  if (headerAt >= 0 && headerAt < itemsAt) {
    const start = source.indexOf('{', headerAt);
    const end = start >= 0 ? matchingBrace(source, start) : -1;
    if (end > start) {
      try {
        header = JSON.parse(source.slice(start, end + 1));
      } catch (error) {
        header = {};
      }
    }
  }
  return { header, lineItems: rows };
}

function rowHasValue(row) {
  return (row || []).some(cell => cell && cell.value !== '' && cell.value != null);
}

function extractionEmpty(extracted) {
  const headerHit = (extracted && extracted.header || []).some(field => field && field.value !== '' && field.value != null);
  return !headerHit && !(extracted && extracted.lineItems || []).length;
}

function shouldRetryAsText(prepared, scope, extracted) {
  if (!extracted || !prepared || prepared.kind !== 'pdf') return false;
  const text = (scope && scope.fallbackText) || prepared.text || '';
  if (!usableText(text)) return false;
  return extractionEmpty(extracted);
}

function dropEmptyLines(extracted) {
  if (!extracted) return { header: [], lineItems: [] };
  return {
    header: extracted.header || [],
    lineItems: (extracted.lineItems || []).filter(rowHasValue)
  };
}

function mergeExtractions(parts) {
  const lists = (parts || []).filter(Boolean);
  if (!lists.length) return { header: [], lineItems: [] };
  const header = (lists[0].header || []).map(field => ({ ...field }));
  lists.slice(1).forEach(part => {
    (part.header || []).forEach(field => {
      const target = header.find(item => item.name === field.name);
      if (!target) return;
      const empty = target.value === '' || target.value == null;
      if (empty && field.value !== '' && field.value != null) {
        target.value = field.value;
        target.confidence = field.confidence;
      }
    });
  });
  return dropEmptyLines({
    header,
    lineItems: lists.flatMap(part => part.lineItems || [])
  });
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function readModelExtraction(schema, payload) {
  const text = messageText(payload);
  try {
    return dropEmptyLines(mapExtraction(schema, parseModelContent(text)));
  } catch (error) {
    if (!responseTruncated(payload)) throw error;
    const salvaged = salvageModelContent(text);
    if (!salvaged) throw error;
    return dropEmptyLines(mapExtraction(schema, salvaged));
  }
}

async function extractPrepared(context, prepared, scope, responses, depth = 0) {
  const response = await completeChat(
    context.config,
    context.token,
    context.group,
    context.deployment,
    userContent(context.schema, prepared, scope),
    context.model
  );
  responses.push(response);
  const fileRejected = prepared.kind === 'pdf' && [400, 415, 422].includes(response.status);
  if (fileRejected && scope && scope.fallbackText && scope.fallbackText.replace(/\s/g, '').length >= 40) {
    return extractPrepared(context, { kind: 'text', text: scope.fallbackText }, scope, responses, depth);
  }
  if (response.status !== 200) failedChat(response);
  const truncated = responseTruncated(response.data);
  let parsed = null;
  try {
    parsed = readModelExtraction(context.schema, response.data);
  } catch (error) {
    const printed = (scope && scope.fallbackText) || prepared.text || '';
    if (prepared.kind === 'pdf' && usableText(printed) && depth < 4) {
      return extractPrepared(context, { kind: 'text', text: printed }, scope, responses, depth + 1);
    }
    if (!truncated || prepared.kind !== 'text' || depth >= 4) throw error;
  }
  if (shouldRetryAsText(prepared, scope, parsed) && depth < 4) {
    return extractPrepared(context, { kind: 'text', text: (scope && scope.fallbackText) || prepared.text }, scope, responses, depth + 1);
  }
  if (!truncated || prepared.kind !== 'text' || depth >= 4) return parsed;
  const pieces = splitText(prepared.text);
  if (pieces.length < 2) {
    if (parsed) return parsed;
    throw new AiCoreError('SAP AI Core stopped before all line items were returned.', 502);
  }
  const parts = [];
  for (const piece of pieces) {
    parts.push(await extractPrepared(context, { kind: 'text', text: piece }, scope, responses, depth + 1));
  }
  return mergeExtractions(parts);
}

async function extractPdf(context, buffer, responses) {
  const pages = await readPdfPages(buffer);
  const counted = await pdfPageCount(buffer);
  const pageCount = Math.max(counted, pages.length);
  if (!pageCount) {
    const merged = await extractPrepared(context, {
      kind: 'pdf',
      filename: 'invoice.pdf',
      base64: buffer.toString('base64')
    }, { pages: [1], pageCount: 1 }, responses);
    return { merged, pageCount: 1 };
  }
  const covered = textCoversDocument(pages, pageCount);
  const jobs = covered
    ? planPdfJobs(pages, pageCount)
    : Array.from({ length: pageCount }, (_, index) => ({ kind: 'file', pages: [index + 1] }));
  if (!jobs.length) {
    throw new AiCoreError('The PDF has no pages to extract.', 400);
  }
  const parts = await mapPool(jobs, EXTRACT_CONCURRENCY, async job => {
    const scope = { pages: job.pages, pageCount };
    if (job.kind === 'text') {
      return extractPrepared(context, { kind: 'text', text: job.text }, scope, responses);
    }
    const slice = pageCount > 1 ? await slicePdf(buffer, job.pages[0]) : buffer;
    const page = pages.find(item => item.number === job.pages[0]);
    return extractPrepared(context, {
      kind: 'pdf',
      filename: `page-${job.pages[0]}.pdf`,
      base64: slice.toString('base64'),
      text: page && page.text
    }, { ...scope, fallbackText: page && page.text }, responses);
  });
  return { merged: mergeExtractions(parts), pageCount };
}

async function extractDocument({ buffer, filename, schema, resourceGroup, deploymentId, modelName, executableId }) {
  const config = loadConfig();
  const requestedModel = String(modelName || '').trim();
  const missing = missingKeys({
    ...config,
    deploymentId: deploymentId || config.deploymentId || (requestedModel ? 'selected' : '')
  });
  if (missing.length) {
    throw new AiCoreError(`SAP AI Core is not configured. Add ${missing.join(', ')} to default-env.json.`, 400);
  }
  const prepared = await prepareDocument(buffer, filename);
  const token = await getToken(config);
  const group = String(resourceGroup || config.resourceGroup || 'default').trim() || 'default';
  const resolved = await resolveChatDeployment(config, token, group, { modelName: requestedModel, deploymentId, executableId });
  const deployment = resolved.deploymentId;
  const model = resolved.modelName;
  const inferenceGroup = resolved.resourceGroup || group;
  const context = {
    config,
    token,
    group: inferenceGroup,
    deployment,
    model: resolved,
    schema
  };
  const responses = [];
  const outcome = prepared.kind === 'pdf'
    ? await extractPdf(context, buffer, responses)
    : { merged: await extractPrepared(context, prepared, null, responses), pageCount: 0 };
  return {
    ...outcome.merged,
    pages: outcome.pageCount || undefined,
    deploymentId: deployment,
    resourceGroup: inferenceGroup,
    modelName: model,
    usage: combineUsage(responses.map(item => readUsage(item && item.data)), {
      modelName: model,
      deploymentId: deployment,
      resourceGroup: inferenceGroup,
      executableId: resolved.executableId || ''
    })
  };
}

module.exports = {
  AiCoreError,
  loadConfig,
  missingKeys,
  publicStatus,
  getToken,
  extractionPrompt,
  parseModelContent,
  mapExtraction,
  prepareDocument,
  userContent,
  readPdfText,
  extractDocument,
  isChatModel,
  reasoningModel,
  providerFor,
  executableFor,
  modelUse,
  supportedModelNames,
  joinModelCatalog,
  mergeConfiguredModels,
  chooseCatalog,
  includeConfiguredDeployments,
  resolveChatDeployment,
  pickDeployment,
  chatPayload,
  geminiPayload,
  anthropicPayload,
  conversePayload,
  contentHasMedia,
  extractionEmpty,
  shouldRetryAsText,
  anthropicUrl,
  converseUrl,
  inferenceUrl,
  messageText,
  linesFromItems,
  groupPages,
  planPdfJobs,
  textCoversDocument,
  splitText,
  mergeExtractions,
  salvageModelContent,
  readUsage,
  combineUsage,
  listChatModels
};
