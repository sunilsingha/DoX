'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Module = require('module');
const sharp = require('sharp');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff']);
const OCR_ENGINE = 'paddleocr';
const OCR_MODEL = 'PP-OCRv4';
const MAX_SIDE = 2200;

class OcrError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'OcrError';
    this.status = status;
  }
}

let createEngine = defaultCreateEngine;
let enginePromise = null;

shimCanvasPackage();
ensureCanvasDom();

function isColourspaceError(error) {
  return /colourspace|colorspace|parameter space/i.test(error && error.message ? error.message : String(error || ''));
}

function inputModeFrom(value) {
  const mode = String(value || 'vision').trim().toLowerCase();
  if (mode === 'ocr' || mode === 'paddleocr' || mode === 'paddle' || mode === 'paddle-ocr') return 'ocr';
  if (mode === 'both' || mode === 'compare' || mode === 'ocr-vision') return 'both';
  return 'vision';
}

function frameTop(line) {
  if (line && line.frame && line.frame.top != null) return Number(line.frame.top) || 0;
  if (line && Array.isArray(line.box) && line.box[0]) return Number(line.box[0][1]) || 0;
  return 0;
}

function frameLeft(line) {
  if (line && line.frame && line.frame.left != null) return Number(line.frame.left) || 0;
  if (line && Array.isArray(line.box) && line.box[0]) return Number(line.box[0][0]) || 0;
  return 0;
}

function linesFromOcr(result) {
  const lines = Array.isArray(result) ? result : (result && result.texts) || [];
  return lines
    .slice()
    .sort((left, right) => frameTop(left) - frameTop(right) || frameLeft(left) - frameLeft(right))
    .map(item => String((item && item.text) || '').trim())
    .filter(Boolean)
    .join('\n');
}

function printedLines(items) {
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

function joinPageTexts(pages) {
  return (pages || [])
    .map(page => `Page ${page.number}\n${page.text || ''}`.trim())
    .join('\n\n');
}

function hasPrintedText(text) {
  return String(text || '').replace(/\s/g, '').length > 0;
}

function setCreateEngine(fn) {
  createEngine = fn || defaultCreateEngine;
  enginePromise = null;
}

function pixelSize(value, fallback) {
  const number = Math.round(Number(value));
  if (Number.isFinite(number) && number > 0) return number;
  return fallback;
}

function nodeCanvas(width, height) {
  const { createCanvas } = require('@napi-rs/canvas');
  return createCanvas(pixelSize(width, 1), pixelSize(height, 1));
}

function asByteBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data.buffer ? data : data);
}

function pngFromRgba(data, width, height) {
  width = pixelSize(width, 1);
  height = pixelSize(height, 1);
  const canvas = nodeCanvas(width, height);
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(width, height);
  imageData.data.set(asByteBuffer(data).subarray(0, width * height * 4));
  context.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

function rgbaFromRgb(data, width, height) {
  const source = asByteBuffer(data);
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = source[index * 3];
    rgba[index * 4 + 1] = source[index * 3 + 1];
    rgba[index * 4 + 2] = source[index * 3 + 2];
    rgba[index * 4 + 3] = 255;
  }
  return rgba;
}

function rgbaFromPacked(data, width, height) {
  const source = asByteBuffer(data);
  const rgba = Buffer.alloc(width * height * 4, 255);
  const packedWidth = Math.ceil(width / 8);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = source[y * packedWidth + (x >> 3)] || 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      const index = (y * width + x) * 4;
      const value = bit ? 0 : 255;
      rgba[index] = value;
      rgba[index + 1] = value;
      rgba[index + 2] = value;
    }
  }
  return rgba;
}

async function rgbaFromCanvasImage(buffer) {
  const { loadImage } = require('@napi-rs/canvas');
  const image = await loadImage(buffer);
  const canvas = nodeCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height);
  return { data: Buffer.from(pixels.data), width: image.width, height: image.height };
}

