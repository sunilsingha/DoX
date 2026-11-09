'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const multer = require('multer');

const SCHEMA_FILE = 'schema/ZSFL_GST_Invoice_schema.json';
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff']);
const MEDIA_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

class DocumentAiError extends Error {
  constructor(message, status = 502, detail = '') {
    super(message);
    this.name = 'DocumentAiError';
    this.status = status;
    this.detail = detail;
  }
}

function projectRoot() {
  try {
    const cds = require('@sap/cds');
    if (cds.root) return cds.root;
  } catch (error) {
    /* tests can load this module before CAP starts */
  }
  return path.join(__dirname, '..');
}

function schemaPath() {
  return path.join(projectRoot(), SCHEMA_FILE);
}

function readDefaultEnv() {
  const file = path.join(projectRoot(), 'default-env.json');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw new DocumentAiError('default-env.json is not valid JSON.', 500);
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
    return name.includes('document') || name.includes('dox');
  });
  if (!hit) return {};
  const credentials = hit.credentials;
  const uaa = credentials.uaa || {};
  return {
    uaaUrl: uaa.url || '',
    clientId: uaa.clientid || '',
    clientSecret: uaa.clientsecret || '',
    apiUrl: credentials.url || credentials.uri || ''
  };
}

function pick(file, key) {
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  if (file[key] != null && file[key] !== '') return String(file[key]);
  return '';
}

function tokenUrlFrom(uaaUrl) {
  if (!uaaUrl) return '';
  const value = String(uaaUrl).trim().replace(/\/+$/, '');
  return value.endsWith('/oauth/token') ? value : `${value}/oauth/token`;
}

function normalizeApiUrl(url) {
  if (!url) return '';
  const value = String(url).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(value);
    if (parsed.pathname === '/' || parsed.pathname === '') {
      parsed.pathname = '/document-information-extraction/v1';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch (error) {
    return value;
  }
  return value;
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
  const tokenUrl = tokenUrlFrom(pick(file, 'DOX_UAA_URL') || vcap.uaaUrl);
  const apiUrl = normalizeApiUrl(pick(file, 'DOX_URL') || vcap.apiUrl);
  return {
    tokenUrl,
    apiUrl,
    uaaClientId: pick(file, 'DOX_UAA_CLIENTID') || vcap.clientId,
    uaaClientSecret: pick(file, 'DOX_UAA_CLIENTSECRET') || vcap.clientSecret,
    doxClient: pick(file, 'DOX_CLIENT') || 'default',
    schemaName: pick(file, 'DOX_SCHEMA_NAME'),
    schemaVersion: pick(file, 'DOX_SCHEMA_VERSION'),
    documentType: pick(file, 'DOX_DOCUMENT_TYPE'),
    template: pick(file, 'DOX_TEMPLATE')
  };
}

function missingKeys(config) {
  const missing = [];
  if (!config.tokenUrl) missing.push('DOX_UAA_URL');
  if (!config.uaaClientId) missing.push('DOX_UAA_CLIENTID');
  if (!config.uaaClientSecret) missing.push('DOX_UAA_CLIENTSECRET');
  if (!config.apiUrl) missing.push('DOX_URL');
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
    doxClient: config.doxClient || 'default',
    template: config.template || '',
    schemaFile: SCHEMA_FILE
  };
}

function humanize(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, char => char.toUpperCase());
}

function normalizeField(field, index) {
  const name = field.name || field.fieldName || `field${index + 1}`;
  return {
    name,
    label: field.label || field.description || humanize(name),
    description: field.description || '',
    type: String(field.type || field.dataType || 'string').toLowerCase(),
    setupType: field.setupType || '',
    group: field.group || ''
  };
}

function pickVersion(root) {
  const versions = root.versions || root.schemaVersions;
  if (!Array.isArray(versions) || versions.length === 0) return root;
  const active = versions.find(version => String(version.status || '').toLowerCase() === 'active');
  if (active) return active;
  return [...versions].sort((left, right) => {
    return Number(right.version || right.schemaVersion || 0) - Number(left.version || left.schemaVersion || 0);
  })[0];
}

