'use strict';

const fs = require('fs');
const path = require('path');
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
    deploymentId: config.deploymentId || ''
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

function extractionPrompt(schema) {
  return [
    `Extract the document into the schema "${schema.name}".`,
    'Return one JSON object and nothing else.',
    'Use an empty string for value when the document does not contain that field. Do not invent GSTINs, totals, or line items.',
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

async function pdfText(buffer) {
  let pdfjs;
  const log = console.log;
  console.log = () => {};
  try {
    pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (error) {
    throw new AiCoreError('PDF reading is unavailable. Upload a PNG or JPEG of the invoice.', 500);
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
  const last = Math.min(document.numPages, 5);
  for (let number = 1; number <= last; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
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
    let text = '';
    try {
      text = await pdfText(buffer);
    } catch (error) {
      if (error instanceof AiCoreError) throw error;
      throw new AiCoreError(`Could not read the PDF. ${error.message}`, 400);
    }
    if (text.replace(/\s/g, '').length < 40) {
      throw new AiCoreError('This PDF has almost no text. Export the page as PNG or JPEG so a vision model can read it.', 400);
    }
    return { kind: 'text', text: text.slice(0, 60000) };
  }
  throw new AiCoreError('Upload a PDF, PNG, or JPEG invoice.', 400);
}

function userContent(schema, prepared) {
  const prompt = extractionPrompt(schema);
  if (prepared.kind === 'image') {
    return [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: { url: `data:${prepared.mediaType};base64,${prepared.base64}` }
      }
    ];
  }
  return `${prompt}\n\nDOCUMENT TEXT:\n${prepared.text}`;
}

function messageText(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part.text || '')).join('\n');
  }
  return '';
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

function rowObject(row) {
  if (Array.isArray(row)) {
    return Object.fromEntries(row.filter(cell => cell && cell.name).map(cell => [cell.name, cell]));
  }
  return row && typeof row === 'object' ? row : {};
}

function mapExtraction(schema, parsed) {
  const body = parsed && typeof parsed === 'object' ? parsed : {};
  const headerSource = body.header || body.headerFields || {};
  const header = schema.headerFields.map(field => {
    const cell = readCell(headerSource[field.name]);
    return { ...field, value: cell.value, confidence: cell.confidence };
  });
  const rows = body.lineItems || body.lineItemFields || [];
  const lineItems = (Array.isArray(rows) ? rows : []).map(row => {
    const source = rowObject(row);
    return schema.lineItemFields.map(field => {
      const cell = readCell(source[field.name]);
      return { ...field, value: cell.value, confidence: cell.confidence };
    });
  });
  return { header, lineItems };
}

function inferenceUrl(config, deploymentId) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/chat/completions`;
}

async function extractDocument({ buffer, filename, schema, resourceGroup, deploymentId }) {
  const config = loadConfig();
  const missing = missingKeys({
    ...config,
    deploymentId: deploymentId || config.deploymentId
  });
  if (missing.length) {
    throw new AiCoreError(`SAP AI Core is not configured. Add ${missing.join(', ')} to default-env.json.`, 400);
  }
  const prepared = await prepareDocument(buffer, filename);
  const token = await getToken(config);
  const group = String(resourceGroup || config.resourceGroup || 'default').trim() || 'default';
  const deployment = String(deploymentId || config.deploymentId).trim();
  const params = {};
  if (config.apiVersion && config.apiVersion.toLowerCase() !== 'none') params['api-version'] = config.apiVersion;
  let response;
  try {
    response = await axios.post(inferenceUrl(config, deployment), {
      messages: [
        {
          role: 'system',
          content: 'You extract business documents into the requested JSON schema. Reply with JSON only.'
        },
        { role: 'user', content: userContent(schema, prepared) }
      ],
      temperature: 0,
      max_tokens: 4096
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': group,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      params,
      timeout: 120000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new AiCoreError(`Could not reach SAP AI Core. ${error.message}`, 502);
  }
  if (response.status !== 200) {
    throw new AiCoreError(
      `SAP AI Core did not complete the extraction (${response.status}). ${safeDetail(response.data)}`.trim(),
      response.status >= 400 && response.status < 500 ? response.status : 502,
      safeDetail(response.data)
    );
  }
  const parsed = parseModelContent(messageText(response.data));
  const merged = mapExtraction(schema, parsed);
  return {
    ...merged,
    deploymentId: deployment,
    resourceGroup: group
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
  extractDocument
};
