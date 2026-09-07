import {
  DetectionTracker,
  RequestCoordinator,
  boundedCanonicalSize,
  buildAnalyzePayload,
  calculateCaptureQuality,
  calculateValueMetrics,
  coverMapping,
  displayPointToSource,
  formatApiError,
  formatCritique,
  isCanvasQuadCandidate,
  normalizedQuadArea,
  orderQuad,
} from './vision-core.mjs';

const $ = (selector) => document.querySelector(selector);
const video = $('#video');
const captureCanvas = $('#canvas');
const gridCanvas = $('#gridCanvas');
const overlayCanvas = $('#overlayCanvas');
const messages = $('#msgs');
const status = $('#status');
const counter = $('#counter');
const snapshotPreview = $('#snapshotPreview');
const coordinator = new RequestCoordinator();
const tracker = new DetectionTracker({ maxMisses: 3 });
const conversationHistory = [];

let stream = null;
let autoTimer = null;
let autoEnabled = false;
let detectionTimer = null;
let cvPollTimer = null;
let cvPromiseObserved = null;
let cvHookedObject = null;
let cvReady = false;
let autoDetect = false;
let manualQuad = null;
let dragging = -1;
let referenceImage = null;
let analysisCount = 0;
let voiceOn = false;
let previousImageBase64 = null;
let previousValueMetrics = null;
let previousCritique = null;
let pixelWorker = null;
let workerReady = false;

// ── Persistence helpers ──────────────────────────────────────────────
const DB_NAME = 'vision_profesor_db';
const DB_VERSION = 1;
const STORE_NAME = 'frame_cache';
const SETTINGS_KEY = 'vision_profesor_settings';

let _dbConnection = null;
function openDb() {
  if (_dbConnection) return Promise.resolve(_dbConnection);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => {
      _dbConnection = req.result;
      _dbConnection.onclose = () => { _dbConnection = null; };
      _dbConnection.onerror = () => { _dbConnection = null; };
      resolve(_dbConnection);
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Pixel Worker ─────────────────────────────────────────────────────
let _workerId = 0;
let _workerRetryDelay = 0;
const _workerPending = new Map(); // id → { resolve, timer }

function initPixelWorker() {
  try {
    pixelWorker = new Worker('/static/processor.worker.js');
    pixelWorker.onmessage = (event) => {
      const { id } = event.data;
      if (id === 0) { workerReady = true; _workerRetryDelay = 0; return; }
      const pending = _workerPending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      _workerPending.delete(id);
      pending.resolve(event.data.ok ? event.data : null);
    };
    pixelWorker.onerror = () => {
      workerReady = false;
      pixelWorker = null;
      _workerPending.clear();
      const delay = Math.min(_workerRetryDelay || 1000, 10000);
      _workerRetryDelay = delay * 2;
      setTimeout(() => { initPixelWorker(); }, delay);
    };
    pixelWorker.postMessage({ id: 0, warmup: true });
  } catch { workerReady = false; pixelWorker = null; }
}

function processPixelsViaWorker(imageData, canvasCoverage) {
  if (!pixelWorker || !workerReady) return null;
  const id = ++_workerId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _workerPending.delete(id); resolve(null); }, 3000);
    _workerPending.set(id, { resolve, timer });
    pixelWorker.postMessage({
      id,
      rgba: imageData.data.buffer,
      width: imageData.width,
      height: imageData.height,
      canvasCoverage,
    }, [imageData.data.buffer.slice(0)]);
  });
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      medium: $('#medium').value,
      stage: $('#stage').value,
      critiqueMode: $('#critiqueMode').value,
      style: $('#style').value,
      interval: $('#interval').value,
      voiceOn,
      analysisCount,
    }));
  } catch { /* quota exceeded — non-critical */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.medium) $('#medium').value = s.medium;
    if (s.stage) $('#stage').value = s.stage;
    if (s.critiqueMode) $('#critiqueMode').value = s.critiqueMode;
    if (s.style) $('#style').value = s.style;
    if (s.interval) $('#interval').value = s.interval;
    if (typeof s.voiceOn === 'boolean') { voiceOn = s.voiceOn; $('#speak').textContent = voiceOn ? 'Voz activa' : 'Voz'; }
    if (typeof s.analysisCount === 'number' && s.analysisCount > 0) { analysisCount = s.analysisCount; counter.textContent = `${analysisCount} análisis`; }
  } catch { /* corrupt data — ignore */ }
}