function fieldsByCategory(fields) {
  const headerFields = [];
  const lineItemFields = [];
  for (const field of fields) {
    const category = String(field.category || field.scope || 'header').toLowerCase();
    if (category.includes('line') || category === 'item' || category === 'items') lineItemFields.push(field);
    else headerFields.push(field);
  }
  return { headerFields, lineItemFields };
}

function normalizeSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DocumentAiError('Schema JSON must be an object.', 400);
  }
  const root = raw.schema && typeof raw.schema === 'object' ? raw.schema : raw;
  const versionNode = pickVersion(root);
  let headerFields = versionNode.headerFields || root.headerFields || versionNode.header || root.header || [];
  let lineItemFields = versionNode.lineItemFields || root.lineItemFields || versionNode.lineItems || root.lineItems || versionNode.itemFields || root.itemFields || [];
  if ((!headerFields.length && !lineItemFields.length) && Array.isArray(versionNode.fields || root.fields)) {
    const split = fieldsByCategory(versionNode.fields || root.fields);
    headerFields = split.headerFields;
    lineItemFields = split.lineItemFields;
  }
  const schema = {
    id: root.id || root.schemaId || '',
    name: root.name || root.schemaName || 'ZSFL_GST_Invoice',
    description: root.schemaDescription || root.description || versionNode.description || '',
    documentType: root.documentType || versionNode.documentType || 'custom',
    documentTypeDescription: root.documentTypeDescription || '',
    version: String(versionNode.version || versionNode.schemaVersion || root.version || root.schemaVersion || '1'),
    placeholder: Boolean(root.placeholder),
    placeholderReason: root.placeholderReason || '',
    headerFields: headerFields.map(normalizeField),
    lineItemFields: lineItemFields.map(normalizeField)
  };
  if (!schema.headerFields.length && !schema.lineItemFields.length) {
    throw new DocumentAiError('This schema has no header or line-item fields.', 400);
  }
  return schema;
}

function loadSchemaSync() {
  const file = schemaPath();
  if (!fs.existsSync(file)) {
    throw new DocumentAiError(`Schema file not found at ${SCHEMA_FILE}.`, 500);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DocumentAiError(`${SCHEMA_FILE} is not valid JSON.`, 500);
  }
  return normalizeSchema(raw);
}

