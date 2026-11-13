'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const multer = require('multer');
const aiCore = require('./ai-core');

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

function documentAiStatus() {
  const config = loadConfig();
  const missing = missingKeys(config);
  return {
    configured: missing.length === 0,
    missing,
    tokenHost: hostOf(config.tokenUrl),
    apiHost: hostOf(config.apiUrl),
    doxClient: config.doxClient || 'default',
    template: config.template || ''
  };
}

function publicStatus() {
  return {
    ...aiCore.publicStatus(),
    schemaFile: path.relative(projectRoot(), activeSchemaPath()),
    documentAi: documentAiStatus()
  };
}

function sourceFrom(value) {
  const source = String(value || 'aicore').toLowerCase();
  if (source === 'document' || source === 'document-ai' || source === 'dox') return 'document';
  if (source === 'both' || source === 'compare') return 'both';
  return 'aicore';
}

function comparable(value) {
  if (value == null) return '';
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text || text === '—' || text === '-') return '';
  const numeric = text.replace(/[₹$€£,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(numeric)) {
    const number = Number(numeric);
    if (Number.isFinite(number)) return `n:${number}`;
  }
  return `s:${text.toLowerCase()}`;
}

function compareState(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (!a && !b) return 'empty';
  return a === b ? 'match' : 'differ';
}

function compareFields(leftFields, rightFields) {
  const left = new Map((leftFields || []).map(field => [field.name, field]));
  const right = new Map((rightFields || []).map(field => [field.name, field]));
  const names = [];
  (leftFields || []).forEach(field => {
    if (field && field.name && !names.includes(field.name)) names.push(field.name);
  });
  (rightFields || []).forEach(field => {
    if (field && field.name && !names.includes(field.name)) names.push(field.name);
  });
  return names.map(name => {
    const documentField = left.get(name) || {};
    const coreField = right.get(name) || {};
    return {
      name,
      label: documentField.label || coreField.label || name,
      documentAi: {
        value: documentField.value == null ? '' : documentField.value,
        confidence: documentField.confidence == null ? null : documentField.confidence
      },
      aiCore: {
        value: coreField.value == null ? '' : coreField.value,
        confidence: coreField.confidence == null ? null : coreField.confidence
      },
      state: compareState(documentField.value, coreField.value)
    };
  });
}

function compareExtractions(documentSide, coreSide) {
  const header = compareFields(documentSide && documentSide.header, coreSide && coreSide.header);
  const leftLines = (documentSide && documentSide.lineItems) || [];
  const rightLines = (coreSide && coreSide.lineItems) || [];
  const count = Math.max(leftLines.length, rightLines.length);
  const lineItems = [];
  for (let index = 0; index < count; index += 1) {
    const fields = compareFields(leftLines[index], rightLines[index]);
    let state = 'empty';
    if (fields.some(field => field.state === 'differ')) state = 'differ';
    else if (fields.some(field => field.state === 'match')) state = 'match';
    lineItems.push({ index: index + 1, state, fields });
  }
  const all = header.concat(...lineItems.map(line => line.fields));
  return {
    header,
    lineItems,
    summary: {
      match: all.filter(field => field.state === 'match').length,
      differ: all.filter(field => field.state === 'differ').length,
      empty: all.filter(field => field.state === 'empty').length,
      headerDiffer: header.filter(field => field.state === 'differ').length,
      headerMatch: header.filter(field => field.state === 'match').length,
      documentLines: leftLines.length,
      coreLines: rightLines.length
    }
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
    type: String(field.type || field.formattingType || field.dataType || 'string').toLowerCase(),
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

function schemaDir() {
  return path.join(projectRoot(), 'schema');
}

function activeSchemaPath() {
  const pointer = path.join(schemaDir(), '.active');
  if (fs.existsSync(pointer)) {
    const selected = path.basename(fs.readFileSync(pointer, 'utf8').trim());
    const full = path.join(schemaDir(), selected);
    if (selected.endsWith('.json') && fs.existsSync(full)) return full;
  }
  return schemaPath();
}

function readSchemaFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DocumentAiError(`${path.basename(file)} is not valid JSON.`, 500);
  }
  return { raw, normalized: normalizeSchema(raw) };
}

