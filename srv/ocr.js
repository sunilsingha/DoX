'use strict';

const path = require('path');
const sharp = require('sharp');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff']);
const OCR_ENGINE = 'paddleocr';
const OCR_MODEL = 'PP-OCRv4';
const MAX_SIDE = 1800;

class OcrError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'OcrError';
    this.status = status;
  }
}

let createEngine = defaultCreateEngine;
let enginePromise = null;

function inputModeFrom(value) {
  const mode = String(value || 'vision').trim().toLowerCase();
  if (mode === 'ocr' || mode === 'paddleocr' || mode === 'paddle' || mode === 'paddle-ocr') return 'ocr';
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

function joinPageTexts(pages) {
  return (pages || [])
    .map(page => `Page ${page.number}\n${page.text || ''}`.trim())
    .join('\n\n');
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
  if (!enginePromise) enginePromise = Promise.resolve().then(() => createEngine());
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

async function toRawRgba(buffer) {
  const { data, info } = await sharp(buffer).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function ocrImageBuffer(buffer) {
  const engine = await getEngine();
  const image = await toRawRgba(buffer);
  return linesFromOcr(await engine.detect(image));
}

function ensureCanvasDom() {
  const canvas = require('@napi-rs/canvas');
  if (typeof global.DOMMatrix === 'undefined' && canvas.DOMMatrix) global.DOMMatrix = canvas.DOMMatrix;
  if (typeof global.ImageData === 'undefined' && canvas.ImageData) global.ImageData = canvas.ImageData;
  if (typeof global.Path2D === 'undefined' && canvas.Path2D) global.Path2D = canvas.Path2D;
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
  const log = console.log;
  console.log = () => {};
  try {
    return require('pdfjs-dist/legacy/build/pdf.js');
  } catch (error) {
    throw new OcrError(`The PDF library failed to load (${error.message}).`, 500);
  } finally {
    console.log = log;
  }
}

async function loadPdf(buffer) {
  ensureCanvasDom();
  const pdfjs = loadPdfjs();
  const fontDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts');
  const canvasFactory = new NodeCanvasFactory();
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    canvasFactory,
    standardFontDataUrl: `${fontDir}${path.sep}`
  }).promise;
}

async function renderPdfPage(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_SIDE / Math.max(base.width, base.height, 1));
  const viewport = page.getViewport({ scale });
  const canvasFactory = new NodeCanvasFactory();
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  try {
    await page.render({
      canvasContext: canvasAndContext.context,
      viewport,
      canvasFactory
    }).promise;
    const width = canvasAndContext.canvas.width;
    const height = canvasAndContext.canvas.height;
    const imageData = canvasAndContext.context.getImageData(0, 0, width, height);
    return { data: Buffer.from(imageData.data), width, height };
  } finally {
    canvasFactory.destroy(canvasAndContext);
  }
}

async function ocrPdf(buffer) {
  let document;
  try {
    document = await loadPdf(buffer);
  } catch (error) {
    throw new OcrError('PaddleOCR could not open this PDF. Try Vision LLM.', 400);
  }
  const pageCount = document.numPages || 0;
  if (!pageCount) throw new OcrError('The PDF has no pages to read with PaddleOCR.', 400);
  const pageTexts = [];
  for (let number = 1; number <= pageCount; number += 1) {
    let text = '';
    try {
      const image = await renderPdfPage(document, number);
      const engine = await getEngine();
      text = linesFromOcr(await engine.detect(image));
    } catch (error) {
      text = '';
    }
    pageTexts.push({ number, text });
  }
  if (!pageTexts.some(page => String(page.text || '').replace(/\s/g, '').length)) {
    throw new OcrError('PaddleOCR did not read any text from this PDF. Try Vision LLM.', 400);
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
  ocrDocument,
  setCreateEngine
};
