'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { parseModelContent, mapExtraction, extractionPrompt, publicStatus, prepareDocument, userContent, readPdfText, isChatModel, supportedModelNames, joinModelCatalog, mergeConfiguredModels, chooseCatalog, includeConfiguredDeployments, resolveChatDeployment, pickDeployment, chatPayload, reasoningModel, providerFor, geminiPayload, messageText, readUsage, combineUsage, linesFromItems, groupPages, planPdfJobs, textCoversDocument, mergeExtractions, salvageModelContent } = require('../srv/ai-core');
const { loadSchemaSync, listLocalSchemas } = require('../srv/document-ai');

const schema = {
  name: 'ZSFL_GST_Invoice',
  headerFields: [
    { name: 'invoiceNumber', label: 'Invoice Number', type: 'string', description: 'Tax invoice number' },
    { name: 'invoiceDate', label: 'Invoice Date', type: 'date', description: '' }
  ],
  lineItemFields: [
    { name: 'description', label: 'Description', type: 'string', description: '' },
    { name: 'quantity', label: 'Quantity', type: 'number', description: '' }
  ]
};

const parsed = parseModelContent('```json\n{"header":{"invoiceNumber":{"value":"INV-1","confidence":0.91},"invoiceDate":"2026-11-02"},"lineItems":[{"description":{"value":"Bearing","confidence":0.8},"quantity":{"value":2,"confidence":0.7}}]}\n```');
const mapped = mapExtraction(schema, parsed);
assert.strictEqual(mapped.header.find(field => field.name === 'invoiceNumber').value, 'INV-1');
assert.strictEqual(mapped.header.find(field => field.name === 'invoiceDate').value, '2026-11-02');
assert.strictEqual(mapped.lineItems[0].find(field => field.name === 'quantity').value, 2);
assert.strictEqual(mapped.lineItems[0].find(field => field.name === 'description').confidence, 0.8);

const prompt = extractionPrompt(loadSchemaSync());
assert.ok(prompt.includes('invoiceNumber'));
assert.ok(prompt.includes('hsnCode'));
assert.ok(prompt.includes('ZSFL_GST_Invoice'));
assert.ok(prompt.includes('every line item'));
assert.ok(extractionPrompt(schema, { pages: [3, 4], pageCount: 32 }).includes('page 3, 4 of 32'));

assert.strictEqual(isChatModel('gpt-4o'), true);
assert.strictEqual(isChatModel('gpt-4o-mini'), true);
assert.strictEqual(isChatModel('gemini-2.5-flash'), true);
assert.strictEqual(isChatModel('text-embedding-3-large'), false);
assert.strictEqual(isChatModel('gpt-4o-realtime'), false);
assert.strictEqual(isChatModel('sap-rpt-1-small'), false);
assert.strictEqual(isChatModel('gemini-2.5-flash-image'), false);
assert.strictEqual(reasoningModel('o4-mini'), true);
assert.strictEqual(reasoningModel('gpt-5.4'), true);
assert.strictEqual(reasoningModel('gpt-4o'), false);

const supported = supportedModelNames({
  parameters: [{
    name: 'modelName',
    description: 'supportedModels: text-embedding-3-large, gpt-4o-mini, gpt-4o, gpt-4o-realtime, gpt-4.1, gpt-4.1-mini, o4-mini'
  }]
});
assert.ok(supported.includes('gpt-4o'));
assert.ok(supported.includes('o4-mini'));
assert.ok(supported.includes('text-embedding-3-large'));
assert.ok(supported.includes('gpt-4o-realtime'));