async function persistPreviousFrame(imageBase64, valueMetrics, critique) {
  try {
    await dbPut('prev_image', imageBase64);
    await dbPut('prev_metrics', valueMetrics);
    await dbPut('prev_critique', critique);
  } catch { /* non-critical */ }
}

async function restorePreviousFrame() {
  try {
    const [img, metrics, critique] = await Promise.all([
      dbGet('prev_image'), dbGet('prev_metrics'), dbGet('prev_critique'),
    ]);
    if (img) previousImageBase64 = img;
    if (metrics) previousValueMetrics = metrics;
    if (critique) previousCritique = critique;
  } catch { /* first load or empty — fine */ }
}

// ── Toast notifications ──────────────────────────────────────────────
function showToast(message, type = 'info', durationMs = 4000) {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.append(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ── Quality badge ────────────────────────────────────────────────────
function showQualityBadge(level, reason) {
  const container = $('#qualityBadgeContainer');
  const badge = $('#qualityBadge');
  if (level === 'ok' && !reason) { container.style.display = 'none'; return; }
  container.style.display = 'block';
  badge.className = `quality-badge quality-${level}`;
  badge.textContent = level === 'fail' ? reason : level === 'warn' ? `Atención: ${reason}` : 'Calidad OK';
  if (level !== 'fail') setTimeout(() => { container.style.display = 'none'; }, 5000);
}

const setStatus = (text) => { status.textContent = text; };

function addPedagogy(role, text) {
  if (!text) return;
  conversationHistory.push({ role, text });
  if (conversationHistory.length > 12) conversationHistory.shift();
  dbPut('conversation_history', conversationHistory).catch(() => {});
}

function restoreConversationHistory() {
  return dbGet('conversation_history').then((h) => {
    if (Array.isArray(h)) {
      conversationHistory.splice(0, conversationHistory.length, ...h);
    }
  }).catch(() => {});
}

function appendTextMessage(text, role = 'assistant') {
  const item = document.createElement('div');
  item.className = `msg ${role === 'user' ? 'user' : 'assistant'}`;
  item.textContent = text;
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function showStatusError(error) {
  const detail = typeof error?.message === 'string' ? error.message : 'No se pudo analizar la captura.';
  setStatus(detail);
}

function currentDisplayDimensions() {
  const rect = $('#videoWrap').getBoundingClientRect();
  return {
    sourceWidth: video.videoWidth,
    sourceHeight: video.videoHeight,
    displayWidth: rect.width,
    displayHeight: rect.height,
  };
}

function activeDisplayQuad() {
  return manualQuad || tracker.current();
}

function drawGrid() {
  const rect = $('#videoWrap').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  gridCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  gridCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  gridCanvas.style.width = `${rect.width}px`;
  gridCanvas.style.height = `${rect.height}px`;
  const context = gridCanvas.getContext('2d');
  context.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
  const quad = activeDisplayQuad();
  if (!quad) return;
  context.strokeStyle = 'rgba(74,222,128,.92)';
  context.lineWidth = 2 * dpr;
  context.beginPath();
  context.moveTo(quad[0].x * gridCanvas.width, quad[0].y * gridCanvas.height);
  quad.slice(1).forEach((point) => context.lineTo(point.x * gridCanvas.width, point.y * gridCanvas.height));
  context.closePath();
  context.stroke();
}

let overlayTimer = null;

const DIMENSION_COLORS = {
  drawing: '#ef4444', composition: '#f59e0b', shape: '#8b5cf6',
  value: '#3b82f6', color: '#ec4899', edges: '#10b981',
  handling: '#06b6d4', capture: '#6b7280',
};

function drawCorrectionOverlay(critique) {
  if (overlayTimer) clearTimeout(overlayTimer);
  const context = overlayCanvas.getContext('2d');
  const rect = $('#videoWrap').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  overlayCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  overlayCanvas.style.width = `${rect.width}px`;
  overlayCanvas.style.height = `${rect.height}px`;
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!critique?.corrections?.length) return;
  const corrections = critique.corrections.filter((c) => c.region);
  if (!corrections.length) return;
  corrections.forEach((correction, index) => {
    const r = correction.region;
    const color = DIMENSION_COLORS[correction.dimension] || '#e8d5b5';
    const x = r.x * overlayCanvas.width;
    const y = r.y * overlayCanvas.height;
    const w = r.width * overlayCanvas.width;
    const h = r.height * overlayCanvas.height;
    context.strokeStyle = color;
    context.lineWidth = 3 * dpr;
    context.setLineDash([6 * dpr, 4 * dpr]);
    context.strokeRect(x, y, w, h);
    context.setLineDash([]);
    context.fillStyle = color + '33';
    context.fillRect(x, y, w, h);
    const label = `${index + 1}. ${correction.dimension}`;
    context.font = `bold ${12 * dpr}px Inter, system-ui, sans-serif`;
    const textWidth = context.measureText(label).width;
    const pad = 4 * dpr;
    context.fillStyle = color;
    context.fillRect(x, y - 20 * dpr, textWidth + pad * 2, 20 * dpr);
    context.fillStyle = '#fff';
    context.fillText(label, x + pad, y - 6 * dpr);
  });
  overlayTimer = setTimeout(() => {
    context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  }, 8000);
}

function updateHandles() {
  const quad = activeDisplayQuad();
  [...document.querySelectorAll('.corner-handle')].forEach((handle, index) => {
    const point = quad?.[index];
    handle.classList.toggle('active', Boolean(point));
    if (point) {
      handle.style.left = `${point.x * 100}%`;
      handle.style.top = `${point.y * 100}%`;
    }
  });
  drawGrid();
}

function mapDisplayQuadToSource(displayQuad) {
  if (!displayQuad) return null;
  const dimensions = currentDisplayDimensions();
  try {
    return orderQuad(displayQuad.map((point) => displayPointToSource(point, dimensions)));
  } catch {
    throw new Error('La selección del lienzo no forma un cuadrilátero válido. Reubicá las cuatro esquinas.');
  }
}

function sourceQuadBounds(quad, width, height) {
  const xs = quad.map((point) => point.x * width);
  const ys = quad.map((point) => point.y * height);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys)));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function canonicalSize(quad, sourceWidth, sourceHeight) {
  const pixels = quad.map((point) => ({ x: point.x * sourceWidth, y: point.y * sourceHeight }));
  const distance = (first, second) => Math.hypot(second.x - first.x, second.y - first.y);
  return boundedCanonicalSize({
    width: Math.max(1, Math.round((distance(pixels[0], pixels[1]) + distance(pixels[3], pixels[2])) / 2)),
    height: Math.max(1, Math.round((distance(pixels[0], pixels[3]) + distance(pixels[1], pixels[2])) / 2)),
  });
}