function saveSchema(raw) {
  const normalized = normalizeSchema(raw);
  fs.mkdirSync(path.dirname(schemaPath()), { recursive: true });
  fs.writeFileSync(schemaPath(), `${JSON.stringify(raw, null, 2)}\n`);
  return normalized;
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sampleLines() {
  const rows = [
    { description: 'Deep groove ball bearing 6204', hsnSac: '848210', quantity: 10, unitOfMeasure: 'NOS', unitPrice: 1250, cgstRate: 9, sgstRate: 9, igstRate: 0 },
    { description: 'Hydraulic hose assembly', hsnSac: '40092100', quantity: 4, unitOfMeasure: 'NOS', unitPrice: 860, cgstRate: 9, sgstRate: 9, igstRate: 0 },
    { description: 'On-site commissioning', hsnSac: '998739', quantity: 1, unitOfMeasure: 'AU', unitPrice: 15000, cgstRate: 9, sgstRate: 9, igstRate: 0 }
  ];
  return rows.map((row, index) => {
    const taxableAmount = money(row.quantity * row.unitPrice);
    const cgstAmount = money(taxableAmount * row.cgstRate / 100);
    const sgstAmount = money(taxableAmount * row.sgstRate / 100);
    const igstAmount = money(taxableAmount * row.igstRate / 100);
    return {
      serialNumber: String(index + 1),
      ...row,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      lineTotal: money(taxableAmount + cgstAmount + sgstAmount + igstAmount)
    };
  });
}

function sampleHeader(lines) {
  const sum = key => money(lines.reduce((total, line) => total + Number(line[key] || 0), 0));
  const taxableValue = sum('taxableAmount');
  const cgstAmount = sum('cgstAmount');
  const sgstAmount = sum('sgstAmount');
  const igstAmount = sum('igstAmount');
  return {
    supplierName: 'Northwind Components Pvt Ltd',
    supplierGSTIN: '27AABCN1234F1ZV',
    supplierAddress: 'Plot 18, MIDC Industrial Area\nAndheri East, Mumbai 400093',
    supplierState: 'Maharashtra (27)',
    buyerName: 'Contoso Retail India Pvt Ltd',
    buyerGSTIN: '29AADCC5678G1ZX',
    buyerAddress: '42 Residency Road\nBengaluru 560025',
    buyerState: 'Karnataka (29)',
    invoiceNumber: 'ZSFL/26-27/0148',
    invoiceDate: '2026-11-02',
    placeOfSupply: 'Karnataka (29)',
    reverseCharge: 'No',
    irn: 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
    ackNumber: '112010123456789',
    ackDate: '2026-11-02',
    taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    roundOff: 0,
    invoiceTotal: money(taxableValue + cgstAmount + sgstAmount + igstAmount),
    currencyCode: 'INR'
  };
}

function illustrativeConfidence(name) {
  if (name === 'buyerAddress') return 0.78;
  if (name === 'ackNumber') return 0.66;
  const bump = (String(name).length % 8) / 100;
  return Math.round((0.9 + bump) * 100) / 100;
}

function placeholderFor(field, rowIndex) {
  if (field.type === 'date') return '2026-11-02';
  if (field.type === 'number' || field.type === 'currency') {
    return rowIndex == null ? 100 : (rowIndex + 1) * 10;
  }
  if (rowIndex == null) return `Sample ${field.label || field.name}`;
  return `${field.label || field.name} ${rowIndex + 1}`;
}

function presentField(field, value, confidence) {
  return {
    name: field.name,
    label: field.label,
    description: field.description,
    type: field.type,
    group: field.group || '',
    setupType: field.setupType || '',
    value: value == null ? '' : value,
    confidence: confidence == null ? null : confidence
  };
}

function buildSampleResult(schema, file) {
  const lines = sampleLines();
  const headerValues = sampleHeader(lines);
  const header = schema.headerFields.map(field => presentField(
    field,
    Object.prototype.hasOwnProperty.call(headerValues, field.name) ? headerValues[field.name] : placeholderFor(field, null),
    illustrativeConfidence(field.name)
  ));
  const lineItems = lines.map((line, index) => schema.lineItemFields.map(field => presentField(
    field,
    Object.prototype.hasOwnProperty.call(line, field.name) ? line[field.name] : placeholderFor(field, index),
    illustrativeConfidence(`${field.name}-${index}`)
  )));
  return {
    mode: 'sample',
    jobId: null,
    status: 'DONE',
    file: file ? { name: file.originalname || file.name || '', size: file.size || 0 } : null,
    schema: schemaSummary(schema),
    request: { options: null },
    header,
    lineItems
  };
}

function schemaSummary(schema) {
  return {
    name: schema.name,
    version: schema.version,
    documentType: schema.documentType,
    description: schema.description,
    placeholder: schema.placeholder,
    placeholderReason: schema.placeholderReason,
    manualSetup: schema.headerFields.concat(schema.lineItemFields).every(field => !field.setupType || field.setupType === 'manual')
  };
}

function buildOptions({ schema, doxClient, template, schemaName, schemaVersion, documentType }) {
  const options = {
    clientId: doxClient || 'default',
    documentType: documentType || schema.documentType || 'custom',
    schemaName: schemaName || schema.name,
    schemaVersion: String(schemaVersion || schema.version || '1')
  };
  const templateValue = (template || '').trim();
  if (templateValue) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateValue)) {
      options.templateId = templateValue;
    } else {
      options.templateName = templateValue;
    }
  }
  return options;
}

function readPrediction(field) {
  if (!field || typeof field !== 'object') return { value: '', confidence: null };
  if (Array.isArray(field.values) && field.values.length) {
    const best = [...field.values].sort((left, right) => (right.confidence || 0) - (left.confidence || 0))[0];
    return { value: best.value ?? '', confidence: best.confidence ?? null };
  }
  if (field.value && typeof field.value === 'object') {
    return { value: field.value.value ?? '', confidence: field.value.confidence ?? field.confidence ?? null };
  }
  return { value: field.value ?? field.rawValue ?? '', confidence: field.confidence ?? null };
}

function indexPredictions(fields) {
  const map = new Map();
  if (!Array.isArray(fields)) return map;
  for (const field of fields) {
    const name = field.name || field.fieldName;
    if (name) map.set(name, readPrediction(field));
  }
  return map;
}