const catalog = joinModelCatalog({
  configurations: [
    {
      id: 'cfg-mini',
      name: 'mini',
      scenarioId: 'foundation-models',
      executableId: 'azure-openai',
      parameterBindings: [
        { key: 'modelName', value: 'gpt-4o-mini' },
        { key: 'modelVersion', value: 'latest' }
      ]
    },
    {
      id: 'cfg-embed',
      scenarioId: 'foundation-models',
      executableId: 'azure-openai',
      parameterBindings: [{ key: 'modelName', value: 'text-embedding-3-large' }]
    }
  ],
  deployments: [
    { id: 'dep-mini', configurationId: 'cfg-mini', status: 'RUNNING', scenarioId: 'foundation-models' },
    { id: 'dep-stopped', configurationId: 'cfg-mini', status: 'STOPPED', scenarioId: 'foundation-models' },
    { id: 'dep-embed', configurationId: 'cfg-embed', status: 'RUNNING', scenarioId: 'foundation-models' },
    {
      id: 'dep-rpt',
      status: 'RUNNING',
      scenarioId: 'foundation-models',
      executableId: 'sap-rpt',
      details: { resources: { backendDetails: { model: { name: 'sap-rpt-1-small', version: '1' } } } }
    }
  ],
  supportedNames: supported
});
assert.ok(catalog.some(item => item.modelName === 'gpt-4o-mini' && item.deployed && item.usable && item.deploymentId === 'dep-mini'));
assert.ok(!catalog.some(item => item.modelName === 'gpt-4o'));
assert.ok(!catalog.some(item => item.modelName.includes('embedding')));
assert.ok(!catalog.some(item => item.modelName.includes('realtime')));
assert.ok(!catalog.some(item => item.modelName.includes('rpt')));
assert.strictEqual(pickDeployment(catalog, 'gpt-4o-mini', '').deploymentId, 'dep-mini');
assert.strictEqual(pickDeployment(catalog, 'gpt-4o-mini', 'other-deployment'), null);
assert.strictEqual(pickDeployment(catalog, 'gpt-4o', ''), null);

const merged = mergeConfiguredModels([
  { modelName: 'gemini-2.5-flash', deployed: true, usable: true, deploymentId: 'dep-running', executableId: 'gcp-vertexai' },
  { modelName: 'gpt-4o-mini', deployed: true, usable: true, deploymentId: 'dep-mini', executableId: 'azure-openai' }
], {
  geminiDeploymentId: 'dep-stale',
  geminiModel: 'gemini-2.5-flash'
});
assert.strictEqual(merged.find(item => item.modelName === 'gemini-2.5-flash').deploymentId, 'dep-running');
assert.ok(!merged.some(item => item.deploymentId === 'dep-stale'));
assert.ok(merged.some(item => item.deploymentId === 'dep-mini'));
const savedGemini = mergeConfiguredModels([], {
  geminiDeploymentId: 'dep-gemini',
  geminiModel: 'gemini-2.5-flash'
});
assert.strictEqual(savedGemini[0].deploymentId, 'dep-gemini');
const chosen = chooseCatalog('default', [
  { resourceGroup: 'default', deployments: [{ id: 'dep-other', status: 'RUNNING' }] },
  { resourceGroup: 'invoices', deployments: [{ id: 'dep-gemini', status: 'RUNNING' }, { id: 'dep-mini', status: 'RUNNING' }] }
], ['dep-mini', 'dep-gemini']);
assert.strictEqual(chosen.resourceGroup, 'invoices');
const named = includeConfiguredDeployments([], [
  { id: 'dep-gemini', status: 'RUNNING', executableId: 'gcp-vertexai', details: { scaling: { backendDetails: { model: { name: 'gemini-2.5-flash', version: 'latest' } } } } },
  { id: 'dep-mini', status: 'RUNNING', details: { resources: { backendDetails: { model: { name: 'gpt-4o-mini', version: 'latest' } } } } }
], { deploymentId: 'dep-mini', geminiDeploymentId: 'dep-gemini', geminiModel: 'gemini-2.5-flash' });
assert.strictEqual(named.find(item => item.deploymentId === 'dep-gemini').modelName, 'gemini-2.5-flash');
assert.strictEqual(named.find(item => item.deploymentId === 'dep-gemini').executableId, 'gcp-vertexai');
assert.strictEqual(named.find(item => item.deploymentId === 'dep-mini').modelName, 'gpt-4o-mini');
assert.ok(!named.some(item => item.deploymentId === 'dep-stale'));
const resolvedModel = resolveChatDeployment({ deploymentId: 'dep-mini', geminiDeploymentId: 'dep-stale' }, null, 'default', {
  modelName: 'gemini-2.5-flash',
  deploymentId: 'dep-stale',
  executableId: 'gcp-vertexai'
}, [
  { modelName: 'gemini-2.5-flash', deployed: true, usable: true, deploymentId: 'dep-running', executableId: 'gcp-vertexai' }
]);