function loadSchemaSync() {
  const file = activeSchemaPath();
  if (!fs.existsSync(file)) {
    throw new DocumentAiError(`Schema file not found at ${SCHEMA_FILE}.`, 500);
  }
  return readSchemaFile(file).normalized;
}

function listLocalSchemas() {
  const dir = schemaDir();
  if (!fs.existsSync(dir)) return [];
  const choices = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const { raw, normalized } = readSchemaFile(path.join(dir, name));
      choices.push({
        id: raw.id || name,
        name: normalized.name,
        documentType: normalized.documentType,
        version: normalized.version,
        state: raw.state || 'local',
        file: name
      });
    } catch (error) {
      /* skip a schema file that cannot be read */
    }
  }
  return choices.sort((left, right) => left.name.localeCompare(right.name));
}

function rememberActive(filename) {
  fs.writeFileSync(path.join(schemaDir(), '.active'), `${filename}\n`);
}

function activateLocalSchema(id) {
  const match = listLocalSchemas().find(item => item.id === id || item.file === id || item.name === id);
  if (!match) throw new DocumentAiError('Choose a schema from the list.', 400);
  rememberActive(match.file);
  return loadSchemaSync();
}

function saveSchema(raw) {
  const normalized = normalizeSchema(raw);
  const dir = schemaDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = listLocalSchemas().find(item => item.id === raw.id || item.name === normalized.name);
  const filename = existing
    ? existing.file
    : `${normalized.name.replace(/[^A-Za-z0-9._-]+/g, '_')}_schema.json`;
  fs.writeFileSync(path.join(dir, filename), `${JSON.stringify(raw, null, 2)}\n`);
  rememberActive(filename);
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
      itemNumber: String(index + 1),
      ...row,
      hsnCode: row.hsnSac,
      taxableAmount,
      lineNetAmount: taxableAmount,
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
    taxableAmount: taxableValue,
    cgstAmount,
    sgstAmount,
    igstAmount,
    roundOff: 0,
    invoiceTotal: money(taxableValue + cgstAmount + sgstAmount + igstAmount),
    totalInvoiceValue: money(taxableValue + cgstAmount + sgstAmount + igstAmount),
    irnNumber: 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
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

function schemaRecords(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.schemas)) return data.schemas;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