function lineItemRows(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map(row => {
    if (Array.isArray(row)) return row;
    if (row && Array.isArray(row.fields)) return row.fields;
    if (row && typeof row === 'object') {
      return Object.keys(row).map(name => {
        const cell = row[name];
        if (cell && typeof cell === 'object') return { name, ...cell };
        return { name, value: cell };
      });
    }
    return [];
  });
}

function mergeExtraction(schema, payload) {
  const body = payload && payload.extraction ? payload : (payload && payload.data) || {};
  const extraction = body.extraction || payload.extraction || {};
  const headerPredictions = indexPredictions(extraction.headerFields);
  const header = schema.headerFields.map(field => {
    const prediction = headerPredictions.get(field.name) || { value: '', confidence: null };
    headerPredictions.delete(field.name);
    return presentField(field, prediction.value, prediction.confidence);
  });
  for (const [name, prediction] of headerPredictions) {
    header.push(presentField({ name, label: humanize(name), type: 'string' }, prediction.value, prediction.confidence));
  }

  const rows = lineItemRows(extraction.lineItems);
  const lineItems = rows.map(row => {
    const predictions = indexPredictions(row);
    const cells = schema.lineItemFields.map(field => {
      const prediction = predictions.get(field.name) || { value: '', confidence: null };
      predictions.delete(field.name);
      return presentField(field, prediction.value, prediction.confidence);
    });
    for (const [name, prediction] of predictions) {
      cells.push(presentField({ name, label: humanize(name), type: 'string' }, prediction.value, prediction.confidence));
    }
    return cells;
  });
  return { header, lineItems };
}

function safeDetail(data) {
  if (data == null) return '';
  if (typeof data === 'string') {
    if (data.includes('<html') || data.includes('<!DOCTYPE')) return 'The host returned an HTML page instead of JSON.';
    return data.slice(0, 300);
  }
  if (typeof data === 'object') {
    if (data.error_description) return String(data.error_description);
    if (data.message) return String(data.message);
    if (data.error && data.error.message) return String(data.error.message);
  }
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch (error) {
    return '';
  }
}

function tokenErrorMessage(response) {
  const detail = safeDetail(response.data);
  if (response.status === 404) {
    return 'The authentication URL returned 404. That trial subaccount is often already deleted. Create a service key in the subaccount you use now and update default-env.json.';
  }
  if (response.status === 401 || response.status === 400) {
    return `Document AI rejected the service key (${response.status}). Check uaa.clientid and uaa.clientsecret.`;
  }
  return `Could not get an access token (${response.status}). ${detail}`.trim();
}

