(function () {
  const state = {
    schema: null,
    header: [],
    lineItems: [],
    currency: 'INR',
    busy: false,
    configuredDeploymentId: '',
    geminiDeploymentId: '',
    geminiModel: 'gemini-2.5-flash',
    models: []
  };

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file');
  let previewUrl = '';
  let previewGeneration = 0;
  let previewLoadingTask = null;
  const schemaInput = document.getElementById('schema-file');
  const message = document.getElementById('message');
  const guide = document.getElementById('guide');

  document.getElementById('open-guide').addEventListener('click', () => guide.showModal());
  document.getElementById('close-guide').addEventListener('click', () => guide.close());
  document.getElementById('schema-name').addEventListener('change', () => useSelectedSchema());
  document.querySelectorAll('input[name="source"]').forEach(input => {
    input.addEventListener('change', syncSourceFields);
  });
  syncSourceFields();
  document.getElementById('model-name').addEventListener('change', applyModelChoice);
  document.getElementById('resource-group').addEventListener('change', () => loadModels());
  document.getElementById('gemini-deployment-id').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('gemini-model').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('deployment-id').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('extract').addEventListener('click', () => extract('live'));
  document.getElementById('sample').addEventListener('click', () => extract('sample'));
  document.getElementById('probe').addEventListener('click', probe);
  document.getElementById('load-schema').addEventListener('click', () => schemaInput.click());
  document.getElementById('header-filter').addEventListener('input', () => renderHeader());
  schemaInput.addEventListener('change', () => {
    const file = schemaInput.files && schemaInput.files[0];
    if (file) uploadSchema(file);
  });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => showSelectedFile(fileInput.files && fileInput.files[0]));
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
  }));
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    showSelectedFile(file);
  });

  load();

  async function load() {
    try {
      const [schema, status] = await Promise.all([
        fetch('/api/schema').then(readJson),
        fetch('/api/status').then(readJson)
      ]);
      applySchema(schema);
      renderConnection(status);
      await Promise.all([loadSchemaChoices(), loadModels()]);
    } catch (error) {
      showMessage('negative', error.message);
    }
  }

  function applySchema(schema) {
    state.schema = schema;
    state.header = schema.headerFields.map(emptyField);
    state.lineItems = [];
    state.currency = 'INR';
    document.getElementById('shell-schema').textContent = `${schema.name} · v${schema.version}`;
    document.getElementById('schema-name').value = schema.name;
    document.getElementById('schema-version').value = schema.version;
    setDocumentType(schema.documentType);
    const note = document.getElementById('schema-note');
    if (schema.placeholder) {
      note.hidden = false;
      note.textContent = schema.placeholderReason;
    } else {
      note.hidden = true;
      note.textContent = '';
    }
    renderFacets();
    renderHeader();
    renderLines();
  }

  async function loadSchemaChoices() {
    try {
      const response = await fetch('/api/schemas');
      const body = await readJson(response);
      fillSchemaSelect(body.schemas || [], state.schema && state.schema.name);
    } catch (error) {
      fillSchemaSelect([], state.schema && state.schema.name);
      showMessage('negative', error.message);
    }
  }

  function fillSchemaSelect(schemas, selectedName) {
    const select = document.getElementById('schema-name');
    const current = selectedName || '';
    const items = schemas.slice();
    if (current && !items.some(schema => schema.name === current)) {
      items.unshift({
        id: '',
        name: current,
        documentType: document.getElementById('document-type').value || 'custom',
        version: document.getElementById('schema-version').value || ''
      });
    }
    select.innerHTML = '';
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No custom schemas';
      select.appendChild(option);
      return;
    }
    for (const schema of items) {
      const option = document.createElement('option');
      option.value = schema.name;
      option.textContent = `${schema.name} · ${schema.documentType || 'custom'}`;
      option.dataset.id = schema.id || '';
      option.dataset.version = schema.version || '';
      option.dataset.documentType = schema.documentType || 'custom';
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  async function useSelectedSchema() {
    const select = document.getElementById('schema-name');
    const option = select.selectedOptions && select.selectedOptions[0];
    if (!option || !option.value || !option.dataset.id) return;
    document.getElementById('schema-version').value = option.dataset.version || '';
    setDocumentType(option.dataset.documentType || 'custom');
    if (state.schema && state.schema.name === option.value) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/schemas/${encodeURIComponent(option.dataset.id)}/use`, { method: 'POST' });
      const schema = await readJson(response);
      applySchema(schema);
      showMessage('positive', `Loaded ${schema.name}, version ${schema.version}.`);
    } catch (error) {
      showMessage('negative', error.message);
    } finally {
      setBusy(false);
    }
  }

  function setDocumentType(value) {
    const select = document.getElementById('document-type');
    const match = [...select.options].some(option => option.value === value);
    if (!match && value) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = value || 'custom';
  }

  function selectedSource() {
    const picked = document.querySelector('input[name="source"]:checked');
    return picked ? picked.value : 'aicore';
  }

  function syncSourceFields() {
    const source = selectedSource();
    document.querySelectorAll('.for-aicore').forEach(node => { node.hidden = source === 'document'; });
    document.querySelectorAll('.for-document').forEach(node => { node.hidden = source === 'aicore'; });
    const hint = document.getElementById('source-hint');
    const extract = document.getElementById('extract');
    if (source === 'document') {
      hint.innerHTML = 'Document AI extracts with the schema name and version. The client is usually <code>default</code>. A template is required when the schema fields use manual setup.';
      extract.textContent = 'Extract invoice';
    } else if (source === 'both') {
      hint.innerHTML = 'Both services read this file. The comparison marks each field that does not agree. The Model menu chooses which running AI Core deployment to compare with Document AI.';
      extract.textContent = 'Extract with both';
    } else {
      hint.innerHTML = 'GPT and Gemini each have their own deployment ID. Choose the model above. The two IDs are filled from <code>default-env.json</code>.';
      extract.textContent = 'Extract invoice';
    }
  }

  function paintPill(node, configured, label, host) {
    node.classList.remove('ready', 'warn', 'bad');
    if (configured) {
      node.classList.add('ready');
      node.textContent = host ? `${label} · ${host}` : `${label} ready`;
    } else {
      node.classList.add('warn');
      node.textContent = `${label} not configured`;
    }
  }

  function selectedModel() {
    const select = document.getElementById('model-name');
    const option = select.selectedOptions && select.selectedOptions[0];
    if (!option || option.value === 'gpt') {
      return { modelName: '', deploymentId: document.getElementById('deployment-id').value.trim(), executableId: 'azure-openai' };
    }
    return {
      modelName: option.dataset.modelName || '',
      deploymentId: option.dataset.deploymentId || '',
      executableId: option.dataset.executableId || ''
    };
  }

  function localGemini() {
    const deploymentId = document.getElementById('gemini-deployment-id').value.trim();
    const modelName = document.getElementById('gemini-model').value.trim() || 'gemini-2.5-flash';
    if (!deploymentId || modelName.toLowerCase().includes('embed')) return null;
    return {
      modelName,
      modelVersion: 'latest',
      deploymentId,
      executableId: 'gcp-vertexai',
      deployed: true,
      usable: true,
      reason: ''
    };
  }

  function modelsForMenu(models) {
    const list = (models || []).map(item => ({ ...item }));
    const gemini = localGemini();
    if (gemini) {
      const existing = list.find(item => item.deploymentId === gemini.deploymentId);
      if (existing) {
        existing.modelName = gemini.modelName;
        existing.executableId = 'gcp-vertexai';
        existing.deployed = true;
        existing.usable = true;
        existing.reason = '';
      } else {
        list.unshift(gemini);
      }
    }
    return list.filter(item => item.deployed && item.usable !== false);
  }

  function applyModelChoice() {
    const choice = selectedModel();
    if (choice.executableId === 'azure-openai' && !choice.modelName && state.configuredDeploymentId && !document.getElementById('deployment-id').value.trim()) {
      document.getElementById('deployment-id').value = state.configuredDeploymentId;
    }
  }

  function fillModelSelect(models, previous) {
    const select = document.getElementById('model-name');
    const current = previous != null ? previous : select.value;
    const menu = modelsForMenu(models);
    select.replaceChildren();
    const gptId = document.getElementById('deployment-id').value.trim();
    if (gptId) {
      const fallback = document.createElement('option');
      fallback.value = 'gpt';
      fallback.textContent = `GPT · ${gptId}`;
      select.appendChild(fallback);
    }
    menu.forEach(model => {
      const option = document.createElement('option');
      option.value = model.deploymentId;
      option.dataset.modelName = model.modelName;
      option.dataset.deploymentId = model.deploymentId || '';
      option.dataset.executableId = model.executableId || '';
      const copies = menu.filter(item => item.modelName === model.modelName).length;
      const version = model.modelVersion && model.modelVersion !== 'latest' ? ` · ${model.modelVersion}` : '';
      const suffix = copies > 1 && model.deploymentId ? ` · ${model.deploymentId.slice(0, 8)}` : '';
      option.textContent = `${model.modelName}${version}${suffix}`;
      select.appendChild(option);
    });
    if ([...select.options].some(option => option.value === current && !option.disabled)) select.value = current;
    applyModelChoice();
  }

  async function loadModels() {
    const note = document.getElementById('model-note');
    const select = document.getElementById('model-name');
    const previous = select.value;
    const group = document.getElementById('resource-group').value.trim();
    try {
      const response = await fetch(`/api/models?resourceGroup=${encodeURIComponent(group)}`);
      const body = await readJson(response);
      state.models = body.models || [];
      fillModelSelect(state.models, previous === '' ? 'gpt' : previous);
      const shown = modelsForMenu(state.models);
      if (shown.length || document.getElementById('deployment-id').value.trim()) {
        note.textContent = 'The menu lists running chat deployments only. GPT and Gemini each use their own deployment ID.';
      } else if (body.error) note.textContent = body.error;
      else note.textContent = 'No chat model is deployed yet. Add a GPT or Gemini deployment ID under Request options.';
    } catch (error) {
      fillModelSelect([], '');
      note.textContent = error.message;
    }
  }

  function renderConnection(status) {
    document.getElementById('resource-group').value = status.resourceGroup || 'default';
    if (status.deploymentId) state.configuredDeploymentId = status.deploymentId;
    if (status.geminiDeploymentId) state.geminiDeploymentId = status.geminiDeploymentId;
    if (status.geminiModel) state.geminiModel = status.geminiModel;
    if (!document.getElementById('deployment-id').value) {
      document.getElementById('deployment-id').value = state.configuredDeploymentId;
    }
    if (!document.getElementById('gemini-deployment-id').value) {
      document.getElementById('gemini-deployment-id').value = state.geminiDeploymentId;
    }
    if (!document.getElementById('gemini-model').value) {
      document.getElementById('gemini-model').value = state.geminiModel || 'gemini-2.5-flash';
    }
    const documentStatus = status.documentAi || {};
    if (!document.getElementById('dox-client').value) {
      document.getElementById('dox-client').value = documentStatus.doxClient || 'default';
    }
    if (!document.getElementById('template').value) {
      document.getElementById('template').value = documentStatus.template || '';
    }
    const coreProbe = status.aiCore;
    paintPill(
      document.getElementById('connection'),
      coreProbe ? coreProbe.ok : status.configured,
      'AI Core',
      (coreProbe && coreProbe.tokenHost) || status.apiHost
    );
    const documentProbe = status.documentAi;
    paintPill(
      document.getElementById('connection-document'),
      documentProbe ? documentProbe.configured !== false && documentProbe.ok !== false : false,
      'Document AI',
      documentProbe && documentProbe.apiHost
    );
    if (coreProbe && coreProbe.ok === false) {
      document.getElementById('connection').classList.remove('ready', 'warn');
      document.getElementById('connection').classList.add('bad');
      document.getElementById('connection').textContent = 'AI Core failed';
    }
    if (documentProbe && documentProbe.ok === false) {
      document.getElementById('connection-document').classList.remove('ready', 'warn');
      document.getElementById('connection-document').classList.add('bad');
      document.getElementById('connection-document').textContent = 'Document AI failed';
    }
  }

  function showSelectedFile(file) {
    const meta = document.getElementById('file-meta');
    if (!file) {
      meta.textContent = 'No file selected.';
      setPreview(null);
      return;
    }
    const label = `${file.name} · ${formatBytes(file.size)}`;
    meta.textContent = label;
    document.getElementById('preview-meta').textContent = label;
    setPreview(file);
  }

  function clearPdfPreview() {
    previewGeneration += 1;
    if (previewLoadingTask) {
      previewLoadingTask.destroy();
      previewLoadingTask = null;
    }
    const pages = document.getElementById('preview-pages');
    pages.hidden = true;
    pages.replaceChildren();
  }

  function setPreview(file) {
    const empty = document.getElementById('preview-empty');
    const image = document.getElementById('preview-image');
    const unsupported = document.getElementById('preview-unsupported');
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }
    clearPdfPreview();
    image.hidden = true;
    image.removeAttribute('src');
    unsupported.hidden = true;
    if (!file) {
      empty.hidden = false;
      document.getElementById('preview-meta').textContent = 'No file selected.';
      return;
    }
    const type = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    const isPdf = type === 'application/pdf' || name.endsWith('.pdf');
    const isTiff = type === 'image/tiff' || name.endsWith('.tif') || name.endsWith('.tiff');
    const isImage = !isTiff && (type.startsWith('image/') || /\.(png|jpe?g)$/.test(name));
    empty.hidden = true;
    if (isTiff || (!isPdf && !isImage)) {
      unsupported.hidden = false;
      unsupported.textContent = isTiff
        ? 'TIFF is not shown here, and SAP AI Core vision models do not accept it. Export the page as PNG or JPEG.'
        : 'This file cannot be previewed here. Upload a PDF, PNG, or JPEG.';
      return;
    }
    if (isPdf) {
      showPdf(file);
      return;
    }
    previewUrl = URL.createObjectURL(file);
    image.alt = file.name || 'Uploaded invoice';
    image.onerror = () => {
      image.hidden = true;
      unsupported.hidden = false;
      unsupported.textContent = 'This image could not be previewed. Upload a PNG or JPEG.';
    };
    image.src = previewUrl;
    image.hidden = false;
  }

  async function showPdf(file) {
    const generation = previewGeneration;
    const pages = document.getElementById('preview-pages');
    const unsupported = document.getElementById('preview-unsupported');
    pages.hidden = false;
    pages.replaceChildren();
    const note = document.createElement('p');
    note.className = 'preview-status';
    note.textContent = 'Opening the invoice…';
    pages.appendChild(note);
    if (!window.pdfjsLib) {
      pages.hidden = true;
      unsupported.hidden = false;
      unsupported.textContent = 'The invoice viewer did not load. Refresh the page and open the PDF again.';
      return;
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    let data;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (generation !== previewGeneration) return;
      pages.hidden = true;
      unsupported.hidden = false;
      unsupported.textContent = 'This PDF could not be opened in the preview.';
      return;
    }
    if (generation !== previewGeneration) return;
    const task = window.pdfjsLib.getDocument({
      data,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'
    });
    previewLoadingTask = task;
    let documentPdf;
    try {
      documentPdf = await task.promise;
    } catch (error) {
      if (generation !== previewGeneration) return;
      pages.hidden = true;
      unsupported.hidden = false;
      unsupported.textContent = 'This PDF could not be opened in the preview.';
      return;
    }
    if (generation !== previewGeneration) return;
    pages.replaceChildren();
    const count = Math.min(documentPdf.numPages, 8);
    const width = Math.max(pages.clientWidth - 24, 280);
    for (let number = 1; number <= count; number += 1) {
      if (generation !== previewGeneration) return;
      const page = await documentPdf.getPage(number);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / unscaled.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('aria-label', `Invoice page ${number}`);
      pages.appendChild(canvas);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
    }
  }

  async function extract(mode) {
    if (state.busy) return;
    const file = fileInput.files && fileInput.files[0];
    if (mode === 'live' && !file) {
      showMessage('critical', 'Choose an invoice file first, or preview the sample.');
      return;
    }
    const source = selectedSource();
    const form = new FormData();
    form.set('mode', mode);
    form.set('source', source);
    form.set('schemaName', document.getElementById('schema-name').value.trim());
    form.set('schemaVersion', document.getElementById('schema-version').value.trim());
    form.set('documentType', document.getElementById('document-type').value);
    const choice = selectedModel();
    form.set('resourceGroup', document.getElementById('resource-group').value.trim());
    form.set('modelName', choice.modelName);
    form.set('executableId', choice.executableId);
    form.set('deploymentId', choice.deploymentId || document.getElementById('deployment-id').value.trim());
    form.set('doxClient', document.getElementById('dox-client').value.trim());
    form.set('template', document.getElementById('template').value.trim());
    if (file) form.set('file', file);
    setBusy(true);
    const waiting = source === 'both'
      ? 'Uploading the invoice to Document AI and SAP AI Core.'
      : source === 'document'
        ? 'Uploading the invoice and waiting for Document AI.'
        : 'Uploading the invoice and waiting for SAP AI Core.';
    showMessage('information', mode === 'sample'
      ? 'Filling the tables with a sample GST invoice.'
      : waiting);
    try {
      const response = await fetch('/api/extract', { method: 'POST', body: form });
      const body = await readJson(response);
      showResult(body);
    } catch (error) {
      showMessage('negative', error.message);
    } finally {
      setBusy(false);
    }
  }

  function showResult(result) {
    if (result.mode === 'compare') {
      renderComparison(result);
      return;
    }
    document.getElementById('single-results').hidden = false;
    document.getElementById('compare').hidden = true;
    state.header = result.header || [];
    state.lineItems = result.lineItems || [];
    const currency = state.header.find(field => field.name === 'currencyCode');
    state.currency = currency && currency.value ? String(currency.value) : 'INR';
    renderFacets();
    renderHeader();
    renderLines();
    const filled = hasValues(result);
    const sourceName = result.source === 'document' ? 'Document AI' : 'SAP AI Core';
    if (result.mode === 'sample') {
      showMessage('information', `Sample invoice only. ${sourceName} was not called. Header and line items below use the schema columns.`);
      return;
    }
    const job = result.jobId ? ` Job ${result.jobId}.` : '';
    const model = result.modelName ? ` Model ${result.modelName}.` : '';
    if (!filled) {
      showMessage('critical', `${sourceName} finished with no values.${job}${model}`);
      return;
    }
    showMessage('positive', `${sourceName} extraction ${result.status}.${job}${model}`);
  }

  function renderComparison(result) {
    document.getElementById('single-results').hidden = true;
    const panel = document.getElementById('compare');
    panel.hidden = false;
    const comparison = result.comparison || { header: [], lineItems: [], summary: {} };
    const summary = comparison.summary || {};
    const model = result.aiCore && result.aiCore.modelName ? ` AI Core model: ${result.aiCore.modelName}.` : '';
    document.getElementById('compare-summary').textContent = result.sample
      ? `Sample only. ${summary.headerMatch || 0} header fields match and ${summary.headerDiffer || 0} differ.`
      : `${summary.headerMatch || 0} header fields match. ${summary.headerDiffer || 0} differ. Document AI lines: ${summary.documentLines || 0}. AI Core lines: ${summary.coreLines || 0}.${model}`;
    const errors = document.getElementById('compare-errors');
    errors.replaceChildren();
    if (result.documentAi && result.documentAi.ok === false) errors.appendChild(errorStrip(`Document AI: ${result.documentAi.error}`));
    if (result.aiCore && result.aiCore.ok === false) errors.appendChild(errorStrip(`AI Core: ${result.aiCore.error}`));
    const tbody = document.querySelector('#compare-header tbody');
    tbody.replaceChildren();
    (comparison.header || []).forEach(field => tbody.appendChild(compareRow(field)));
    const lines = document.getElementById('compare-lines');
    lines.replaceChildren();
    const lineItems = comparison.lineItems || [];
    document.getElementById('compare-line-count').textContent = lineItems.length
      ? `${lineItems.length} compared ${lineItems.length === 1 ? 'line' : 'lines'}.`
      : 'Neither extraction returned line items.';
    lineItems.forEach(line => {
      const block = document.createElement('section');
      block.className = `compare-line ${line.state}`;
      const title = document.createElement('h4');
      title.textContent = `Line ${line.index}`;
      const table = document.createElement('table');
      const body = document.createElement('tbody');
      line.fields.filter(field => field.state !== 'empty').forEach(field => body.appendChild(compareRow(field)));
      if (!body.childNodes.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 3;
        cell.className = 'empty';
        cell.textContent = 'No values on this line.';
        row.appendChild(cell);
        body.appendChild(row);
      }
      table.appendChild(body);
      block.append(title, table);
      lines.appendChild(block);
    });
    if (result.sample) {
      showMessage('information', 'Sample invoice only. Neither service was called. The comparison uses the same sample on both sides.');
      return;
    }
    if ((result.documentAi && result.documentAi.ok === false) || (result.aiCore && result.aiCore.ok === false)) {
      showMessage('critical', 'One extraction did not finish. The comparison shows the values that did come back.');
      return;
    }
    if (summary.differ) {
      showMessage('information', `${summary.differ} values differ across Document AI and AI Core.`);
      return;
    }
    showMessage('positive', 'Document AI and AI Core returned the same values.');
  }

  function errorStrip(text) {
    const node = document.createElement('p');
    node.className = 'strip negative';
    node.textContent = text;
    return node;
  }

  function compareRow(field) {
    const row = document.createElement('tr');
    row.className = field.state;
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = field.label || field.name;
    row.append(name, compareCell(field.documentAi), compareCell(field.aiCore));
    return row;
  }

  function compareCell(side) {
    const cell = document.createElement('td');
    const value = document.createElement('div');
    value.className = 'value';
    const raw = side && side.value != null && side.value !== '' ? side.value : '';
    value.textContent = raw === '' ? '—' : formatCompare(raw);
    cell.appendChild(value);
    if (side && side.confidence != null && raw !== '') {
      const score = document.createElement('div');
      score.className = 'compare-score';
      score.textContent = `${Math.round(Number(side.confidence) * 100)}%`;
      cell.appendChild(score);
    }
    return cell;
  }

  function formatCompare(value) {
    if (typeof value === 'number') {
      return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value);
    }
    return String(value);
  }

  async function probe() {
    setBusy(true);
    try {
      const response = await fetch(`/api/status?probe=1&source=${encodeURIComponent(selectedSource())}`);
      const body = await readJson(response);
      renderConnection(body);
      if (selectedSource() === 'both') {
        const problems = [body.aiCore, body.documentAi].filter(item => item && item.ok === false).map(item => item.error);
        if (problems.length) showMessage('negative', problems.join(' '));
        else showMessage('positive', 'Document AI and AI Core both accepted their service keys.');
      } else {
        const host = (body.aiCore && body.aiCore.tokenHost) || (body.documentAi && body.documentAi.tokenHost) || body.tokenHost;
        showMessage('positive', `Connection succeeded. Token host ${host}.`);
      }
    } catch (error) {
      const node = document.getElementById('connection');
      node.classList.remove('ready', 'warn');
      node.classList.add('bad');
      node.textContent = 'Connection failed';
      showMessage('negative', error.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadSchema(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      showMessage('negative', 'That file is not valid JSON.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
      const schema = await readJson(response);
      applySchema(schema);
      showMessage('positive', `Loaded schema ${schema.name}, version ${schema.version}. Upload an invoice, or preview the sample.`);
    } catch (error) {
      showMessage('negative', error.message);
    } finally {
      setBusy(false);
      schemaInput.value = '';
    }
  }

  function renderFacets() {
    const host = document.getElementById('facets');
    const wanted = [
      ['invoiceNumber', 'Invoice'],
      ['invoiceDate', 'Date'],
      ['supplierName', 'Supplier'],
      ['buyerName', 'Buyer'],
      ['invoiceTotal', 'Total']
    ];
    host.replaceChildren();
    const shown = wanted.map(([name, label]) => {
      const field = state.header.find(item => item.name === name);
      if (!field || field.value === '' || field.value == null) return null;
      const card = document.createElement('article');
      card.className = 'facet';
      const caption = document.createElement('span');
      caption.textContent = label;
      const value = document.createElement('strong');
      value.textContent = formatValue(field);
      card.append(caption, value);
      return card;
    }).filter(Boolean);
    shown.forEach(card => host.appendChild(card));
    host.hidden = shown.length === 0;
  }

  function renderHeader() {
    const tbody = document.querySelector('#header-table tbody');
    const filter = document.getElementById('header-filter').value.trim().toLowerCase();
    tbody.replaceChildren();
    let lastGroup = null;
    let shown = 0;
    state.header.forEach(field => {
      const haystack = `${field.label || ''} ${field.name} ${field.group || ''} ${field.value || ''}`.toLowerCase();
      if (filter && !haystack.includes(filter)) return;
      if ((field.group || '') !== lastGroup) {
        lastGroup = field.group || '';
        if (lastGroup) {
          const row = document.createElement('tr');
          row.className = 'group-row';
          const cell = document.createElement('th');
          cell.colSpan = 3;
          cell.scope = 'colgroup';
          cell.textContent = lastGroup;
          row.appendChild(cell);
          tbody.appendChild(row);
        }
      }
      shown += 1;
      const row = document.createElement('tr');
      const name = document.createElement('th');
      name.scope = 'row';
      const label = document.createElement('div');
      label.className = 'field-label';
      label.textContent = field.label || field.name;
      const technical = document.createElement('div');
      technical.className = 'field-name';
      technical.textContent = field.name;
      name.append(label, technical);
      const value = document.createElement('td');
      value.className = 'value';
      value.textContent = formatValue(field);
      const score = document.createElement('td');
      score.appendChild(confidenceNode(field.confidence));
      row.append(name, value, score);
      tbody.appendChild(row);
    });
    document.getElementById('header-count').textContent = String(shown);
    if (!shown) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty';
      cell.textContent = filter ? 'No header fields match that filter.' : 'This schema has no header fields.';
      row.appendChild(cell);
      tbody.appendChild(row);
    }
  }

  function renderLines() {
    const columns = lineColumns();
    const table = document.getElementById('lines-table');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    const tfoot = table.querySelector('tfoot');
    const headRow = document.createElement('tr');
    columns.forEach(column => {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = column.label || column.name;
      cell.title = column.name;
      if (numeric(column)) cell.classList.add('num');
      headRow.appendChild(cell);
    });
    thead.replaceChildren(headRow);
    tbody.replaceChildren();
    document.getElementById('line-count').textContent = String(state.lineItems.length);
    if (!state.lineItems.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = Math.max(columns.length, 1);
      cell.className = 'empty';
      cell.textContent = 'Line items appear here after extraction.';
      row.appendChild(cell);
      tbody.appendChild(row);
      tfoot.replaceChildren();
      return;
    }
    state.lineItems.forEach(cells => {
      const byName = new Map(cells.map(cell => [cell.name, cell]));
      const row = document.createElement('tr');
      columns.forEach(column => {
        const field = byName.get(column.name);
        const cell = document.createElement('td');
        if (numeric(column)) cell.classList.add('num');
        if (field && field.confidence != null && field.value !== '' && field.value != null) {
          const dot = document.createElement('span');
          dot.className = `dot ${band(field.confidence)}`;
          dot.title = `Confidence ${Math.round(Number(field.confidence) * 100)}%`;
          cell.appendChild(dot);
        }
        cell.appendChild(document.createTextNode(field ? formatValue(field) : '—'));
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
    renderTotals(columns, tfoot);
  }

  function renderTotals(columns, tfoot) {
    const totals = columns.map(column => {
      if (!isTotalColumn(column.name)) return null;
      const numbers = state.lineItems.map(cells => {
        const field = cells.find(cell => cell.name === column.name);
        if (!field || field.value === '' || field.value == null) return null;
        const value = Number(field.value);
        return Number.isFinite(value) ? value : null;
      });
      if (numbers.some(value => value == null)) return null;
      return numbers.reduce((sum, value) => sum + value, 0);
    });
    if (!totals.some(value => value != null)) {
      tfoot.replaceChildren();
      return;
    }
    let labelIndex = columns.findIndex(column => column.name === 'description');
    if (labelIndex < 0) labelIndex = Math.max(0, columns.findIndex(column => !isTotalColumn(column.name)));
    const row = document.createElement('tr');
    totals.forEach((total, index) => {
      const cell = document.createElement('td');
      if (index === labelIndex) cell.textContent = 'Total';
      else if (total == null) cell.textContent = '';
      else {
        cell.classList.add('num');
        cell.textContent = formatMoney(total);
      }
      row.appendChild(cell);
    });
    tfoot.replaceChildren(row);
  }

  function lineColumns() {
    const columns = state.schema.lineItemFields.map(field => ({
      name: field.name,
      label: field.label,
      type: field.type
    }));
    const known = new Set(columns.map(column => column.name));
    state.lineItems.forEach(cells => {
      cells.forEach(cell => {
        if (known.has(cell.name)) return;
        known.add(cell.name);
        columns.push({ name: cell.name, label: cell.label || cell.name, type: cell.type || 'string' });
      });
    });
    return columns;
  }

  function emptyField(field) {
    return { ...field, value: '', confidence: null };
  }

  function hasValues(result) {
    const headerHit = (result.header || []).some(field => field.value !== '' && field.value != null);
    const lineHit = (result.lineItems || []).some(row => row.some(cell => cell.value !== '' && cell.value != null));
    return headerHit || lineHit;
  }

  function numeric(field) {
    const name = field.name || '';
    return field.type === 'number' || field.type === 'currency' || /amount|price|total|quantity|rate|taxable|roundoff/i.test(name);
  }

  function isAmount(name) {
    return /amount|total|price|taxable|roundoff/i.test(name) && !/rate/i.test(name);
  }

  function isTotalColumn(name) {
    return /(amount|lineTotal)$/i.test(name);
  }

  function formatValue(field) {
    if (field.value === '' || field.value == null) return '—';
    const name = field.name || '';
    if (field.type === 'date' || /date$/i.test(name)) return formatDate(field.value);
    if (/rate$/i.test(name)) return formatNumber(field.value, 0, 2) + '%';
    if (/quantity/i.test(name)) return formatNumber(field.value, 0, 3);
    if (isAmount(name) || field.type === 'number' || field.type === 'currency') return formatMoney(field.value);
    return String(field.value);
  }

  function formatMoney(value) {
    const formatted = formatNumber(value, 2, 2);
    if (formatted === '—') return formatted;
    if (!state.currency || state.currency === 'INR') return `₹${formatted}`;
    return `${state.currency} ${formatted}`;
  }

  function formatNumber(value, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: minimum,
      maximumFractionDigits: maximum
    }).format(number);
  }

  function formatDate(value) {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return String(value);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${match[3]} ${months[Number(match[2]) - 1]} ${match[1]}`;
  }

  function band(confidence) {
    const score = Number(confidence);
    if (score >= 0.9) return 'high';
    if (score >= 0.75) return 'mid';
    return 'low';
  }

  function confidenceNode(confidence) {
    const wrap = document.createElement('div');
    if (confidence == null || confidence === '') {
      wrap.className = 'confidence none';
      wrap.textContent = '—';
      return wrap;
    }
    const score = Number(confidence);
    const percent = Math.round(score * 100);
    wrap.className = `confidence ${band(score)}`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    bar.appendChild(fill);
    const text = document.createElement('span');
    text.textContent = `${percent}%`;
    wrap.append(bar, text);
    return wrap;
  }

  function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showMessage(type, text) {
    message.hidden = false;
    message.className = `strip ${type}`;
    message.textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    document.getElementById('page').setAttribute('aria-busy', busy ? 'true' : 'false');
    document.querySelector('.upload-layout').closest('.card').classList.toggle('busy', busy);
    document.querySelectorAll('.actions .btn').forEach(button => {
      button.disabled = busy;
    });
    document.getElementById('schema-name').disabled = busy;
    document.getElementById('model-name').disabled = busy;
  }

  async function readJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status}).`);
    }
    return body;
  }
}());