const geminiCatalog = joinModelCatalog({
  configurations: [{
    id: 'cfg-gemini',
    scenarioId: 'foundation-models',
    executableId: 'gcp-vertexai',
    parameterBindings: [{ key: 'modelName', value: 'gemini-embedding' }, { key: 'modelVersion', value: 'latest' }]
  }],
  deployments: [{
    id: 'da00bb108e5cec61',
    configurationId: 'cfg-gemini',
    status: 'RUNNING',
    scenarioId: 'foundation-models',
    executableId: 'gcp-vertexai',
    details: { resources: { backendDetails: { model: { name: 'gemini-embedding', version: 'latest' } } } }
  }],
  supportedNames: [
    { modelName: 'gemini-2.5-flash', executableId: 'gcp-vertexai' },
    { modelName: 'gemini-embedding', executableId: 'gcp-vertexai' }
  ]
});
assert.ok(!geminiCatalog.some(item => item.modelName === 'gemini-embedding'));
assert.ok(!geminiCatalog.some(item => item.modelName === 'gemini-2.5-flash'));
assert.strictEqual(providerFor({ modelName: 'gemini-2.5-flash', executableId: 'gcp-vertexai' }), 'gemini');
const geminiBody = geminiPayload([
  { type: 'text', text: 'Extract' },
  { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERg==' } }
]);
assert.strictEqual(geminiBody.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
assert.strictEqual(geminiBody.generationConfig.responseMimeType, 'application/json');
const geminiText = messageText({ candidates: [{ content: { parts: [{ text: '{"header":{}}' }] } }] });
assert.ok(geminiText.includes('header'));
const openaiUsage = readUsage({
  model: 'gpt-4o-mini-2024-07-18',
  usage: {
    prompt_tokens: 2500,
    completion_tokens: 1140,
    total_tokens: 3640,
    prompt_tokens_details: { cached_tokens: 120 },
    completion_tokens_details: { reasoning_tokens: 0 }
  }
});
assert.strictEqual(openaiUsage.promptTokens, 2500);
assert.strictEqual(openaiUsage.completionTokens, 1140);
assert.strictEqual(openaiUsage.inputTokens, 2500);
assert.strictEqual(openaiUsage.outputTokens, 1140);
assert.strictEqual(openaiUsage.totalTokens, 3640);
assert.strictEqual(openaiUsage.cachedTokens, 120);
const geminiUsage = readUsage({
  modelVersion: 'gemini-2.5-flash',
  usageMetadata: {
    promptTokenCount: 2100,
    candidatesTokenCount: 980,
    totalTokenCount: 3080,
    thoughtsTokenCount: 0,
    cachedContentTokenCount: 0,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1030 }, { modality: 'IMAGE', tokenCount: 1070 }]
  }
});
assert.strictEqual(geminiUsage.model, 'gemini-2.5-flash');
assert.strictEqual(geminiUsage.promptDetails[1].modality, 'IMAGE');
assert.strictEqual(geminiUsage.promptDetails[1].tokens, 1070);
const combined = combineUsage([openaiUsage, geminiUsage], { modelName: 'gemini-2.5-flash', deploymentId: 'dep-running' });
assert.strictEqual(combined.calls, 2);
assert.strictEqual(combined.totalTokens, 3640 + 3080);
assert.strictEqual(combined.reportedModel, 'gemini-2.5-flash');
assert.strictEqual(combined.deploymentId, 'dep-running');