function customSchemaChoices(pages) {
  const byKey = new Map();
  for (const page of pages || []) {
    for (const schema of schemaRecords(page)) {
      if (!schema || schema.predefined === true) continue;
      const name = schema.name || schema.schemaName || '';
      if (!name) continue;
      const summary = {
        id: schema.id || '',
        name,
        documentType: schema.documentType || 'custom',
        version: String(schema.version || schema.schemaVersion || '1'),
        state: schema.state || schema.status || ''
      };
      const key = summary.id || summary.name;
      if (!byKey.has(key)) byKey.set(key, summary);
    }
  }
  return [...byKey.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function configuredClient(requested) {
  const config = loadConfig();
  const missing = missingKeys(config);
  if (missing.length) {
    throw new DocumentAiError(`Document AI is not configured. Add ${missing.join(', ')} to default-env.json.`, 400);
  }
  const clientId = String(requested || config.doxClient || 'default').trim() || 'default';
  return { config, clientId };
}

async function getSchemaPage(config, token, clientId, offset) {
  let response;
  try {
    response = await axios.get(`${config.apiUrl.replace(/\/+$/, '')}/schemas`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params: { clientId, predefined: false, offset },
      timeout: 20000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new DocumentAiError(`Could not reach Document AI. ${error.message}`, 502);
  }
  if (response.status !== 200) {
    throw new DocumentAiError(
      `Could not list schemas (${response.status}). ${safeDetail(response.data)}`.trim(),
      response.status >= 400 && response.status < 500 ? response.status : 502,
      safeDetail(response.data)
    );
  }
  return response.data;
}

async function listCustomSchemas(requestedClientId) {
  const { config, clientId } = configuredClient(requestedClientId);
  const token = await getToken(config);
  const pages = [];
  const seen = new Set();
  for (let offset = 0; offset < 200; offset += 10) {
    const page = await getSchemaPage(config, token, clientId, offset);
    const batch = schemaRecords(page);
    if (!batch.length) break;
    const fresh = batch.filter(schema => {
      const key = schema.id || schema.name;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) break;
    pages.push({ schemas: fresh });
    if (batch.length < 10) break;
  }
  return customSchemaChoices(pages);
}

async function useRemoteSchema(id, requestedClientId) {
  if (!id) throw new DocumentAiError('Choose a schema.', 400);
  const { config, clientId } = configuredClient(requestedClientId);
  const token = await getToken(config);
  let response;
  try {
    response = await axios.get(`${config.apiUrl.replace(/\/+$/, '')}/schemas/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      params: { clientId },
      timeout: 20000,
      validateStatus: () => true
    });
  } catch (error) {
    throw new DocumentAiError(`Could not reach Document AI. ${error.message}`, 502);
  }
  if (response.status !== 200 || !response.data) {
    throw new DocumentAiError(
      `Could not load that schema (${response.status}). ${safeDetail(response.data)}`.trim(),
      response.status >= 400 && response.status < 500 ? response.status : 502,
      safeDetail(response.data)
    );
  }
  return saveSchema(response.data);
}

function requestFile(file) {
  if (!file) return null;
  return { name: file.originalname || '', size: file.size || 0 };
}

async function probeAiCore() {
  const config = aiCore.loadConfig();
  const missing = aiCore.missingKeys(config);
  if (missing.length) return { ok: false, error: `Add these to default-env.json: ${missing.join(', ')}.` };
  try {
    await aiCore.getToken(config);
    return { ok: true, tokenHost: hostOf(config.tokenUrl) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function probeDocumentAi() {
  const status = documentAiStatus();
  if (!status.configured) return { ok: false, error: `Add these to default-env.json: ${status.missing.join(', ')}.` };
  try {
    await getToken(loadConfig());
    return { ok: true, tokenHost: status.tokenHost };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function settle(work) {
  try {
    return await work();
  } catch (error) {
    return {
      ok: false,
      error: error.message || 'Extraction failed.',
      detail: error.detail || '',
      status: 'FAILED',
      header: [],
      lineItems: []
    };
  }
}

async function extractWithDocumentAi(file, schema, body) {
  const options = buildOptions({
    schema,
    doxClient: body.doxClient || loadConfig().doxClient,
    template: body.template || loadConfig().template,
    schemaName: body.schemaName || schema.name,
    schemaVersion: body.schemaVersion || schema.version,
    documentType: body.documentType || schema.documentType
  });
  const live = await extractLive({
    buffer: file.buffer,
    filename: file.originalname,
    mediaType: file.mimetype,
    options
  });
  const merged = mergeExtraction(schema, live.payload);
  return {
    ok: true,
    status: live.status,
    jobId: live.jobId,
    header: merged.header,
    lineItems: merged.lineItems
  };
}

async function extractWithAiCore(file, schema, body) {
  const live = await aiCore.extractDocument({
    buffer: file.buffer,
    filename: file.originalname,
    schema,
    resourceGroup: body.resourceGroup,
    deploymentId: body.deploymentId,
    modelName: body.modelName,
    executableId: body.executableId
  });
  return {
    ok: true,
    status: 'DONE',
    jobId: null,
    header: live.header,
    lineItems: live.lineItems,
    deploymentId: live.deploymentId,
    resourceGroup: live.resourceGroup,
    modelName: live.modelName || ''
  };
}

function sampleSide(sample) {
  return { ok: true, status: 'DONE', jobId: null, header: sample.header, lineItems: sample.lineItems };
}

function singleResponse(source, file, schema, live) {
  return {
    mode: 'live',
    source,
    jobId: live.jobId || null,
    status: live.status,
    file: requestFile(file),
    schema: schemaSummary(schema),
    header: live.header,
    lineItems: live.lineItems,
    modelName: live.modelName || '',
    deploymentId: live.deploymentId || ''
  };
}

function compareResponse(schema, file, documentSide, coreSide, sample) {
  return {
    mode: 'compare',
    source: 'both',
    sample: Boolean(sample),
    file: requestFile(file),
    schema: schemaSummary(schema),
    documentAi: {
      ok: documentSide.ok !== false,
      error: documentSide.error || '',
      detail: documentSide.detail || '',
      status: documentSide.status || '',
      jobId: documentSide.jobId || null
    },
    aiCore: {
      ok: coreSide.ok !== false,
      error: coreSide.error || '',
      detail: coreSide.detail || '',
      status: coreSide.status || '',
      modelName: coreSide.modelName || ''
    },
    comparison: compareExtractions(documentSide, coreSide)
  };
}

function registerRoutes(app) {
  const pdfjsRoot = path.join(projectRoot(), 'node_modules', 'pdfjs-dist');
  app.use('/vendor/pdfjs/standard_fonts', express.static(path.join(pdfjsRoot, 'standard_fonts')));
  app.use('/vendor/pdfjs/cmaps', express.static(path.join(pdfjsRoot, 'cmaps')));
  app.use('/vendor/pdfjs', express.static(path.join(pdfjsRoot, 'build')));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
  });

  app.get('/api/status', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      if (req.query.probe === '1') {
        const source = sourceFrom(req.query.source);
        if (source === 'both') {
          const [core, document] = await Promise.all([
            probeAiCore(),
            probeDocumentAi()
          ]);
          return res.json({
            ok: core.ok && document.ok,
            ...publicStatus(),
            aiCore: core,
            documentAi: { ...documentAiStatus(), ...document }
          });
        }
        if (source === 'document') {
          const document = await probeDocumentAi();
          if (!document.ok) return res.status(400).json({ ok: false, error: document.error, documentAi: document });
          return res.json({ ok: true, ...publicStatus(), documentAi: { ...documentAiStatus(), ...document } });
        }
        const core = await probeAiCore();
        if (!core.ok) return res.status(400).json({ ok: false, error: core.error });
        return res.json({ ok: true, ...publicStatus(), aiCore: core });
      }
      res.json(publicStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/models', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await aiCore.listChatModels({ resourceGroup: req.query.resourceGroup }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/schemas', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ schemas: listLocalSchemas() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/schemas/:id/use', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(activateLocalSchema(req.params.id));
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
        const schema = loadSchemaSync();
        const mode = String(req.body.mode || 'live').toLowerCase();
        const source = sourceFrom(req.body.source);
        if (mode === 'sample') {
          const sample = buildSampleResult(schema, req.file);
          if (source === 'both') return res.json(compareResponse(schema, req.file, sampleSide(sample), sampleSide(sample), true));
          return res.json({ ...sample, source });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'Choose an invoice file first, or preview the sample.' });
        }
        if (source === 'both') {
          const [documentSide, coreSide] = await Promise.all([
            settle(() => extractWithDocumentAi(req.file, schema, req.body)),
            settle(() => extractWithAiCore(req.file, schema, req.body))
          ]);
          return res.json(compareResponse(schema, req.file, documentSide, coreSide, false));
        }
        if (source === 'document') {
          const live = await extractWithDocumentAi(req.file, schema, req.body);
          return res.json(singleResponse('document', req.file, schema, live));
        }
        const live = await extractWithAiCore(req.file, schema, req.body);
        return res.json(singleResponse('aicore', req.file, schema, live));
      } catch (error) {
        return sendError(res, error);
      }
    });
  });
}

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'The extraction request failed.',
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
  customSchemaChoices,
  listLocalSchemas,
  compareExtractions,
  sourceFrom,
  registerRoutes,
  sampleLines,
  sampleHeader
};