function rectifyWithOpenCv(sourceCanvas, sourceQuad) {
  const cvApi = window.cv;
  const size = canonicalSize(sourceQuad, sourceCanvas.width, sourceCanvas.height);
  const sourceValues = sourceQuad.flatMap((point) => [
    point.x * (sourceCanvas.width - 1),
    point.y * (sourceCanvas.height - 1),
  ]);
  const destinationValues = [0, 0, size.width - 1, 0, size.width - 1, size.height - 1, 0, size.height - 1];
  const mats = [];
  try {
    const source = cvApi.imread(sourceCanvas); mats.push(source);
    const sourcePoints = cvApi.matFromArray(4, 1, cvApi.CV_32FC2, sourceValues); mats.push(sourcePoints);
    const destinationPoints = cvApi.matFromArray(4, 1, cvApi.CV_32FC2, destinationValues); mats.push(destinationPoints);
    const transform = cvApi.getPerspectiveTransform(sourcePoints, destinationPoints); mats.push(transform);
    const rectified = new cvApi.Mat(); mats.push(rectified);
    cvApi.warpPerspective(
      source,
      rectified,
      transform,
      new cvApi.Size(size.width, size.height),
      cvApi.INTER_LINEAR,
      cvApi.BORDER_REPLICATE,
    );
    captureCanvas.width = size.width;
    captureCanvas.height = size.height;
    cvApi.imshow(captureCanvas, rectified);
    return 'perspective_rectified';
  } finally {
    mats.reverse().forEach((mat) => mat?.delete?.());
  }
}