const miniPayload = chatPayload('gpt-4o-mini', 'extract');
assert.strictEqual(miniPayload.temperature, 0);
assert.strictEqual(miniPayload.max_tokens, 16384);
const reasoningPayload = chatPayload('o4-mini', 'extract');
assert.strictEqual(reasoningPayload.temperature, undefined);
assert.strictEqual(reasoningPayload.max_completion_tokens, 16384);
const lined = linesFromItems([
  { str: 'Bolt', transform: [1, 0, 0, 1, 40, 700] },
  { str: '2', transform: [1, 0, 0, 1, 200, 700] },
  { str: 'Nut', transform: [1, 0, 0, 1, 40, 680] },
  { str: '4', transform: [1, 0, 0, 1, 200, 680] }
]);
assert.strictEqual(lined, 'Bolt 2\nNut 4');
const grouped = groupPages([
  { number: 1, text: 'a'.repeat(80) },
  { number: 2, text: 'b'.repeat(80) },
  { number: 3, text: 'c'.repeat(80) }
], 120);
assert.strictEqual(grouped.length, 3);
const rich = [
  { number: 1, text: 'invoice line '.repeat(20) },
  { number: 2, text: 'invoice line '.repeat(20) }
];
assert.strictEqual(textCoversDocument(rich, 2), true);
const planned = planPdfJobs([
  { number: 1, text: 'invoice line '.repeat(20) },
  { number: 2, text: '' }
], 2);
assert.strictEqual(planned[0].kind, 'text');
assert.deepStrictEqual(planned[0].pages, [1]);
assert.strictEqual(planned[1].kind, 'file');
assert.deepStrictEqual(planned[1].pages, [2]);
const mergedLines = mergeExtractions([
  {
    header: [{ name: 'invoiceNumber', value: '174221', confidence: 0.9 }, { name: 'buyerName', value: '', confidence: null }],
    lineItems: [[{ name: 'description', value: 'Bolt', confidence: 0.8 }]]
  },
  {
    header: [{ name: 'invoiceNumber', value: 'other', confidence: 0.2 }, { name: 'buyerName', value: 'Standard Products', confidence: 0.7 }],
    lineItems: [
      [{ name: 'description', value: '', confidence: null }],
      [{ name: 'description', value: 'Nut', confidence: 0.6 }]
    ]
  }
]);
assert.strictEqual(mergedLines.header[0].value, '174221');
assert.strictEqual(mergedLines.header[1].value, 'Standard Products');
assert.strictEqual(mergedLines.lineItems.length, 2);
assert.strictEqual(mergedLines.lineItems[1][0].value, 'Nut');
const salvaged = salvageModelContent('{"header":{"invoiceNumber":{"value":"174221","confidence":0.9}},"lineItems":[{"description":{"value":"Bolt","confidence":0.8}},{"description":{"value":"Nut"');
assert.strictEqual(salvaged.lineItems.length, 1);
assert.strictEqual(salvaged.lineItems[0].description.value, 'Bolt');

const detailCatalog = joinModelCatalog({
  configurations: [],
  deployments: [{
    id: 'dep-detail',
    configurationId: 'missing',
    status: 'RUNNING',
    scenarioId: 'foundation-models',
    details: { resources: { backendDetails: { model: { name: 'gpt-4.1', version: '2025-04-14' } } } }
  }],
  supportedNames: []
});
assert.strictEqual(detailCatalog[0].modelName, 'gpt-4.1');
assert.strictEqual(detailCatalog[0].modelVersion, '2025-04-14');

const status = publicStatus();
assert.ok(Array.isArray(status.missing));
assert.ok(status.missing.includes('AICORE_DEPLOYMENT_ID'));

const local = listLocalSchemas();
assert.ok(local.some(item => item.name === 'ZSFL_GST_Invoice'));

function textPdf(text) {
  const texts = Array.isArray(text) ? text : [text];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  const fontId = 3 + (texts.length * 2);
  texts.forEach((pageText, index) => {
    const pageId = 3 + (index * 2);
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    const stream = `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });
  objects.splice(1, 0, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${texts.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((entry, index) => {
    offsets[index + 1] = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${entry}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

prepareDocument(textPdf('Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components'), 'invoice.pdf').then(async pdf => {
  const resolved = await resolvedModel;
  assert.strictEqual(resolved.deploymentId, 'dep-running');
  assert.strictEqual(resolved.resourceGroup, 'default');
  assert.strictEqual(pdf.kind, 'pdf');
  const content = userContent(schema, pdf);
  assert.strictEqual(content[1].type, 'file');
  assert.ok(content[1].file.file_data.startsWith('data:application/pdf;base64,'));
  const text = await readPdfText(textPdf('Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components'));
  assert.ok(text.includes('ZSFL 26-27 0148'));
  const manyPages = await readPdfText(textPdf(['Page one bolt quantity 2', 'Page two nut quantity 4', 'Page three washer quantity 8']));
  assert.ok(manyPages.includes('Page one bolt'));
  assert.ok(manyPages.includes('Page three washer'));
  const compressed = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 720 Td (Invoice ZSFL 26-27 0148 taxable amount 30940 supplier Northwind Components) Tj ET\n'));
  const compressedPdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream\n`),
    compressed,
    Buffer.from('\nendstream\nendobj\n')
  ]);
  const compressedText = await readPdfText(compressedPdf);
  assert.ok(compressedText.includes('30940'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = await prepareDocument(png, 'scan.png');
  assert.strictEqual(image.kind, 'image');
  assert.strictEqual(image.mediaType, 'image/png');
  await assert.rejects(() => prepareDocument(Buffer.from('x'), 'scan.tif'), /TIFF/);
  console.log('ai-core tests passed');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
