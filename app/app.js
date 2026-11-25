(function () {
  const state = {
    documentJobId: '',
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
  let previewPdf = null;
  let previewZoom = 1;
  let previewDrag = null;
  let previewTextPages = [];
  let usageOpen = false;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.25;
  const schemaInput = document.getElementById('schema-file');
  const message = document.getElementById('message');
  const guide = document.getElementById('guide');
  const closeGuide = document.getElementById('close-guide');
  if (closeGuide) closeGuide.addEventListener('click', () => guide.close());
  document.getElementById('schema-name').addEventListener('change', () => useSelectedSchema());
  document.querySelectorAll('input[name="source"]').forEach(input => {
    input.addEventListener('change', syncSourceFields);
  });
  document.querySelectorAll('input[name="input-mode"]').forEach(input => {
    input.addEventListener('change', syncSourceFields);
  });
  syncSourceFields();
  document.getElementById('model-name').addEventListener('change', applyModelChoice);
  document.getElementById('resource-group').addEventListener('change', () => loadModels());
  document.getElementById('gemini-deployment-id').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('gemini-model').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('deployment-id').addEventListener('change', () => fillModelSelect(state.models, document.getElementById('model-name').value));
  document.getElementById('extract').addEventListener('click', () => extract('live'));
  document.getElementById('check-document-job').addEventListener('click', checkDocumentJob);
  document.getElementById('sample').addEventListener('click', () => extract('sample'));
  document.getElementById('probe').addEventListener('click', probe);
  document.getElementById('load-schema').addEventListener('click', () => schemaInput.click());
  document.getElementById('header-filter').addEventListener('input', () => renderHeader());
  document.getElementById('preview-zoom-in').addEventListener('click', () => setPreviewZoom(previewZoom + ZOOM_STEP));
  document.getElementById('preview-zoom-out').addEventListener('click', () => setPreviewZoom(previewZoom - ZOOM_STEP));
  document.getElementById('preview-zoom-fit').addEventListener('click', () => setPreviewZoom(1));
  const previewFrame = document.getElementById('preview-frame');
  previewFrame.addEventListener('pointerdown', startPreviewDrag);
  previewFrame.addEventListener('pointermove', movePreviewDrag);
  previewFrame.addEventListener('pointerup', endPreviewDrag);
  previewFrame.addEventListener('pointercancel', endPreviewDrag);
  previewFrame.addEventListener('lostpointercapture', endPreviewDrag);
  document.getElementById('usage-toggle').addEventListener('click', () => {
    usageOpen = !usageOpen;
    syncUsageToggle();
  });
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

  function selectedInputMode() {
    const picked = document.querySelector('input[name="input-mode"]:checked');
    if (picked && picked.value === 'ocr') return 'ocr';
    if (picked && picked.value === 'both') return 'both';
    return 'vision';
  }

  function syncInputModeNote() {
    const note = document.getElementById('input-mode-note');
    if (!note) return;
    if (selectedSource() === 'document') {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    const mode = selectedInputMode();
    if (mode === 'ocr') {
      note.textContent = 'PaddleOCR reads pixels, then the selected model writes the schema JSON. On a digital PDF this costs about the same as Vision. On a scan it is usually cheaper.';
    } else if (mode === 'both') {
      note.textContent = 'Both paths use the selected model. The comparison shows field values and a token breakup for PaddleOCR and for Vision.';
    } else {
      note.textContent = 'Scans and photos are sent as images. A digital PDF with a text layer is already sent as text, so tokens look like PaddleOCR.';
    }
  }

  function syncSourceFields() {
    const source = selectedSource();
    document.querySelectorAll('.for-aicore').forEach(node => { node.hidden = source === 'document'; });
    document.querySelectorAll('.for-document').forEach(node => { node.hidden = source === 'aicore'; });
    if (source !== 'aicore' && selectedInputMode() === 'both') {
      const vision = document.querySelector('input[name="input-mode"][value="vision"]');
      if (vision) vision.checked = true;
    }
    document.querySelectorAll('.for-read-compare').forEach(node => { node.hidden = source !== 'aicore'; });
    const hint = document.getElementById('source-hint');
    const extract = document.getElementById('extract');
    if (source === 'document') {
      hint.innerHTML = 'Document AI extracts with the schema name and version. The client is usually <code>default</code>. A template is required when the schema fields use manual setup.';
      extract.textContent = 'Extract invoice';
    } else if (source === 'both') {
      hint.innerHTML = 'Both services read this file. The comparison marks each field that does not agree. The Model menu chooses which running AI Core deployment to compare with Document AI. Read with applies to the AI Core side.';
      extract.textContent = 'Extract with both';
    } else if (selectedInputMode() === 'both') {
      hint.innerHTML = 'PaddleOCR and Vision each call the selected model. The comparison marks fields that do not agree and shows a token breakup for both.';
      extract.textContent = 'Compare OCR and Vision';
    } else {
      hint.innerHTML = 'GPT, Gemini, and Claude each have their own deployment. Choose the model above. GPT and Gemini IDs are filled from <code>default-env.json</code>.';
      extract.textContent = 'Extract invoice';
    }
    syncInputModeNote();
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

  function canExtract(name) {
    const model = String(name || '').trim().toLowerCase();
    if (!model) return false;
    if (model.includes('embed') || model.includes('realtime') || model.includes('whisper') || model.includes('tts') || model.includes('dall') || model.includes('transcrib') || model.includes('imagen')) return false;
    if (model.includes('-image') || model.endsWith('image') || model.includes('sap-rpt') || model.includes('rpt-') || model.includes('codex')) return false;
    return true;
  }

  function modelsForMenu(models) {
    const list = (models || []).map(item => ({ ...item }));
    const gemini = localGemini();
    if (gemini && canExtract(gemini.modelName)) {
      const existing = list.find(item => item.deploymentId === gemini.deploymentId);
      const runningSameName = list.find(item => item.deployed && String(item.modelName || '').toLowerCase() === gemini.modelName.toLowerCase());
      if (existing) {
        if (!existing.modelName) existing.modelName = gemini.modelName;
        existing.executableId = existing.executableId || 'gcp-vertexai';
        existing.deployed = true;
        existing.usable = true;
        existing.reason = '';
      } else if (!runningSameName && !list.length) {
        list.unshift(gemini);
      }
    }
    return list.filter(item => item.deployed && item.usable !== false && canExtract(item.modelName));
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
    const gptId = document.getElementById('deployment-id').value.trim();
    const menu = modelsForMenu(models).slice().sort((left, right) => {
      if (left.deploymentId === gptId) return -1;
      if (right.deploymentId === gptId) return 1;
      return left.modelName.localeCompare(right.modelName);
    });
    select.replaceChildren();
    const knownGpt = menu.some(model => model.deploymentId === gptId);
    if (gptId && !knownGpt) {
      const fallback = document.createElement('option');
      fallback.value = 'gpt';
      fallback.textContent = 'GPT';
      select.appendChild(fallback);
    }
    menu.forEach(model => {
      const option = document.createElement('option');
      option.value = model.deploymentId;
      option.dataset.modelName = model.modelName;
      option.dataset.deploymentId = model.deploymentId || '';
      option.dataset.executableId = model.executableId || '';
      option.textContent = model.modelName;
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
      if (body.resourceGroup) document.getElementById('resource-group').value = body.resourceGroup;
      fillModelSelect(state.models, previous === '' ? 'gpt' : previous);
      const shown = modelsForMenu(state.models);
      if (shown.length || document.getElementById('deployment-id').value.trim()) {
        note.textContent = 'The menu lists running chat models only.';
      } else if (body.error) note.textContent = body.error;
      else note.textContent = 'No chat model is deployed yet. Add a GPT, Gemini, or Claude deployment under Request options.';
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
    previewPdf = null;
    previewTextPages = [];
    clearHighlights();
    const pages = document.getElementById('preview-pages');
    pages.hidden = true;
    pages.replaceChildren();
  }

  function previewBaseWidth() {
    const frame = document.getElementById('preview-frame');
    return Math.max((frame && frame.clientWidth ? frame.clientWidth : 480) - 36, 280);
  }

  function applyPreviewZoom() {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, previewZoom));
    previewZoom = Math.round(clamped * 100) / 100;
    const label = document.getElementById('preview-zoom-label');
    const pages = document.getElementById('preview-pages');
    const imageWrap = document.getElementById('preview-image-wrap');
    const zoomOut = document.getElementById('preview-zoom-out');
    const zoomIn = document.getElementById('preview-zoom-in');
    label.textContent = `${Math.round(previewZoom * 100)}%`;
    zoomOut.disabled = previewZoom <= ZOOM_MIN;
    zoomIn.disabled = previewZoom >= ZOOM_MAX;
    const base = `${previewBaseWidth()}px`;
    pages.style.setProperty('--preview-zoom', String(previewZoom));
    pages.style.setProperty('--preview-base-width', base);
    imageWrap.style.setProperty('--preview-zoom', String(previewZoom));
    syncPreviewCursor();
  }

  function previewHasDocument() {
    const pages = document.getElementById('preview-pages');
    const imageWrap = document.getElementById('preview-image-wrap');
    const image = document.getElementById('preview-image');
    return (!pages.hidden && pages.querySelector('canvas')) || (!imageWrap.hidden && image.getAttribute('src'));
  }

  function previewOverflows() {
    return previewFrame.scrollWidth > previewFrame.clientWidth + 1
      || previewFrame.scrollHeight > previewFrame.clientHeight + 1;
  }

  function syncPreviewCursor() {
    previewFrame.classList.toggle('is-pannable', previewHasDocument() && previewOverflows());
  }

  function startPreviewDrag(event) {
    if (event.button !== 0 || previewDrag) return;
    if (!previewHasDocument() || !previewOverflows()) return;
    event.preventDefault();
    previewFrame.setPointerCapture(event.pointerId);
    previewDrag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: previewFrame.scrollLeft,
      top: previewFrame.scrollTop
    };
    previewFrame.classList.add('is-panning');
  }

  function movePreviewDrag(event) {
    if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
    event.preventDefault();
    previewFrame.scrollLeft = previewDrag.left - (event.clientX - previewDrag.x);
    previewFrame.scrollTop = previewDrag.top - (event.clientY - previewDrag.y);
  }

  function endPreviewDrag(event) {
    if (!previewDrag) return;
    if (event && event.pointerId != null && event.pointerId !== previewDrag.pointerId) return;
    previewDrag = null;
    previewFrame.classList.remove('is-panning');
    syncPreviewCursor();
  }

  function setPreviewZoom(next) {
    previewZoom = next;
    applyPreviewZoom();
  }

  function showPreviewTools(visible) {
    const tools = document.getElementById('preview-tools');
    tools.hidden = !visible;
    if (visible) applyPreviewZoom();
    else {
      endPreviewDrag();
      previewFrame.classList.remove('is-pannable', 'is-panning');
    }
  }

  function setPreview(file) {
    const empty = document.getElementById('preview-empty');
    const imageWrap = document.getElementById('preview-image-wrap');
    const image = document.getElementById('preview-image');
    const unsupported = document.getElementById('preview-unsupported');
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = '';
    }
    clearPdfPreview();
    imageWrap.hidden = true;
    image.removeAttribute('src');
    unsupported.hidden = true;
    if (!file) {
      empty.hidden = false;
      showPreviewTools(false);
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
      showPreviewTools(false);
      unsupported.hidden = false;
      unsupported.textContent = isTiff
        ? 'TIFF is not shown here, and SAP AI Core vision models do not accept it. Export the page as PNG or JPEG.'
        : 'This file cannot be previewed here. Upload a PDF, PNG, or JPEG.';
      return;
    }
    previewZoom = 1;
    showPreviewTools(true);
    if (isPdf) {
      showPdf(file);
      return;
    }
    previewUrl = URL.createObjectURL(file);
    image.alt = file.name || 'Uploaded invoice';
    image.onerror = () => {
      imageWrap.hidden = true;
      showPreviewTools(false);
      unsupported.hidden = false;
      unsupported.textContent = 'This image could not be previewed. Upload a PNG or JPEG.';
    };
    image.onload = () => syncPreviewCursor();
    image.src = previewUrl;
    imageWrap.hidden = false;
    applyPreviewZoom();
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
      showPreviewTools(false);
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
      showPreviewTools(false);
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
      showPreviewTools(false);
      unsupported.hidden = false;
      unsupported.textContent = 'This PDF could not be opened in the preview.';
      return;
    }
    if (generation !== previewGeneration) return;
    previewPdf = documentPdf;
    previewTextPages = [];
    pages.replaceChildren();
    applyPreviewZoom();
    const count = documentPdf.numPages;
    const width = previewBaseWidth();
    for (let number = 1; number <= count; number += 1) {
      if (generation !== previewGeneration) return;
      const page = await documentPdf.getPage(number);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / unscaled.width });
      const wrap = document.createElement('div');
      wrap.className = 'preview-page';
      wrap.dataset.page = String(number);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.setAttribute('aria-label', `Invoice page ${number} of ${count}`);
      const marks = document.createElement('div');
      marks.className = 'preview-highlights';
      wrap.append(canvas, marks);
      pages.appendChild(wrap);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const content = await page.getTextContent();
      previewTextPages.push({
        page: number,
        items: (content.items || []).map(item => textItemBox(item, viewport, canvas.width, canvas.height)).filter(Boolean)
      });
    }
    if (generation === previewGeneration) syncPreviewCursor();
  }

  function textItemBox(item, viewport, canvasWidth, canvasHeight) {
    const text = String((item && item.str) || '');
    if (!text.trim()) return null;
    const matrix = item.transform || [1, 0, 0, 1, 0, 0];
    const transform = window.pdfjsLib && window.pdfjsLib.Util && window.pdfjsLib.Util.transform
      ? window.pdfjsLib.Util.transform(viewport.transform, matrix)
      : [
        viewport.transform[0] * matrix[0] + viewport.transform[2] * matrix[1],
        viewport.transform[1] * matrix[0] + viewport.transform[3] * matrix[1],
        viewport.transform[0] * matrix[2] + viewport.transform[2] * matrix[3],
        viewport.transform[1] * matrix[2] + viewport.transform[3] * matrix[3],
        viewport.transform[0] * matrix[4] + viewport.transform[2] * matrix[5] + viewport.transform[4],
        viewport.transform[1] * matrix[4] + viewport.transform[3] * matrix[5] + viewport.transform[5]
      ];
    const height = Math.hypot(transform[2], transform[3]) || (item.height || 8) * (viewport.scale || 1);
    const width = (item.width || 0) * (viewport.scale || 1) || Math.max(4, text.length * height * 0.5);
    const left = transform[4];
    const top = transform[5] - height;
    if (!canvasWidth || !canvasHeight) return { str: text, left: 0, top: 0, width: 0, height: 0 };
    return {
      str: text,
      left: left / canvasWidth,
      top: top / canvasHeight,
      width: width / canvasWidth,
      height: height / canvasHeight
    };
  }

  function locateApi() {
    return window.invoiceLocate || {};
  }

  function setFindNote(text) {
    const note = document.getElementById('preview-find');
    if (!text) {
      note.hidden = true;
      note.textContent = '';
      return;
    }
    note.hidden = false;
    note.textContent = text;
  }

  function clearHighlights() {
    document.querySelectorAll('.preview-highlight').forEach(node => node.remove());
    document.querySelectorAll('.is-located').forEach(node => node.classList.remove('is-located'));
    setFindNote('');
  }

  function highlightHost(hit) {
    const page = document.querySelector(`.preview-page[data-page="${hit && hit.page}"]`);
    if (page && !page.hasAttribute('hidden') && !page.closest('[hidden]')) return page;
    const imageWrap = document.getElementById('preview-image-wrap');
    if (imageWrap && !imageWrap.hidden) return imageWrap;
    return null;
  }

  function paintHighlights(hits) {
    document.querySelectorAll('.preview-highlight').forEach(node => node.remove());
    (hits || []).forEach((hit, index) => {
      const page = highlightHost(hit);
      if (!page) return;
      const layer = page.querySelector('.preview-highlights');
      if (!layer) return;
      const mark = document.createElement('span');
      mark.className = 'preview-highlight';
      if (index === 0) mark.classList.add('is-active');
      mark.style.left = `${hit.left * 100}%`;
      mark.style.top = `${hit.top * 100}%`;
      mark.style.width = `${Math.max(1.2, hit.width * 100)}%`;
      mark.style.height = `${Math.max(1.4, hit.height * 100)}%`;
      layer.appendChild(mark);
    });
    const first = document.querySelector('.preview-highlight');
    if (first) first.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function bindLocate(node, field, optionsFactory) {
    node.classList.add('has-value');
    node.tabIndex = 0;
    node.title = 'Highlight this value on the invoice';
    const activate = () => locateField(field, node, optionsFactory ? optionsFactory() : {});
    node.addEventListener('click', activate);
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  }

  function locateField(field, origin, options = {}) {
    if (!field || field.value === '' || field.value == null) return;
    document.querySelectorAll('.is-located').forEach(node => node.classList.remove('is-located'));
    if (origin) origin.classList.add('is-located');
    const pagesEl = document.getElementById('preview-pages');
    const imageWrap = document.getElementById('preview-image-wrap');
    if (pagesEl.hidden && imageWrap.hidden) {
      setFindNote('Upload a PDF or image to highlight this value on the invoice.');
      return;
    }
    if (!pagesEl.hidden && !previewTextPages.length) {
      setFindNote('The invoice is still opening. Click the field again in a moment.');
      return;
    }
    const locate = locateApi();
    let hits = [];
    if (field.box && Number.isFinite(field.box.left)) hits = [field.box];
    if (!hits.length && typeof locate.findHits === 'function') {
      hits = locate.findHits(previewTextPages, field, options);
    }
    if (!hits.length) {
      document.querySelectorAll('.preview-highlight').forEach(node => node.remove());
      if (!imageWrap.hidden && pagesEl.hidden) {
        setFindNote('This image has no searchable text. Document AI field boxes still highlight when they are returned.');
      } else {
        setFindNote('That value was not found on the PDF text layer.');
      }
      return;
    }
    paintHighlights(hits);
    const page = hits[0].page || 1;
    setFindNote(hits.length === 1
      ? `Highlighted on page ${page}.`
      : `Highlighted ${hits.length} matches, first on page ${page}.`);
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
    const geminiChoice = choice.executableId === 'gcp-vertexai' || String(choice.modelName || '').toLowerCase().startsWith('gemini');
    form.set('deploymentId', choice.deploymentId || (geminiChoice ? document.getElementById('gemini-deployment-id').value.trim() : document.getElementById('deployment-id').value.trim()));
    form.set('doxClient', document.getElementById('dox-client').value.trim());
    form.set('template', document.getElementById('template').value.trim());
    form.set('inputMode', selectedInputMode());
    if (file) form.set('file', file);
    setBusy(true);
    const inputMode = selectedInputMode();
    const waiting = source === 'both'
      ? (inputMode === 'ocr'
        ? 'Document AI reads the file. AI Core runs PaddleOCR, then the selected model.'
        : 'Uploading the invoice to Document AI and SAP AI Core.')
      : source === 'document'
        ? 'Uploading the invoice and waiting for Document AI.'
        : inputMode === 'both'
          ? 'Running PaddleOCR then the selected model, and Vision LLM, on the same invoice.'
          : inputMode === 'ocr'
            ? 'Reading the invoice with PaddleOCR, then sending the text to the selected model.'
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
    if (result.mode === 'compare' || result.mode === 'compare-read') {
      renderComparison(result);
      return;
    }
    document.getElementById('single-results').hidden = false;
    document.getElementById('compare').hidden = true;
    renderUsage(result.source === 'document' || result.mode === 'sample' ? null : result.usage);
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
    const pages = result.pages ? ` ${result.pages} pages.` : '';
    const lines = Array.isArray(result.lineItems) ? ` ${result.lineItems.length} line items.` : '';
    const read = result.usage && result.usage.inputMode === 'ocr' ? ' PaddleOCR then the selected model.' : '';
    if (!filled) {
      showMessage('critical', `${sourceName} finished with no values.${job}${model}${read}`);
      return;
    }
    showMessage('positive', `${sourceName} extraction ${result.status}.${job}${model}${pages}${lines}${read}`);
  }

  function renderComparison(result) {
    document.getElementById('single-results').hidden = true;
    const panel = document.getElementById('compare');
    panel.hidden = false;
    const readCompare = result.mode === 'compare-read';
    document.getElementById('compare-left-col').textContent = readCompare ? 'PaddleOCR then LLM' : 'Document AI';
    document.getElementById('compare-right-col').textContent = readCompare ? 'Vision LLM' : 'AI Core';
    if (result.sample) renderUsage(null);
    else if (readCompare) renderUsagePair(result.ocr && result.ocr.usage, result.vision && result.vision.usage);
    else renderUsage(result.aiCore && result.aiCore.usage);
    const comparison = result.comparison || { header: [], lineItems: [], summary: {} };
    const summary = comparison.summary || {};
    const model = readCompare
      ? ((result.ocr && result.ocr.modelName) || (result.vision && result.vision.modelName) ? ` Model ${(result.ocr && result.ocr.modelName) || result.vision.modelName}.` : '')
      : (result.aiCore && result.aiCore.modelName ? ` AI Core model: ${result.aiCore.modelName}.` : '');
    const pages = readCompare
      ? ''
      : (result.aiCore && result.aiCore.pages ? ` AI Core pages: ${result.aiCore.pages}.` : '');
    const read = !readCompare && result.aiCore && result.aiCore.usage && result.aiCore.usage.inputMode === 'ocr'
      ? ' AI Core read with PaddleOCR then the selected model.'
      : '';
    const leftLines = readCompare ? 'PaddleOCR' : 'Document AI';
    const rightLines = readCompare ? 'Vision' : 'AI Core';
    document.getElementById('compare-summary').textContent = result.sample
      ? `Sample only. ${summary.headerMatch || 0} header fields match and ${summary.headerDiffer || 0} differ.`
      : `${summary.headerMatch || 0} header fields match. ${summary.headerDiffer || 0} differ. ${leftLines} lines: ${summary.documentLines || 0}. ${rightLines} lines: ${summary.coreLines || 0}.${model}${pages}${read}`;
    const errors = document.getElementById('compare-errors');
    errors.replaceChildren();
    const documentPending = Boolean(result.documentAi && result.documentAi.pending && result.documentAi.jobId);
    state.documentJobId = documentPending ? result.documentAi.jobId : '';
    const checkJob = document.getElementById('check-document-job');
    checkJob.hidden = !documentPending;
    checkJob.disabled = false;
    checkJob.textContent = 'Check Document AI status';
    if (readCompare) {
      if (result.ocr && result.ocr.ok === false) errors.appendChild(errorStrip(`PaddleOCR: ${result.ocr.error}`));
      if (result.vision && result.vision.ok === false) errors.appendChild(errorStrip(`Vision LLM: ${result.vision.error}`));
    } else {
      if (result.documentAi && result.documentAi.ok === false && !documentPending) errors.appendChild(errorStrip(`Document AI: ${result.documentAi.error}`));
      if (result.aiCore && result.aiCore.ok === false) errors.appendChild(errorStrip(`AI Core: ${result.aiCore.error}`));
    }
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
      line.fields.filter(field => field.state !== 'empty').forEach(field => {
        body.appendChild(compareRow(field, { occurrence: Math.max(0, line.index - 1) }));
      });
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
      showMessage('information', readCompare
        ? 'Sample invoice only. Neither PaddleOCR nor Vision was called. The comparison uses the same sample on both sides.'
        : 'Sample invoice only. Neither service was called. The comparison uses the same sample on both sides.');
      return;
    }
    if (documentPending) {
      const detail = result.documentAi.error || `Document AI job ${result.documentAi.jobId} is still ${result.documentAi.status || 'PENDING'}.`;
      showMessage('information', `${detail} AI Core is already in this comparison. Check Document AI status to load it here.`);
      return;
    }
    if (readCompare) {
      if ((result.ocr && result.ocr.ok === false) || (result.vision && result.vision.ok === false)) {
        showMessage('critical', 'One read path did not finish. The comparison shows the values that did come back.');
        return;
      }
      if (summary.differ) {
        showMessage('information', `${summary.differ} values differ across PaddleOCR and Vision.`);
        return;
      }
      showMessage('positive', 'PaddleOCR and Vision returned the same values.');
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

  async function checkDocumentJob() {
    const jobId = state.documentJobId;
    if (!jobId || state.busy) return;
    const button = document.getElementById('check-document-job');
    setBusy(true);
    button.disabled = true;
    button.textContent = 'Checking Document AI…';
    showMessage('information', `Checking Document AI job ${jobId}.`);
    try {
      const response = await fetch(`/api/document-jobs/${encodeURIComponent(jobId)}`);
      const body = await readJson(response);
      if (body.pending) {
        showMessage('information', `${body.message || `Document AI job ${jobId} is still ${body.status}.`} AI Core stays in this comparison.`);
        return;
      }
      renderComparison(body);
    } catch (error) {
      showMessage('negative', error.message);
    } finally {
      setBusy(false);
      if (state.documentJobId) {
        button.hidden = false;
        button.disabled = false;
        button.textContent = 'Check Document AI status';
      }
    }
  }

  function errorStrip(text) {
    const node = document.createElement('p');
    node.className = 'strip negative';
    node.textContent = text;
    return node;
  }

  function compareRow(field, options = {}) {
    const row = document.createElement('tr');
    row.className = field.state;
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = field.label || field.name;
    row.append(name, compareCell(field.documentAi), compareCell(field.aiCore));
    const side = (field.aiCore && field.aiCore.value !== '' && field.aiCore.value != null)
      ? field.aiCore
      : field.documentAi;
    if (side && side.value !== '' && side.value != null) {
      const target = {
        name: field.name,
        label: field.label,
        type: field.type,
        value: side.value,
        box: (field.documentAi && field.documentAi.box) || side.box
      };
      bindLocate(row, target, () => options);
    }
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

  function syncUsageToggle() {
    const facts = document.getElementById('usage-facts');
    const toggle = document.getElementById('usage-toggle');
    facts.hidden = !usageOpen;
    toggle.setAttribute('aria-expanded', usageOpen ? 'true' : 'false');
    toggle.textContent = usageOpen ? 'Hide tokens' : 'Show tokens';
  }

  function hasUsage(usage) {
    return Boolean(usage && (usage.totalTokens != null || usage.promptTokens != null || usage.completionTokens != null || usage.inputMode));
  }

  function usageItems(usage) {
    if (!usage) return [];
    const ocr = usage.inputMode === 'ocr';
    const items = [
      ['Read with', ocr ? 'PaddleOCR then LLM' : 'Vision LLM'],
      ['Sent to model', sentAsLabel(usage.sentAs, ocr)],
      ['OCR engine', ocr ? 'PaddleOCR' : ''],
      ['OCR model', ocr ? usage.ocrModel : ''],
      ['OCR pages', ocr && usage.ocrPages != null ? String(usage.ocrPages) : ''],
      ['Model', usage.reportedModel || usage.model],
      ['Selected model', usage.model && usage.model !== usage.reportedModel ? usage.model : ''],
      ['Deployment', usage.deploymentId],
      ['Resource group', usage.resourceGroup],
      ['Executable', usage.executableId],
      ['Input tokens', formatCount(usage.inputTokens)],
      ['Output tokens', formatCount(usage.outputTokens)],
      ['Prompt tokens', formatCount(usage.promptTokens)],
      ['Completion tokens', formatCount(usage.completionTokens)],
      ['Total tokens', formatCount(usage.totalTokens)]
    ];
    if (usage.cachedTokens) items.push(['Cached input tokens', formatCount(usage.cachedTokens)]);
    if (usage.reasoningTokens) items.push(['Reasoning tokens', formatCount(usage.reasoningTokens)]);
    (usage.promptDetails || []).forEach(item => items.push([`Prompt ${String(item.modality).toLowerCase()}`, formatCount(item.tokens)]));
    (usage.completionDetails || []).forEach(item => items.push([`Completion ${String(item.modality).toLowerCase()}`, formatCount(item.tokens)]));
    if (usage.calls > 1) items.push(['AI Core calls', String(usage.calls)]);
    return items.filter(([, value]) => value !== '' && value != null);
  }

  function fillUsageHost(host, usage) {
    host.replaceChildren(...usageItems(usage).map(([label, value]) => usageFact(label, value)));
  }

  function renderUsage(usage) {
    const panel = document.getElementById('usage');
    const single = document.getElementById('usage-single');
    const split = document.getElementById('usage-compare');
    const delta = document.getElementById('usage-delta');
    const note = document.getElementById('usage-note');
    document.getElementById('usage-title').textContent = 'AI Core usage';
    split.hidden = true;
    delta.hidden = true;
    if (!hasUsage(usage)) {
      panel.hidden = true;
      single.replaceChildren();
      return;
    }
    const ocr = usage.inputMode === 'ocr';
    fillUsageHost(single, usage);
    single.hidden = false;
    note.textContent = usageNote(usage, ocr);
    panel.hidden = false;
    syncUsageToggle();
  }

  function usageDelta(ocrUsage, visionUsage) {
    const parts = [];
    const pair = (label, left, right) => {
      if (left == null || right == null) return;
      const diff = left - right;
      if (diff === 0) parts.push(`${label} match.`);
      else if (diff > 0) parts.push(`Vision used ${formatCount(diff)} fewer ${label.toLowerCase()}.`);
      else parts.push(`PaddleOCR used ${formatCount(-diff)} fewer ${label.toLowerCase()}.`);
    };
    pair('Input tokens', ocrUsage && ocrUsage.inputTokens, visionUsage && visionUsage.inputTokens);
    pair('Output tokens', ocrUsage && ocrUsage.outputTokens, visionUsage && visionUsage.outputTokens);
    pair('Total tokens', ocrUsage && ocrUsage.totalTokens, visionUsage && visionUsage.totalTokens);
    return parts.join(' ');
  }

  function renderUsagePair(ocrUsage, visionUsage) {
    const panel = document.getElementById('usage');
    const single = document.getElementById('usage-single');
    const split = document.getElementById('usage-compare');
    const delta = document.getElementById('usage-delta');
    const note = document.getElementById('usage-note');
    if (!hasUsage(ocrUsage) && !hasUsage(visionUsage)) {
      panel.hidden = true;
      return;
    }
    document.getElementById('usage-title').textContent = 'Token breakup';
    single.hidden = true;
    single.replaceChildren();
    split.hidden = false;
    fillUsageHost(document.getElementById('usage-left-facts'), ocrUsage);
    fillUsageHost(document.getElementById('usage-right-facts'), visionUsage);
    note.textContent = 'PaddleOCR and Vision each called the selected model. Input, output, prompt, completion, and total tokens are shown for both.';
    const line = usageDelta(ocrUsage, visionUsage);
    delta.hidden = !line;
    delta.textContent = line;
    panel.hidden = false;
    usageOpen = true;
    syncUsageToggle();
  }

  function sentAsLabel(sentAs, ocr) {
    if (sentAs === 'ocr-text' || (ocr && !sentAs)) return 'PaddleOCR text';
    if (sentAs === 'pdf-text') return 'PDF text layer';
    if (sentAs === 'pdf-file') return 'PDF pages';
    if (sentAs === 'pdf-mixed') return 'PDF text and pages';
    if (sentAs === 'image') return 'Page image';
    return '';
  }

  function usageNote(usage, ocr) {
    const sentAs = usage.sentAs || (ocr ? 'ocr-text' : '');
    if (sentAs === 'pdf-text') {
      return 'This PDF already has a text layer. Vision LLM sent that text, not page images, so token counts stay close to PaddleOCR on the same file. Most of the input is the schema prompt plus the invoice wording.';
    }
    if (sentAs === 'ocr-text') {
      return usage.calls > 1
        ? 'PaddleOCR read the pages locally. Token counts are the sum of the selected model calls on that text. On a digital PDF this is not cheaper than Vision, because Vision also sends text.'
        : 'PaddleOCR read the pages locally. Token counts come from the selected model on that text. On a digital PDF this is not cheaper than Vision, because Vision also sends text.';
    }
    if (sentAs === 'image' || sentAs === 'pdf-file') {
      return 'The model was charged for page images. PaddleOCR then LLM would send text instead and usually uses fewer input tokens on a scan.';
    }
    if (sentAs === 'pdf-mixed') {
      return 'Some pages were sent as text and some as PDF images. Token savings from PaddleOCR show up on the scanned pages.';
    }
    return usage.calls > 1
      ? 'Counts are the sum of the AI Core calls for this extraction. Prompt tokens are the input. Completion tokens are the output.'
      : 'Prompt tokens are the input. Completion tokens are the output. The counts come from the model response.';
  }

  function usageFact(label, value) {
    const card = document.createElement('article');
    card.className = 'facet';
    const caption = document.createElement('span');
    caption.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    card.append(caption, strong);
    return card;
  }

  function formatCount(value) {
    if (value == null || value === '') return '';
    return new Intl.NumberFormat('en-IN').format(value);
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
      if (field.value !== '' && field.value != null) bindLocate(card, field);
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
      if (field.value !== '' && field.value != null) bindLocate(row, field);
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
    const list = document.getElementById('lines-list');
    const totals = document.getElementById('line-totals');
    list.replaceChildren();
    document.getElementById('line-count').textContent = String(state.lineItems.length);
    if (!state.lineItems.length) {
      const empty = document.createElement('p');
      empty.className = 'line-empty';
      empty.textContent = 'Line items appear here after extraction.';
      list.appendChild(empty);
      totals.hidden = true;
      totals.replaceChildren();
      return;
    }
    state.lineItems.forEach((cells, index) => {
      const byName = new Map(cells.map(cell => [cell.name, cell]));
      const card = document.createElement('article');
      card.className = 'line-card';
      card.setAttribute('role', 'listitem');
      const title = document.createElement('h3');
      title.textContent = `Line ${index + 1}`;
      const fields = document.createElement('dl');
      fields.className = 'line-fields';
      columns.forEach(column => {
        const field = byName.get(column.name) || column;
        const row = document.createElement('div');
        row.className = 'line-field';
        const term = document.createElement('dt');
        term.textContent = column.label || column.name;
        const value = document.createElement('dd');
        value.className = numeric(column) ? 'num' : 'value';
        value.textContent = field ? formatValue(field) : '—';
        const score = document.createElement('dd');
        score.className = 'line-score';
        score.appendChild(confidenceNode(field && field.confidence));
        row.append(term, value, score);
        if (field && field.value !== '' && field.value != null) {
          bindLocate(row, field, () => {
            const description = byName.get('description');
            const nearHits = description && window.invoiceLocate
              ? window.invoiceLocate.findHits(previewTextPages, description, { limit: 1 })
              : [];
            return {
              near: nearHits[0] || (description && description.box),
              occurrence: index
            };
          });
        }
        fields.appendChild(row);
      });
      card.append(title, fields);
      list.appendChild(card);
    });
    renderTotals(columns, totals);
  }

  function renderTotals(columns, host) {
    const totals = columns.map(column => {
      if (!isTotalColumn(column.name)) return null;
      const numbers = state.lineItems.map(cells => {
        const field = cells.find(cell => cell.name === column.name);
        if (!field || field.value === '' || field.value == null) return null;
        const value = Number(field.value);
        return Number.isFinite(value) ? value : null;
      });
      if (numbers.some(value => value == null)) return null;
      return { label: column.label || column.name, value: numbers.reduce((sum, value) => sum + value, 0) };
    }).filter(Boolean);
    if (!totals.length) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    host.replaceChildren(...totals.map(item => {
      const wrap = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = item.label;
      wrap.append(label, document.createTextNode(formatMoney(item.value)));
      return wrap;
    }));
    host.hidden = false;
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