async function captureExactCanvas() {
  if (!stream || !video.videoWidth || !video.videoHeight) throw new Error('La cámara todavía no está lista.');
  const source = document.createElement('canvas');
  source.width = video.videoWidth;
  source.height = video.videoHeight;
  source.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
  const displayQuad = activeDisplayQuad();
  const cropSource = manualQuad ? 'manual' : displayQuad ? 'detected' : 'none';
  const cropConfidence = cropSource === 'manual' ? 'high' : cropSource === 'detected' ? 'medium' : 'low';
  const sourceQuad = mapDisplayQuadToSource(displayQuad);
  let cropMode;
  if (sourceQuad && cvReady && window.cv?.Mat) {
    cropMode = rectifyWithOpenCv(source, sourceQuad);
  } else if (sourceQuad) {
    const bounds = sourceQuadBounds(sourceQuad, source.width, source.height);
    const size = boundedCanonicalSize(bounds);
    captureCanvas.width = size.width;
    captureCanvas.height = size.height;
    captureCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
      source, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, size.width, size.height,
    );
    cropMode = 'axis_aligned_fallback';
  } else {
    const size = boundedCanonicalSize({ width: source.width, height: source.height });
    captureCanvas.width = size.width;
    captureCanvas.height = size.height;
    captureCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
      source, 0, 0, source.width, source.height, 0, 0, size.width, size.height,
    );
    cropMode = 'full_frame';
  }
  const context = captureCanvas.getContext('2d', { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
  const coverage = sourceQuad ? normalizedQuadArea(sourceQuad) : null;

  const workerResult = await processPixelsViaWorker(imageData, coverage);

  let valueMetrics;
  let imageBwBase64;
  if (workerResult) {
    valueMetrics = workerResult.valueMetrics;
    imageBwBase64 = workerResult.imageBwBase64;
  } else {
    valueMetrics = calculateValueMetrics(imageData.data, captureCanvas.width, captureCanvas.height, {
      canvasCoverage: coverage,
    });
    const blackAndWhite = document.createElement('canvas');
    blackAndWhite.width = captureCanvas.width;
    blackAndWhite.height = captureCanvas.height;
    const bwContext = blackAndWhite.getContext('2d', { willReadFrequently: true });
    const bwData = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    for (let offset = 0; offset < bwData.data.length; offset += 4) {
      const value = Math.round(0.299 * bwData.data[offset] + 0.587 * bwData.data[offset + 1] + 0.114 * bwData.data[offset + 2]);
      bwData.data[offset] = value;
      bwData.data[offset + 1] = value;
      bwData.data[offset + 2] = value;
    }
    bwContext.putImageData(bwData, 0, 0);
    imageBwBase64 = blackAndWhite.toDataURL('image/jpeg', 0.88);
  }

  const imageBase64 = captureCanvas.toDataURL('image/jpeg', 0.9);
  return {
    imageBase64,
    imageBwBase64,
    valueMetrics,
    captureMetadata: {
      crop_mode: cropMode,
      crop_source: cropSource,
      crop_confidence: cropConfidence,
      width: captureCanvas.width,
      height: captureCanvas.height,
      mime_type: 'image/jpeg',
    },
  };
}

function renderCritique(critique, response) {
  const card = document.createElement('article');
  card.className = 'msg assistant critique-card';
  formatCritique(critique).forEach(([label, text]) => {
    const section = document.createElement('section');
    const title = document.createElement('strong');
    const body = document.createElement('p');
    title.textContent = label;
    body.textContent = text;
    section.append(title, body);
    card.append(section);
  });
  if (Object.keys(critique.observations || {}).length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Lectura por dimensión';
    details.append(summary);
    Object.entries(critique.observations).forEach(([dimension, observation]) => {
      const item = document.createElement('p');
      item.textContent = `${dimension}: ${observation}`;
      details.append(item);
    });
    card.append(details);
  }
  const diagnostics = document.createElement('small');
  diagnostics.textContent = `Modelo ${response.model} · ${response.latency_ms} ms · ${response.prompt_version}`;
  card.append(diagnostics);
  messages.append(card);
  messages.scrollTop = messages.scrollHeight;
}

function responseError(body, fallback) {
  return new Error(body ? formatApiError(body, fallback) : `La API devolvió ${fallback}.`);
}

async function analyze({ prompt = null, source = 'manual' } = {}) {
  try {
    const result = await coordinator.request(async ({ signal }) => {
      const capture = await captureExactCanvas();
      const userPrompt = prompt ?? (source === 'manual' ? $('#prompt').value.trim() : '');
      const useReference = Boolean($('#useRef').checked && referenceImage);
      const payload = buildAnalyzePayload({
        capture,
        previous: previousImageBase64 ? {
          imageBase64: previousImageBase64,
          valueMetrics: previousValueMetrics,
          critique: previousCritique,
        } : null,
        reference: useReference ? {
          imageBase64: referenceImage,
          purpose: $('#referencePurpose').value || null,
        } : null,
        context: {
          user_prompt: userPrompt,
          medium: $('#medium').value,
          stage: $('#stage').value,
          intention: $('#intention').value.trim(),
          critique_mode: $('#critiqueMode').value,
          style: $('#style').value,
        },
        apiKey: $('#apikey').value.trim() || null,
        history: conversationHistory.slice(-12),
      });
      snapshotPreview.src = capture.imageBase64;
      snapshotPreview.hidden = false;
      const diagnostics = $('#captureDiagnostics');
      if (diagnostics) {
        const coverage = capture.valueMetrics.canvas_coverage;
        diagnostics.textContent = [
          `${capture.captureMetadata.width}×${capture.captureMetadata.height}`,
          capture.captureMetadata.crop_mode,
          `blur ${capture.valueMetrics.blur_estimate.toFixed(2)}`,
          coverage == null ? 'cobertura sin estimar' : `cobertura ${(coverage * 100).toFixed(0)}%`,
        ].join(' · ');
      }
      const quality = calculateCaptureQuality(capture.valueMetrics);
      showQualityBadge(quality.level, quality.reason);
      if (!quality.ok) { showToast(quality.reason, 'warn', 6000); throw new Error(quality.reason); }
      setStatus('analizando…');
      const request = await fetch('/api/analyze', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let body = null;
      try { body = await request.json(); } catch { /* handled below */ }
      if (!request.ok) throw responseError(body, request.status);
      return { body, capture, userPrompt };
    });
    if (result.stale || !result.value) return;
    const { body, capture, userPrompt } = result.value;
    if (userPrompt) {
      appendTextMessage(userPrompt, 'user');
      addPedagogy('user', userPrompt);
    }
    renderCritique(body.critique, body);
    drawCorrectionOverlay(body.critique);
    const modelText = body.critique.spoken_summary || body.critique.capture_problems?.join(' ') || '';
    addPedagogy('model', modelText);
    previousImageBase64 = capture.imageBase64;
    previousValueMetrics = capture.valueMetrics;
    previousCritique = body.critique;
    persistPreviousFrame(capture.imageBase64, capture.valueMetrics, body.critique);
    analysisCount += 1;
    counter.textContent = `${analysisCount} análisis`;
    saveSettings();
    setStatus('listo');
    if (voiceOn && modelText) try { speak(modelText); } catch { /* non-critical */ }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      showStatusError(error);
      showToast(error?.message || 'Error al analizar', 'error', 5000);
    }
  }
}

function detectCanvasQuad() {
  if (!cvReady || !window.cv?.Mat || !video.videoWidth) return null;
  const rect = $('#videoWrap').getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const mapping = coverMapping(currentDisplayDimensions());
  canvas.getContext('2d').drawImage(video, -mapping.offsetX, -mapping.offsetY, mapping.renderedWidth, mapping.renderedHeight);
  const mats = [];
  try {
    const source = window.cv.imread(canvas); mats.push(source);
    const gray = new window.cv.Mat(); mats.push(gray);
    const edges = new window.cv.Mat(); mats.push(edges);
    const hierarchy = new window.cv.Mat(); mats.push(hierarchy);
    const contours = new window.cv.MatVector(); mats.push(contours);
    window.cv.cvtColor(source, gray, window.cv.COLOR_RGBA2GRAY);
    window.cv.Canny(gray, edges, 50, 150);
    window.cv.findContours(edges, contours, hierarchy, window.cv.RETR_EXTERNAL, window.cv.CHAIN_APPROX_SIMPLE);
    let best = null;
    let bestArea = 0;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new window.cv.Mat();
      try {
        window.cv.approxPolyDP(contour, approximation, 0.02 * window.cv.arcLength(contour, true), true);
        const area = window.cv.contourArea(contour);
        if (approximation.rows === 4 && window.cv.isContourConvex(approximation) && area > bestArea) {
          const candidate = orderQuad(Array.from({ length: 4 }, (_, row) => ({
            x: approximation.data32S[row * 2] / canvas.width,
            y: approximation.data32S[row * 2 + 1] / canvas.height,
          })));
          if (isCanvasQuadCandidate(candidate, {
            displayWidth: canvas.width,
            displayHeight: canvas.height,
          })) {
            bestArea = area;
            best = candidate;
          }
        }
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    return best;
  } finally {
    mats.reverse().forEach((mat) => mat?.delete?.());
  }
}

function tickDetection() {
  if (!autoDetect) return;
  let quad = null;
  try {
    quad = detectCanvasQuad();
  } catch {
    $('#detectStatus').textContent = 'Falló la detección; usá selección manual';
  }
  if (quad) {
    tracker.hit(quad);
    $('#detectStatus').textContent = 'Lienzo detectado';
  } else {
    tracker.miss();
    if (!tracker.current()) $('#detectStatus').textContent = 'Buscando lienzo';
  }
  updateHandles();
}

function startCamera() {
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
    .then((nextStream) => {
      stream = nextStream;
      video.srcObject = stream;
      setStatus('cámara activa');
      video.addEventListener('loadeddata', updateHandles, { once: true });
    })
    .catch((error) => showStatusError(error));
}

function speak(text) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-AR';
    utterance.onerror = (e) => console.warn('speechSynthesis error', e.error);
    window.speechSynthesis.speak(utterance);
  } catch (err) { console.warn('speak() failed', err); }
}

function checkHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  fetch('/api/health', { signal: controller.signal })
    .then((response) => { clearTimeout(timer); return response.json(); })
    .then((body) => { $('#health').textContent = body.has_env_key ? `configurado · ${body.model}` : 'sin clave de entorno'; })
    .catch(() => { clearTimeout(timer); $('#health').textContent = 'sin conexión'; });
}

function stopAuto(message = 'auto detenido') {
  autoEnabled = false;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  coordinator.cancel();
  $('#toggleAuto').textContent = 'Auto';
  if (message) setStatus(message);
}

async function runAutoCycle(interval) {
  if (!autoEnabled) return;
  if (!coordinator.busy) await analyze({ source: 'auto' });
  if (!autoEnabled) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    runAutoCycle(interval);
  }, interval);
}

function clearOpenCvPoll() {
  if (cvPollTimer) clearInterval(cvPollTimer);
  cvPollTimer = null;
}

function finishOpenCvFallback(message) {
  clearOpenCvPoll();
  if (!cvReady) $('#detectStatus').textContent = message;
}

function markOpenCvReady(api) {
  if (!api?.Mat) return false;
  window.cv = api;
  cvReady = true;
  clearOpenCvPoll();
  $('#detectStatus').textContent = 'OpenCV listo';
  return true;
}

