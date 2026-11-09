(function () {
  const state = {
    schema: null,
    header: [],
    lineItems: [],
    currency: 'INR',
    busy: false
  };

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file');
  const schemaInput = document.getElementById('schema-file');
  const message = document.getElementById('message');
  const guide = document.getElementById('guide');

  document.getElementById('open-guide').addEventListener('click', () => guide.showModal());
  document.getElementById('close-guide').addEventListener('click', () => guide.close());
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

  function renderConnection(status) {
    const node = document.getElementById('connection');
    document.getElementById('dox-client').value = status.doxClient || 'default';
    if (!document.getElementById('template').value) {
      document.getElementById('template').value = status.template || '';
    }
    node.classList.remove('ready', 'warn', 'bad');
    if (status.configured) {
      node.classList.add('ready');
      node.textContent = `Service key found · ${status.apiHost}`;
    } else {
      node.classList.add('warn');
      node.textContent = 'Service key not configured';
    }
  }

  function showSelectedFile(file) {
    const meta = document.getElementById('file-meta');
    if (!file) {
      meta.textContent = 'No file selected.';
      return;
    }
    meta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  }

  async function extract(mode) {
    if (state.busy) return;
    const file = fileInput.files && fileInput.files[0];
    if (mode === 'live' && !file) {
      showMessage('critical', 'Choose an invoice file first, or preview the sample.');
      return;
    }
    const form = new FormData();
    form.set('mode', mode);
    form.set('schemaName', document.getElementById('schema-name').value.trim());
    form.set('schemaVersion', document.getElementById('schema-version').value.trim());
    form.set('documentType', document.getElementById('document-type').value);
    form.set('doxClient', document.getElementById('dox-client').value.trim());
    form.set('template', document.getElementById('template').value.trim());
    if (file) form.set('file', file);
    setBusy(true);
    showMessage('information', mode === 'sample'
      ? 'Filling the tables with a sample GST invoice.'
      : 'Uploading the invoice and waiting for Document AI.');
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
    state.header = result.header || [];
    state.lineItems = result.lineItems || [];
    const currency = state.header.find(field => field.name === 'currencyCode');
    state.currency = currency && currency.value ? String(currency.value) : 'INR';
    renderFacets();
    renderHeader();
    renderLines();
    const filled = hasValues(result);
    if (result.mode === 'sample') {
      showMessage('information', 'Sample invoice only. Document AI was not called. Header and line items below use the schema columns.');
      return;
    }
    const job = result.jobId ? ` Job ${result.jobId}.` : '';
    if (!filled) {
      showMessage('critical', `Document AI finished with no values.${job} If the schema uses manual setup, add the activated template name and extract again.`);
      return;
    }
    showMessage('positive', `Extraction ${result.status}.${job}`);
  }

  async function probe() {
    setBusy(true);
    try {
      const response = await fetch('/api/status?probe=1');
      const body = await readJson(response);
      renderConnection(body);
      showMessage('positive', `Connection succeeded. Token host ${body.tokenHost}.`);
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
  }

  async function readJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed (${response.status}).`);
    }
    return body;
  }
}());
