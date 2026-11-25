'use strict';

const path = require('path');
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

async function defaultCreateEngine() {
  const loaded = await import('@gutenye/ocr-node');
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

async function toRawRgba(buffer) {
  const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function ocrImageBuffer(buffer) {
  const engine = await getEngine();
  const image = await toRawRgba(buffer);
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
    return canvasAndContext.canvas.toBuffer('image/png');
  } finally {
    canvasFactory.destroy(canvasAndContext);
  }
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
    let text = '';
    try {
      const png = await renderPdfPage(document, number);
      text = await ocrImageBuffer(png);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }
    if (!hasPrintedText(text)) {
      try {
        text = await pagePrintedText(document, number);
      } catch (error) {
        lastError = lastError || (error && error.message ? error.message : String(error));
      }
    }
    pageTexts.push({ number, text });
  }
  if (!pageTexts.some(page => hasPrintedText(page.text))) {
    const detail = lastError ? ` ${lastError}` : '';
    throw new OcrError(`PaddleOCR did not read any text from this PDF.${detail} Try Vision LLM.`.trim(), 400);
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
  ensureCanvasDom
};