function inspectOpenCvCandidate() {
  const candidate = window.cv;
  if (markOpenCvReady(candidate)) return true;
  if (candidate && typeof candidate.then === 'function') {
    if (cvPromiseObserved !== candidate) {
      cvPromiseObserved = candidate;
      const p = candidate.then((api) => markOpenCvReady(api));
      if (typeof p?.catch === 'function') p.catch(() => {
        finishOpenCvFallback('OpenCV no disponible; se usará recorte rectangular');
      });
    }
    return false;
  }
  if (candidate && typeof candidate === 'object' && cvHookedObject !== candidate) {
    cvHookedObject = candidate;
    const previousReady = candidate.onRuntimeInitialized;
    candidate.onRuntimeInitialized = () => {
      if (typeof previousReady === 'function') previousReady();
      markOpenCvReady(candidate);
    };
  }
  return false;
}

function initializeOpenCv() {
  if (inspectOpenCvCandidate()) return;
  clearOpenCvPoll();
  let attempts = 0;
  cvPollTimer = setInterval(() => {
    attempts += 1;
    if (inspectOpenCvCandidate()) return;
    if (attempts >= 80) {
      finishOpenCvFallback('OpenCV no disponible; se usará recorte rectangular');
    }
  }, 100);
}

$('#startCam').addEventListener('click', startCamera);
$('#capture').addEventListener('click', () => analyze());
$('#send').addEventListener('click', () => {
  const prompt = $('#chatInput').value.trim();
  if (!prompt) return;
  $('#chatInput').value = '';
  analyze({ prompt, source: 'chat' });
});
$('#chatInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#send').click();
});
$('#clear').addEventListener('click', () => {
  stopAuto('auto detenido');
  messages.replaceChildren();
  conversationHistory.splice(0);
  dbPut('conversation_history', []).catch(() => {});
  previousImageBase64 = null;
  previousValueMetrics = null;
  previousCritique = null;
  analysisCount = 0;
  counter.textContent = '0 análisis';
  dbClear().catch(() => {});
  saveSettings();
  if (overlayTimer) clearTimeout(overlayTimer);
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  showToast('Sesión reiniciada', 'ok', 2000);
});
$('#toggleAuto').addEventListener('click', () => {
  if (autoEnabled) {
    stopAuto('auto detenido');
    return;
  }
  const interval = Number.parseInt($('#interval').value, 10);
  if (!interval || !stream) {
    setStatus(!stream ? 'activá la cámara primero' : 'elegí un intervalo automático');
    return;
  }
  autoEnabled = true;
  $('#toggleAuto').textContent = 'Pausar auto';
  $('#pauseAuto').hidden = false;
  runAutoCycle(interval);
});
$('#pauseAuto').addEventListener('click', () => {
  if (!autoEnabled) return;
  stopAuto('auto pausado');
  $('#pauseAuto').hidden = true;
  showToast('Auto pausado. Podés analizar manualmente.', 'info', 3000);
});
$('#retake').addEventListener('click', async () => {
  if (!stream) { showToast('Activá la cámara primero', 'warn'); return; }
  try {
    const capture = await captureExactCanvas();
    snapshotPreview.src = capture.imageBase64;
    snapshotPreview.hidden = false;
    showToast('Frame retomado. Ahora podés analizar.', 'ok', 2000);
    const quality = calculateCaptureQuality(capture.valueMetrics);
    showQualityBadge(quality.level, quality.reason);
  } catch (e) {
    showToast(e.message || 'No se pudo retomar', 'error');
  }
});
$('#speak').addEventListener('click', () => {
  voiceOn = !voiceOn;
  $('#speak').textContent = voiceOn ? 'Voz activa' : 'Voz';
  saveSettings();
});
['medium', 'stage', 'critiqueMode', 'style', 'interval'].forEach((id) => {
  $(`#${id}`).addEventListener('change', saveSettings);
});
$('#saveKey').addEventListener('click', () => sessionStorage.setItem('gemini_key', $('#apikey').value.trim()));
$('#apikey').value = sessionStorage.getItem('gemini_key') || '';
$('#refInput').addEventListener('change', () => {
  const file = $('#refInput').files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    referenceImage = reader.result;
    $('#refPreview').src = referenceImage;
    $('#refPreview').hidden = false;
    $('#clearRef').hidden = false;
  });
  reader.readAsDataURL(file);
});
$('#clearRef').addEventListener('click', () => {
  referenceImage = null;
  $('#refInput').value = '';
  $('#refPreview').hidden = true;
  $('#clearRef').hidden = true;
});
$('#toggleDetect').addEventListener('click', () => {
  autoDetect = !autoDetect;
  $('#toggleDetect').textContent = autoDetect ? 'Auto activo' : 'Auto';
  clearInterval(detectionTimer);
  if (autoDetect) {
    detectionTimer = setInterval(tickDetection, 700);
    tickDetection();
  }
});
$('#selectManual').addEventListener('click', () => {
  manualQuad = activeDisplayQuad() || [
    { x: 0.12, y: 0.12 }, { x: 0.88, y: 0.12 }, { x: 0.88, y: 0.88 }, { x: 0.12, y: 0.88 },
  ];
  updateHandles();
});
$('#confirmManual').addEventListener('click', () => {
  if (!manualQuad) return;
  try {
    manualQuad = orderQuad(manualQuad);
    setStatus('selección de lienzo confirmada');
  } catch {
    setStatus('La selección no es válida; separá y ordená las cuatro esquinas.');
  }
  updateHandles();
});
$('#resetCorners').addEventListener('click', () => {
  manualQuad = null;
  for (let misses = 0; misses < tracker.maxMisses; misses += 1) tracker.miss();
  updateHandles();
});
[...document.querySelectorAll('.corner-handle')].forEach((handle, index) => {
  handle.addEventListener('pointerdown', (event) => {
    dragging = index;
    handle.setPointerCapture(event.pointerId);
    manualQuad = activeDisplayQuad() || [
      { x: 0.12, y: 0.12 }, { x: 0.88, y: 0.12 }, { x: 0.88, y: 0.88 }, { x: 0.12, y: 0.88 },
    ];
  });
  handle.addEventListener('pointermove', (event) => {
    if (dragging !== index) return;
    const rect = $('#videoWrap').getBoundingClientRect();
    manualQuad[index] = {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
    updateHandles();
  });
  const finishDrag = () => { dragging = -1; };
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowLeft: { x: -step }, ArrowRight: { x: step }, ArrowUp: { y: -step }, ArrowDown: { y: step } };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    manualQuad = activeDisplayQuad() || [
      { x: 0.12, y: 0.12 }, { x: 0.88, y: 0.12 }, { x: 0.88, y: 0.88 }, { x: 0.12, y: 0.88 },
    ];
    manualQuad[index] = {
      x: Math.min(1, Math.max(0, (manualQuad[index].x || 0.5) + (d.x || 0))),
      y: Math.min(1, Math.max(0, (manualQuad[index].y || 0.5) + (d.y || 0))),
    };
    handle.setAttribute('aria-valuetext', `x ${manualQuad[index].x.toFixed(2)}, y ${manualQuad[index].y.toFixed(2)}`);
    updateHandles();
  });
});
$('#opencv-js').addEventListener('load', initializeOpenCv);
$('#opencv-js').addEventListener('error', () => finishOpenCvFallback('OpenCV no disponible; se usará recorte rectangular'));
window.addEventListener('resize', updateHandles);

// ── #8 Pause detection + auto-capture timer when tab is backgrounded ─
let _autoDetectBeforeHidden = false;
let _autoEnabledBeforeHidden = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    _autoDetectBeforeHidden = autoDetect;
    if (autoDetect) clearInterval(detectionTimer);
    _autoEnabledBeforeHidden = autoEnabled;
    if (autoEnabled && autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  } else {
    if (_autoDetectBeforeHidden && autoDetect) {
      detectionTimer = setInterval(tickDetection, 700);
    }
    if (_autoEnabledBeforeHidden && autoEnabled) {
      const interval = Number.parseInt($('#interval').value, 10) || 12000;
      autoTimer = setTimeout(() => { autoTimer = null; runAutoCycle(interval); }, 2000);
    }
  }
});
initializeOpenCv();
initPixelWorker();
checkHealth();
loadSettings();
restorePreviousFrame().then(() => {
  if (previousCritique) showToast('Estado anterior restaurado', 'ok', 2500);
}).catch(() => {});
restoreConversationHistory().catch(() => {});