async function getToken(config) {
  let response;
  try {
    response = await axios.post(config.tokenUrl, new URLSearchParams({
      client_id: config.uaaClientId,
      client_secret: config.uaaClientSecret,
      grant_type: 'client_credentials'
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new DocumentAiError(`Could not reach the authentication service. ${error.message}`, 502);
  }
  if (response.status !== 200 || !response.data || !response.data.access_token) {
    throw new DocumentAiError(tokenErrorMessage(response), 502, safeDetail(response.data));
  }
  return response.data.access_token;
}

function mediaTypeFor(filename, fallback) {
  const extension = path.extname(filename || '').toLowerCase();
  return MEDIA_TYPES[extension] || fallback || 'application/octet-stream';
}

function assertSupportedFile(filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new DocumentAiError('Upload a PDF, PNG, JPEG, or TIFF invoice.', 400);
  }
}

async function extractLive({ buffer, filename, mediaType, options }) {
  assertSupportedFile(filename);
  const config = loadConfig();
  const missing = missingKeys(config);
  if (missing.length) {
    throw new DocumentAiError(`Document AI is not configured. Add ${missing.join(', ')} to default-env.json.`, 400);
  }
  if (!options.schemaName) {
    throw new DocumentAiError('Schema name is empty. Load your schema export or type the activated schema name.', 400);
  }
  const token = await getToken(config);
  const form = new FormData();
  form.append('file', buffer, {
    filename,
    contentType: mediaType || mediaTypeFor(filename)
  });
  form.append('options', JSON.stringify(options));
  const jobsUrl = `${config.apiUrl.replace(/\/+$/, '')}/document/jobs`;
  let uploadResponse;
  try {
    uploadResponse = await axios.post(jobsUrl, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
  } catch (error) {
    throw new DocumentAiError(`Could not reach Document AI. ${error.message}`, 502);
  }
  if (uploadResponse.status !== 201 && uploadResponse.status !== 200) {
    throw new DocumentAiError(
      `Document AI did not accept the invoice (${uploadResponse.status}). ${safeDetail(uploadResponse.data)}`.trim(),
      uploadResponse.status >= 400 && uploadResponse.status < 500 ? uploadResponse.status : 502,
      safeDetail(uploadResponse.data)
    );
  }
  const jobId = uploadResponse.data && (uploadResponse.data.id || uploadResponse.data.jobId);
  if (!jobId) {
    throw new DocumentAiError('Document AI did not return a job id.', 502, safeDetail(uploadResponse.data));
  }

  const started = Date.now();
  let lastStatus = 'PENDING';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let resultResponse;
    try {
      resultResponse = await axios.get(`${jobsUrl}/${jobId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        params: { extractedValues: true },
        timeout: 20000,
        validateStatus: () => true
      });
    } catch (error) {
      throw new DocumentAiError(`Could not read job ${jobId}. ${error.message}`, 502);
    }
    if (resultResponse.status !== 200) {
      throw new DocumentAiError(
        `Could not read job ${jobId} (${resultResponse.status}).`,
        502,
        safeDetail(resultResponse.data)
      );
    }
    lastStatus = String(resultResponse.data.status || '').toUpperCase();
    if (lastStatus === 'DONE' || lastStatus === 'CONFIRMED') {
      return { payload: resultResponse.data, jobId, status: lastStatus };
    }
    if (lastStatus === 'FAILED') {
      throw new DocumentAiError(`Document AI failed job ${jobId}.`, 502, safeDetail(resultResponse.data));
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new DocumentAiError(
    `Job ${jobId} is still ${lastStatus} after ${Math.round((Date.now() - started) / 1000)} seconds. Open that job in Document AI or try the invoice again.`,
    504
  );
}

function schemaRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  return payload.results || payload.schemas || payload.value || [];
}

function versionOf(schema) {
  const versions = schema.versions || schema.schemaVersions || [];
  if (!versions.length) {
    return {
      version: String(schema.version || schema.schemaVersion || '1'),
      status: String(schema.status || '')
    };
  }
  const active = versions.find(version => String(version.status || '').toLowerCase() === 'active');
  const chosen = active || versions[versions.length - 1];
  return {
    version: String(chosen.version || chosen.schemaVersion || '1'),
    status: String(chosen.status || '')
  };
}

function summarizeSchemaEntry(schema) {
  const version = versionOf(schema);
  const name = schema.name || schema.schemaName || '';
  return {
    id: schema.id || schema.schemaId || '',
    name,
    description: schema.description || schema.schemaDescription || '',
    documentType: schema.documentType || 'custom',
    clientId: schema.clientId || 'default',
    version: version.version,
    status: version.status,
    standard: /^SAP_/i.test(name)
  };
}

function summarizeSchemaList(payload) {
  return schemaRecords(payload).map(summarizeSchemaEntry).filter(item => item.name);
}

async function documentAiGet(config, token, resourcePath, params) {
  let response;
  try {
    response = await axios.get(`${config.apiUrl.replace(/\/+$/, '')}${resourcePath}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params,
      timeout: 20000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new DocumentAiError(`Could not reach Document AI. ${error.message}`, 502);
  }
  if (response.status !== 200) {
    throw new DocumentAiError(
      `Document AI schema request failed (${response.status}). ${safeDetail(response.data)}`.trim(),
      response.status >= 400 && response.status < 500 ? response.status : 502,
      safeDetail(response.data)
    );
  }
  return response.data;
}

function requireConfig() {
  const config = loadConfig();
  const missing = missingKeys(config);
  if (missing.length) {
    throw new DocumentAiError(`Document AI is not configured. Add ${missing.join(', ')} to default-env.json.`, 400);
  }
  return config;
}

async function listRemoteSchemas() {
  const config = requireConfig();
  const token = await getToken(config);
  const seen = new Set();
  const schemas = [];
  const limit = 100;
  for (let page = 0; page < 10; page += 1) {
    const payload = await documentAiGet(config, token, '/schemas', {
      clientId: config.doxClient || 'default',
      limit,
      offset: page * limit
    });
    const batch = summarizeSchemaList(payload);
    let added = 0;
    batch.forEach(item => {
      const key = item.id || `${item.name}@${item.version}`;
      if (seen.has(key)) return;
      seen.add(key);
      schemas.push(item);
      added += 1;
    });
    if (added === 0 || batch.length < limit) break;
  }
  schemas.sort((left, right) => left.name.localeCompare(right.name));
  return schemas;
}

async function getRemoteSchema(schemaId) {
  if (!schemaId || !/^[A-Za-z0-9-]{8,}$/.test(schemaId)) {
    throw new DocumentAiError('Choose a schema from the list.', 400);
  }
  const config = requireConfig();
  const token = await getToken(config);
  const payload = await documentAiGet(config, token, `/schemas/${schemaId}`, {
    clientId: config.doxClient || 'default'
  });
  return normalizeSchema(payload);
}

function schemaFromRequest(body) {
  if (!body || !body.schemaJson) return loadSchemaSync();
  let parsed;
  try {
    parsed = JSON.parse(body.schemaJson);
  } catch (error) {
    throw new DocumentAiError('The selected schema could not be read.', 400);
  }
  return normalizeSchema(parsed);
}

function requestFile(file) {
  if (!file) return null;
  return { name: file.originalname || '', size: file.size || 0 };
}

function registerRoutes(app) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
  });

  app.get('/api/status', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (req.query.probe === '1') {
        const config = loadConfig();
        const missing = missingKeys(config);
        if (missing.length) {
          return res.status(400).json({
            ok: false,
            error: `Add these to default-env.json: ${missing.join(', ')}.`
          });
        }
        await getToken(config);
        return res.json({ ok: true, ...publicStatus() });
      }
      res.json(publicStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/schemas', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const schemas = await listRemoteSchemas();
      res.json({ schemas });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/schemas/:schemaId', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await getRemoteSchema(req.params.schemaId));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/schema', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(loadSchemaSync());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/schema', express.json({ limit: '1mb' }), (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(saveSchema(req.body));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.use('/api', (error, req, res, next) => {
    if (error && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      return res.status(400).json({ error: 'The request body is not valid JSON, or it is larger than 1 MB.' });
    }
    return next(error);
  });

  app.post('/api/extract', (req, res) => {
    upload.single('file')(req, res, async (uploadError) => {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'Invoice files must be 20 MB or smaller.'
          : uploadError.message;
        return res.status(400).json({ error: message });
      }
      try {
        res.set('Cache-Control', 'no-store');
        const schema = schemaFromRequest(req.body);
        const mode = String(req.body.mode || 'live').toLowerCase();
        const options = buildOptions({
          schema,
          doxClient: req.body.doxClient || loadConfig().doxClient,
          template: req.body.template || loadConfig().template,
          schemaName: req.body.schemaName || loadConfig().schemaName || schema.name,
          schemaVersion: req.body.schemaVersion || loadConfig().schemaVersion || schema.version,
          documentType: req.body.documentType || loadConfig().documentType || schema.documentType
        });
        if (mode === 'sample') {
          return res.json(buildSampleResult(schema, req.file));
        }
        if (!req.file) {
          return res.status(400).json({ error: 'Choose an invoice file first, or preview the sample.' });
        }
        const live = await extractLive({
          buffer: req.file.buffer,
          filename: req.file.originalname,
          mediaType: req.file.mimetype,
          options
        });
        const merged = mergeExtraction(schema, live.payload);
        return res.json({
          mode: 'live',
          jobId: live.jobId,
          status: live.status,
          file: requestFile(req.file),
          schema: schemaSummary(schema),
          request: { options },
          header: merged.header,
          lineItems: merged.lineItems
        });
      } catch (error) {
        return sendError(res, error);
      }
    });
  });
}

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'Document AI request failed.',
    detail: error.detail || ''
  });
}

module.exports = {
  DocumentAiError,
  normalizeSchema,
  loadSchemaSync,
  buildSampleResult,
  buildOptions,
  mergeExtraction,
  publicStatus,
  summarizeSchemaList,
  registerRoutes,
  sampleLines,
  sampleHeader
};
