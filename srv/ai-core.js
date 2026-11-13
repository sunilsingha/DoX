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

async function pdfjsText(buffer) {
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
  const last = Math.min(document.numPages, 5);
  for (let number = 1; number <= last; number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
}

async function readPdfText(buffer) {
  try {
    const text = await pdfjsText(buffer);
    if (text.replace(/\s/g, '').length >= 40) return text;
  } catch (error) {
    /* the model can still receive the PDF, and the plain reader is the backup */
  }
  return pdfStreamText(buffer);
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
  if (prepared.kind === 'pdf') {
    return [
      { type: 'text', text: prompt },
      {
        type: 'file',
        file: {
          filename: prepared.filename || 'invoice.pdf',
          file_data: `data:application/pdf;base64,${prepared.base64}`
        }
      }
    ];
  }
  return `${prompt}\n\nDOCUMENT TEXT:\n${prepared.text}`;
}

function messageText(payload) {
  const geminiParts = payload && payload.candidates && payload.candidates[0] && payload.candidates[0].content && payload.candidates[0].content.parts;
  if (Array.isArray(geminiParts)) return geminiParts.map(part => (part && part.text) || '').join('\n');
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
  const resources = details.resources || details;
  const backend = resources.backendDetails || resources.backend_details || {};
  const model = backend.model || {};
  return {
    modelName: String(model.name || '').trim(),
    modelVersion: String(model.version || '').trim()
  };
}

function modelRole(name) {
  const model = String(name || '').trim().toLowerCase();
  if (!model) return 'unknown';
  if (model.includes('embed')) return 'embedding';
  if (model.includes('realtime') || model.includes('whisper') || model.includes('tts') || model.includes('dall') || model.includes('transcrib') || model.includes('imagen')) return 'other';
  return 'chat';
}

function isChatModel(name) {
  return modelRole(name) === 'chat';
}

function providerFor(model) {
  const executable = String((model && model.executableId) || '').toLowerCase();
  const name = String((model && model.modelName) || model || '').toLowerCase();
  if (executable === 'gcp-vertexai' || name.startsWith('gemini')) return 'gemini';
  return 'openai';
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
      executableId: configuration.executableId || deployment.executableId || (providerFor(modelName) === 'gemini' ? 'gcp-vertexai' : 'azure-openai'),
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
    existing.modelName = gemini.modelName || existing.modelName;
    existing.executableId = existing.executableId || 'gcp-vertexai';
    existing.deployed = true;
    existing.usable = gemini.usable;
    existing.reason = gemini.reason;
    return list;
  }
  const suggestion = list.findIndex(item => !item.deployed && item.modelName.toLowerCase() === gemini.modelName.toLowerCase());
  if (suggestion >= 0) list.splice(suggestion, 1);
  return [gemini, ...list];
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
  const generationConfig = { temperature: 0, maxOutputTokens: 8192 };
  if (options.json !== false) generationConfig.responseMimeType = 'application/json';
  if (options.thinking !== false) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return {
    systemInstruction: {
      parts: [{ text: 'You extract business documents into the requested JSON schema. Reply with JSON only.' }]
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
        content: 'You extract business documents into the requested JSON schema. Reply with JSON only.'
      },
      { role: 'user', content }
    ]
  };
  if (reasoningModel(modelName)) payload.max_completion_tokens = 4096;
  else {
    payload.temperature = 0;
    payload.max_tokens = 4096;
  }
  return payload;
}

function inferenceUrl(config, deploymentId) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/chat/completions`;
}

function geminiUrl(config, deploymentId, modelName) {
  return `${config.apiUrl}/v2/inference/deployments/${encodeURIComponent(deploymentId)}/models/${encodeURIComponent(modelName)}:generateContent`;
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

async function loadCatalog(config, token, group) {
  const [configurations, deployments] = await Promise.all([
    listResources(config, token, group, '/v2/lm/configurations', { scenarioId: 'foundation-models' }),
    listResources(config, token, group, '/v2/lm/deployments', { scenarioId: 'foundation-models', status: 'RUNNING' })
  ]);
  const hydrated = await hydrateConfigurations(config, token, group, deployments, configurations);
  return joinModelCatalog({ configurations: hydrated, deployments });
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
    return {
      resourceGroup: group,
      models: mergeConfiguredModels(await loadCatalog(config, token, group), config),
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
  return providerFor(requested) === 'gemini' ? 'gcp-vertexai' : 'azure-openai';
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

async function resolveChatDeployment(config, token, group, { modelName, deploymentId, executableId }) {
  const requested = String(modelName || '').trim();
  const explicit = String(deploymentId || config.deploymentId || '').trim();
  const executable = String(executableId || '').trim();
  if (!requested && !explicit) {
    throw new AiCoreError('Add AICORE_DEPLOYMENT_ID to default-env.json, or choose a deployed model.', 400);
  }
  if (!requested && explicit && explicit === String(config.geminiDeploymentId || '').trim()) {
    const gemini = configuredGemini(config);
    if (gemini && gemini.usable === false) throw new AiCoreError(gemini.reason, 400);
    if (gemini) return gemini;
  }
  let models = [];
  try {
    models = mergeConfiguredModels(await loadCatalog(config, token, group), config);
  } catch (error) {
    if (requested && explicit) return directDeployment(requested, explicit, executable);
    if (requested) throw error;
    return directDeployment('', explicit, executable);
  }
  if (!requested) {
    const found = models.find(item => item.deployed && item.deploymentId === explicit);
    if (found && found.usable === false) throw new AiCoreError(found.reason, 400);
    return found || directDeployment('', explicit, executable);
  }
  const match = pickDeployment(models, requested, explicit);
  if (match && match.usable === false) throw new AiCoreError(match.reason, 400);
  if (!match && explicit) return directDeployment(requested, explicit, executable);
  if (!match) {
    throw new AiCoreError(
      `${requested} has no RUNNING deployment in resource group ${group}. Create a ${deploymentExecutable(requested)} configuration with modelName ${requested} and modelVersion latest, deploy it, and wait until the status is RUNNING.`,
      400
    );
  }
  return match;
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

async function completeChat(config, token, group, deployment, content, model) {
  const modelName = typeof model === 'string' ? model : (model && model.modelName) || '';
  const executableId = typeof model === 'object' && model ? model.executableId : '';
  if (providerFor({ modelName, executableId }) === 'gemini') {
    if (modelRole(modelName) === 'embedding') throw new AiCoreError(modelUse(modelName).reason, 400);
    const url = geminiUrl(config, deployment, modelName);
    const response = await postInference(config, token, group, url, geminiPayload(content), {});
    if (response.status !== 400) return response;
    return postInference(config, token, group, url, geminiPayload(content, { json: false, thinking: false }), {});
  }
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
  let response = await completeChat(config, token, group, deployment, userContent(schema, prepared), resolved);
  if (prepared.kind === 'pdf' && [400, 415, 422].includes(response.status)) {
    const text = await readPdfText(buffer);
    if (text.replace(/\s/g, '').length >= 40) {
      response = await completeChat(config, token, group, deployment, userContent(schema, {
        kind: 'text',
        text: text.slice(0, 60000)
      }), resolved);
    }
  }
  if (response.status !== 200) failedChat(response);
  const parsed = parseModelContent(messageText(response.data));
  const merged = mapExtraction(schema, parsed);
  return {
    ...merged,
    deploymentId: deployment,
    resourceGroup: group,
    modelName: model
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
  modelUse,
  supportedModelNames,
  joinModelCatalog,
  mergeConfiguredModels,
  pickDeployment,
  chatPayload,
  geminiPayload,
  messageText,
  listChatModels
};