async function resizeRgba(image, size) {
  const sourceWidth = pixelSize(image.width, 1);
  const sourceHeight = pixelSize(image.height, 1);
  let width = size && size.width;
  let height = size && size.height;
  let fitContain = width != null && height != null;
  if (width == null && height == null) {
    width = sourceWidth;
    height = sourceHeight;
    fitContain = false;
  } else if (width == null) {
    height = pixelSize(height, sourceHeight);
    width = pixelSize(sourceWidth * (height / sourceHeight), 1);
    fitContain = false;
  } else if (height == null) {
    width = pixelSize(width, sourceWidth);
    height = pixelSize(sourceHeight * (width / sourceWidth), 1);
    fitContain = false;
  } else {
    width = pixelSize(width, sourceWidth);
    height = pixelSize(height, sourceHeight);
  }
  const png = pngFromRgba(image.data, sourceWidth, sourceHeight);
  const { loadImage } = require('@napi-rs/canvas');
  const loaded = await loadImage(png);
  const canvas = nodeCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  if (fitContain) {
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = Math.max(1, sourceWidth * scale);
    const drawHeight = Math.max(1, sourceHeight * scale);
    context.drawImage(loaded, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  } else {
    context.drawImage(loaded, 0, 0, width, height);
  }
  const pixels = context.getImageData(0, 0, width, height);
  return { data: Buffer.from(pixels.data), width, height };
}

function isRgbaImage(value) {
  return Boolean(value && value.data && value.width && value.height && !Buffer.isBuffer(value));
}

async function patchOcrImageRaw() {
  if (patchOcrImageRaw.done) return;
  patchOcrImageRaw.done = true;
  try {
    const file = path.join(path.dirname(require.resolve('@gutenye/ocr-node')), 'ImageRaw.js');
    const loaded = await import(pathToFileURL(file).href);
    const ImageRaw = loaded.ImageRaw;
    if (!ImageRaw || !ImageRaw.prototype) return;
    ImageRaw.open = async function open(filePath) {
      return new ImageRaw(await rgbaFromCanvasImage(await fs.promises.readFile(filePath)));
    };
    ImageRaw.prototype.resize = async function resize(size) {
      const next = await resizeRgba(this, size || {});
      this.data = next.data;
      this.width = next.width;
      this.height = next.height;
      return this;
    };
  } catch (error) {
    // OCR can still run if this resize patch cannot load.
  }
}

async function defaultCreateEngine() {
  const loaded = await import('@gutenye/ocr-node');
  await patchOcrImageRaw();
  const Ocr = loaded.default || loaded;
  return Ocr.create();
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = Promise.resolve()
      .then(() => createEngine())
      .catch(error => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
}

function kindFrom(buffer, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  if (extension === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (buffer && buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf';
  if (buffer && buffer.length >= 2 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image';
  if (buffer && buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image';
  throw new OcrError('Upload a PDF, PNG, JPEG, or TIFF invoice for PaddleOCR.', 400);
}

function ensureCanvasDom() {
  const canvas = require('@napi-rs/canvas');
  if (typeof globalThis.DOMMatrix === 'undefined' && canvas.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
  if (typeof globalThis.ImageData === 'undefined' && canvas.ImageData) globalThis.ImageData = canvas.ImageData;
  if (typeof globalThis.Path2D === 'undefined' && canvas.Path2D) globalThis.Path2D = canvas.Path2D;
  if (typeof globalThis.CanvasRenderingContext2D === 'undefined' && canvas.CanvasRenderingContext2D) {
    globalThis.CanvasRenderingContext2D = canvas.CanvasRenderingContext2D;
  }
}

function shimCanvasPackage() {
  if (Module._doxCanvasShim) return;
  Module._doxCanvasShim = true;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'canvas') return require('@napi-rs/canvas');
    return originalLoad.apply(this, arguments);
  };
}

async function rgbaFromEncoded(buffer) {
  try {
    return await rgbaFromCanvasImage(buffer);
  } catch (error) {
    const { data, info } = await sharp(buffer, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }
}

async function ocrImageBuffer(input) {
  const engine = await getEngine();
  const image = isRgbaImage(input) ? {
    data: asByteBuffer(input.data),
    width: input.width,
    height: input.height
  } : await rgbaFromEncoded(input);
  return linesFromOcr(await engine.detect(image));
}

class NodeCanvasFactory {
  create(width, height) {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, Math.ceil(width || 1)), Math.max(1, Math.ceil(height || 1)));
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = Math.max(1, Math.ceil(width || 1));
    canvasAndContext.canvas.height = Math.max(1, Math.ceil(height || 1));
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function loadPdfjs() {
  ensureCanvasDom();
  shimCanvasPackage();
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return require('pdfjs-dist/legacy/build/pdf.js');
  } catch (error) {
    throw new OcrError(`The PDF library failed to load (${error.message}).`, 500);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function loadPdf(buffer) {
  const pdfjs = loadPdfjs();
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const canvasFactory = new NodeCanvasFactory();
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    stopAtErrors: false,
    canvasFactory,
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`,
    cMapPacked: true
  }).promise;
}

async function renderPdfPage(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.4, MAX_SIDE / Math.max(base.width, base.height, 1));
  const viewport = page.getViewport({ scale });
  const canvasFactory = document.canvasFactory || new NodeCanvasFactory();
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  try {
    const context = canvasAndContext.context;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvasAndContext.canvas.width, canvasAndContext.canvas.height);
    await page.render({
      canvasContext: context,
      viewport,
      canvasFactory,
      background: '#ffffff'
    }).promise;
    const width = pixelSize(canvasAndContext.canvas.width, 1);
    const height = pixelSize(canvasAndContext.canvas.height, 1);
    const pixels = context.getImageData(0, 0, width, height);
    return { data: Buffer.from(pixels.data), width, height };
  } finally {
    canvasFactory.destroy(canvasAndContext);
  }
}

function waitForPdfObject(container, name) {
  if (!container || typeof container.get !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      container.get(name, data => resolve(data || null));
    } catch (error) {
      resolve(null);
    }
  });
}

async function embeddedPageImages(document, pageNumber) {
  const pdfjs = loadPdfjs();
  const page = await document.getPage(pageNumber);
  const ops = await page.getOperatorList();
  const names = [];
  for (let index = 0; index < ops.fnArray.length; index += 1) {
    const fn = ops.fnArray[index];
    if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject && fn !== pdfjs.OPS.paintImageXObjectRepeat) continue;
    const name = ops.argsArray[index] && ops.argsArray[index][0];
    if (typeof name === 'string' && !names.includes(name)) names.push(name);
  }
  const images = [];
  for (const name of names) {
    const img = (await waitForPdfObject(page.objs, name)) || (await waitForPdfObject(page.commonObjs, name));
    if (!img || !img.width || !img.height || !img.data) continue;
    images.push(img);
  }
  return images.sort((left, right) => (right.width * right.height) - (left.width * left.height));
}

function rgbaFromPdfImage(img) {
  const width = img.width;
  const height = img.height;
  const source = asByteBuffer(img.data);
  if (img.kind === 1 || (!img.kind && source.length < width * height)) {
    return { data: rgbaFromPacked(source, width, height), width, height };
  }
  const channels = img.kind === 2 ? 3 : 4;
  const expected = width * height * channels;
  if (source.length < expected) throw new Error('The embedded page image is incomplete.');
  const pixels = source.subarray(0, expected);
  return {
    data: channels === 3 ? rgbaFromRgb(pixels, width, height) : Buffer.from(pixels),
    width,
    height
  };
}

async function pngFromPdfImage(img) {
  const rgba = rgbaFromPdfImage(img);
  return pngFromRgba(rgba.data, rgba.width, rgba.height);
}

async function pdfPagePngs(buffer, pageNumber = 1) {
  const document = await loadPdf(buffer);
  return pagePngsFromPdf(document, pageNumber);
}

async function pagePngsFromPdf(document, pageNumber) {
  const images = await embeddedPageImages(document, pageNumber);
  const pngs = [];
  for (const img of images) {
    const area = img.width * img.height;
    if (img.kind !== 2 && img.kind !== 3) continue;
    if (area < 80 * 80) continue;
    pngs.push(await pngFromPdfImage(img));
  }
  if (pngs.length) return pngs;
  for (const img of images.slice(0, 2)) {
    try {
      pngs.push(await pngFromPdfImage(img));
    } catch (error) {
      // Try the next embedded image.
    }
  }
  return pngs;
}

async function ocrEmbeddedImages(document, pageNumber) {
  const images = await embeddedPageImages(document, pageNumber);
  const color = images.filter(img => img.kind === 2 || img.kind === 3);
  const candidates = (color.length ? color : images).slice(0, 2);
  let lastError = '';
  for (const img of candidates) {
    try {
      const text = await ocrImageBuffer(rgbaFromPdfImage(img));
      if (hasPrintedText(text)) return text;
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
  }
  if (lastError) throw new Error(lastError);
  return '';
}

async function pagePrintedText(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  return printedLines(content.items);
}

async function ocrPdf(buffer) {
  let document;
  try {
    document = await loadPdf(buffer);
  } catch (error) {
    throw new OcrError(error.message && /PaddleOCR|PDF library/.test(error.message)
      ? error.message
      : 'PaddleOCR could not open this PDF. Try Vision LLM.', 400);
  }
  const pageCount = document.numPages || 0;
  if (!pageCount) throw new OcrError('The PDF has no pages to read with PaddleOCR.', 400);
  const pageTexts = [];
  let lastError = '';
  for (let number = 1; number <= pageCount; number += 1) {
    const page = await readPdfPage(document, number);
    lastError = page.error || lastError;
    pageTexts.push({ number, text: page.text });
  }
  if (!pageTexts.some(page => hasPrintedText(page.text))) {
    throw new OcrError(publicOcrError(lastError), 400);
  }
  return {
    engine: OCR_ENGINE,
    model: OCR_MODEL,
    pages: pageTexts.length,
    pageCount: pageTexts.length,
    pageTexts,
    text: joinPageTexts(pageTexts)
  };
}

async function readPdfPage(document, number) {
  const attempts = [
    async () => {
      const png = await renderPdfPage(document, number);
      return ocrImageBuffer(png);
    },
    async () => ocrEmbeddedImages(document, number),
    async () => pagePrintedText(document, number)
  ];
  let lastError = '';
  for (const attempt of attempts) {
    try {
      const text = await attempt();
      if (hasPrintedText(text)) return { text, error: '' };
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
  }
  return { text: '', error: lastError };
}

function publicOcrError(detail) {
  if (isColourspaceError({ message: detail })) {
    return 'PaddleOCR could not convert this scanned page. Try Vision LLM.';
  }
  const text = String(detail || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'PaddleOCR did not read any text from this PDF. Try Vision LLM.';
  return `PaddleOCR did not read any text from this PDF. ${text} Try Vision LLM.`;
}

async function ocrDocument({ buffer, filename }) {
  if (!buffer || !buffer.length) throw new OcrError('Choose an invoice file first.', 400);
  const kind = kindFrom(buffer, filename);
  if (kind === 'pdf') return ocrPdf(buffer);
  const text = await ocrImageBuffer(buffer);
  return {
    engine: OCR_ENGINE,
    model: OCR_MODEL,
    pages: 1,
    pageCount: 1,
    pageTexts: [{ number: 1, text }],
    text: joinPageTexts([{ number: 1, text }])
  };
}

module.exports = {
  OcrError,
  inputModeFrom,
  linesFromOcr,
  joinPageTexts,
  printedLines,
  ocrDocument,
  setCreateEngine,
  ensureCanvasDom,
  pdfPagePngs,
  pngFromRgba,
  publicOcrError,
  resizeRgba
};
