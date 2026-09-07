/** Pure geometry, capture metrics, request state, and safe critique presentation. */

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

export function coverMapping({ sourceWidth, sourceHeight, displayWidth, displayHeight }) {
  if (![sourceWidth, sourceHeight, displayWidth, displayHeight].every((value) => value > 0)) {
    throw new RangeError('source and display dimensions must be positive');
  }
  const scale = Math.max(displayWidth / sourceWidth, displayHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  return {
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: (renderedWidth - displayWidth) / 2,
    offsetY: (renderedHeight - displayHeight) / 2,
  };
}

export function displayPointToSource(point, dimensions) {
  const mapping = coverMapping(dimensions);
  const displayX = clamp(point.x) * dimensions.displayWidth;
  const displayY = clamp(point.y) * dimensions.displayHeight;
  return {
    x: clamp((displayX + mapping.offsetX) / mapping.renderedWidth),
    y: clamp((displayY + mapping.offsetY) / mapping.renderedHeight),
  };
}

export function clampNormalizedRegion(region) {
  const x = clamp(region?.x);
  const y = clamp(region?.y);
  const clean = (value) => Math.round(value * 1e12) / 1e12;
  return {
    x,
    y,
    width: clean(clamp(region?.width, 0, 1 - x)),
    height: clean(clamp(region?.height, 0, 1 - y)),
  };
}

const QUAD_EPSILON = 1e-7;
const MIN_NORMALIZED_QUAD_AREA = 1e-4;

function signedPolygonArea(points) {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea / 2;
}

function cross(first, second, third) {
  return (second.x - first.x) * (third.y - second.y)
    - (second.y - first.y) * (third.x - second.x);
}

export function orderQuad(points) {
  if (!Array.isArray(points) || points.length !== 4) {
    throw new TypeError('a quad requires exactly four points');
  }
  if (!points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
    throw new TypeError('quad points must be finite');
  }
  const normalized = points.map((point) => ({ x: clamp(point.x), y: clamp(point.y) }));
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (Math.hypot(
        normalized[left].x - normalized[right].x,
        normalized[left].y - normalized[right].y,
      ) <= QUAD_EPSILON) throw new RangeError('quad points must be unique');
    }
  }
  const center = normalized.reduce(
    (total, point) => ({ x: total.x + point.x / 4, y: total.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const aroundCenter = normalized.sort(
    (left, right) => Math.atan2(left.y - center.y, left.x - center.x)
      - Math.atan2(right.y - center.y, right.x - center.x),
  );
  if (Math.abs(signedPolygonArea(aroundCenter)) < MIN_NORMALIZED_QUAD_AREA) {
    throw new RangeError('quad area is too small');
  }
  const turns = aroundCenter.map((point, index) => cross(
    point,
    aroundCenter[(index + 1) % 4],
    aroundCenter[(index + 2) % 4],
  ));
  if (turns.some((turn) => Math.abs(turn) <= QUAD_EPSILON)
      || !(turns.every((turn) => turn > 0) || turns.every((turn) => turn < 0))) {
    throw new RangeError('quad must be convex and non-self-intersecting');
  }
  let start = 0;
  for (let index = 1; index < aroundCenter.length; index += 1) {
    const candidate = aroundCenter[index];
    const current = aroundCenter[start];
    const candidateScore = candidate.x + candidate.y;
    const currentScore = current.x + current.y;
    if (candidateScore < currentScore
        || (candidateScore === currentScore && candidate.x < current.x)) start = index;
  }
  let rotated = [...aroundCenter.slice(start), ...aroundCenter.slice(0, start)];
  if (signedPolygonArea(rotated) < 0) {
    rotated = [rotated[0], rotated[3], rotated[2], rotated[1]];
  }
  return rotated;
}

export function normalizedQuadArea(points) {
  return Math.abs(signedPolygonArea(orderQuad(points)));
}

export function isCanvasQuadCandidate(
  points,
  { displayWidth = 4, displayHeight = 3, minArea = 0.08, maxArea = 0.92 } = {},
) {
  try {
    const quad = orderQuad(points);
    const area = Math.abs(signedPolygonArea(quad));
    if (area < minArea || area > maxArea) return false;
    const distance = (first, second) => Math.hypot(
      (second.x - first.x) * displayWidth,
      (second.y - first.y) * displayHeight,
    );
    const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
    const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
    const ratio = Math.min(width, height) / Math.max(width, height);
    return ratio >= 0.58 && ratio <= 0.92;
  } catch {
    return false;
  }
}

export function boundedCanonicalSize(
  size,
  { minDimension = 96, maxDimension = 2048, maxPixels = 4_000_000 } = {},
) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!(width > 0) || !(height > 0)) throw new RangeError('canonical dimensions must be positive');
  const minimumScale = minDimension / Math.min(width, height);
  const maximumScale = Math.min(
    maxDimension / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  if (minimumScale > maximumScale) throw new RangeError('canonical aspect ratio exceeds output bounds');
  const scale = Math.min(maximumScale, Math.max(minimumScale, 1));
  return {
    width: Math.max(minDimension, Math.floor(width * scale)),
    height: Math.max(minDimension, Math.floor(height * scale)),
  };
}

function histogramPercentile(histogram, total, percentileValue) {
  const target = Math.max(1, Math.ceil(total * percentileValue));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value];
    if (cumulative >= target) return value / 255;
  }
  return 1;
}

export function calculateValueMetrics(rgba, width, height, { canvasCoverage = null } = {}) {
  if (!(rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) {
    throw new TypeError('RGBA data must match the supplied dimensions');
  }
  const luminance = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  let sum = 0;
  let clippedDark = 0;
  let clippedLight = 0;
  for (let pixel = 0, offset = 0; pixel < luminance.length; pixel += 1, offset += 4) {
    const value = Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]);
    luminance[pixel] = value;
    histogram[value] += 1;
    sum += value;
    if (value <= 5) clippedDark += 1;
    if (value >= 250) clippedLight += 1;
  }
  let laplacianSum = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      laplacianSum += Math.abs(
        4 * luminance[index] - luminance[index - 1] - luminance[index + 1]
        - luminance[index - width] - luminance[index + width],
      );
      laplacianCount += 1;
    }
  }
  const sharpness = laplacianCount ? laplacianSum / laplacianCount / 1020 : 0;
  return {
    p10: histogramPercentile(histogram, luminance.length, 0.1),
    median: histogramPercentile(histogram, luminance.length, 0.5),
    p90: histogramPercentile(histogram, luminance.length, 0.9),
    mean: sum / luminance.length / 255,
    clipped_dark_pct: clippedDark / luminance.length,
    clipped_light_pct: clippedLight / luminance.length,
    canvas_coverage: Number.isFinite(canvasCoverage) ? clamp(canvasCoverage) : null,
    blur_estimate: clamp(1 - sharpness),
  };
}

export class DetectionTracker {
  constructor({ maxMisses = 3 } = {}) {
    this.maxMisses = Math.max(1, Math.floor(maxMisses));
    this.quad = null;
    this.misses = 0;
  }

  hit(quad) {
    this.quad = orderQuad(quad);
    this.misses = 0;
    return this.current();
  }

  miss() {
    if (!this.quad) return null;
    this.misses += 1;
    if (this.misses >= this.maxMisses) this.quad = null;
    return this.current();
  }

  current() {
    return this.quad?.map((point) => ({ ...point })) ?? null;
  }
}

export class RequestCoordinator {
  constructor() {
    this.latestId = 0;
    this.generation = 0;
    this.active = null;
    this.pending = null;
  }

  get busy() {
    return Boolean(this.active || this.pending);
  }

  request(work) {
    const entry = {
      id: ++this.latestId,
      generation: this.generation,
      work,
      controller: new AbortController(),
    };
    if (this.active) {
      this.active.controller.abort();
      if (this.pending) this.pending.resolve({ id: this.pending.id, stale: true, value: null });
      return new Promise((resolve, reject) => {
        this.pending = { ...entry, resolve, reject };
      });
    }
    return this.#run(entry);
  }

  isCurrent(id) {
    return id === this.latestId;
  }

  cancel() {
    this.generation += 1;
    this.latestId += 1;
    this.active?.controller.abort();
    if (this.pending) {
      this.pending.controller.abort();
      this.pending.resolve({ id: this.pending.id, stale: true, value: null });
      this.pending = null;
    }
    return this.generation;
  }

  async #run(entry) {
    this.active = entry;
    try {
      const value = await entry.work({
        id: entry.id,
        generation: entry.generation,
        signal: entry.controller.signal,
      });
      return {
        id: entry.id,
        stale: entry.generation !== this.generation || !this.isCurrent(entry.id),
        value,
      };
    } finally {
      if (this.active?.id === entry.id) this.active = null;
      const next = this.pending;
      this.pending = null;
      if (next) {
        this.#run(next).then(next.resolve, next.reject);
      }
    }
  }
}

const confidenceLabels = { low: 'Baja', medium: 'Media', high: 'Alta' };

function joinSentences(values) {
  return values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .map((value) => /[.!?]$/.test(value) ? value : `${value}.`)
    .join(' ');
}

function correctionSections(correction, prefix = '') {
  const label = (value) => prefix ? `${prefix} · ${value}` : value;
  const location = typeof correction?.location === 'string' ? correction.location.trim() : '';
  const evidence = joinSentences([correction?.evidence, correction?.consequence]);
  const reading = location && evidence ? `${location}: ${evidence}` : evidence || location;
  const action = joinSentences([
    correction?.action,
    correction?.amount ? `Cantidad: ${correction.amount}` : '',
    correction?.mixture ? `Mezcla o herramienta: ${correction.mixture}` : '',
  ]);
  const confidence = confidenceLabels[correction?.confidence] || '';
  return [
    [label('Leé'), reading],
    [label('Actuá'), action],
    [label('Comprobá'), typeof correction?.verification === 'string' ? correction.verification.trim() : ''],
    [label('Confianza'), confidence],
  ].filter(([, value]) => value);
}

export function formatCritique(critique) {
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  if (!critique?.frame_usable) {
    return [
      ['Problemas de captura', (critique?.capture_problems || []).map(text).filter(Boolean).join(' ')],
      ['Recapturá', text(critique?.spoken_summary)],
    ].filter(([, value]) => value);
  }
  return [
    ['Preservá', text(critique?.strength)],
    ...correctionSections(critique?.corrections?.[0]),
    ...correctionSections(critique?.corrections?.[1], 'Después'),
    ['Resumen', text(critique?.spoken_summary)],
  ].filter(([, value]) => value);
}

export function formatApiError(body, status) {
  const detail = body?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const field = typeof detail.field === 'string' ? detail.field : '';
    const reason = typeof detail.reason === 'string' ? detail.reason : '';
    if (field || reason) return [field, reason].filter(Boolean).join(': ');
  }
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const location = Array.isArray(item?.loc) ? item.loc.join('.') : '';
      const message = typeof item?.msg === 'string' ? item.msg : '';
      return [location, message].filter(Boolean).join(': ');
    }).filter(Boolean);
    if (messages.length) return messages.join('; ');
  }
  return `La API devolvió ${status}.`;
}

export function buildAnalyzePayload({
  capture,
  previous = null,
  reference = null,
  context = {},
  history = [],
  apiKey = null,
} = {}) {
  if (!capture?.imageBase64) {
    throw new Error('La captura actual no está disponible.');
  }

  const payload = {
    image_base64: capture.imageBase64,
    ...context,
    history: Array.isArray(history) ? history : [],
  };

  if (capture.imageBwBase64) payload.image_bw_base64 = capture.imageBwBase64;
  if (capture.valueMetrics) payload.value_metrics = capture.valueMetrics;
  if (capture.captureMetadata) payload.capture_metadata = capture.captureMetadata;
  if (apiKey) payload.api_key = apiKey;

  if (previous?.imageBase64) {
    payload.previous_image_base64 = previous.imageBase64;
    if (previous.valueMetrics) payload.previous_value_metrics = previous.valueMetrics;
    if (previous.critique) payload.previous_critique = previous.critique;
  }

  if (reference?.imageBase64) {
    payload.image_ref_base64 = reference.imageBase64;
    if (reference.purpose) payload.reference_purpose = reference.purpose;
  }

  return payload;
}

/**
 * Local quality gate: check if captured frame is usable before sending to API.
 * Returns { ok, reason, level } where level is 'ok'|'warn'|'fail'.
 */
export function calculateCaptureQuality(valueMetrics) {
  if (!valueMetrics) return { ok: true, reason: '', level: 'ok' };
  const mean = valueMetrics.mean ?? 0.5;
  const blur = valueMetrics.blur_estimate ?? 0;
  const coverage = valueMetrics.canvas_coverage;
  const clippedDark = valueMetrics.clipped_dark_pct ?? 0;
  const clippedLight = valueMetrics.clipped_light_pct ?? 0;

  if (mean < 0.08) return { ok: false, reason: 'Imagen demasiado oscura. Encendí la luz o revisá la cámara.', level: 'fail' };
  if (mean > 0.95) return { ok: false, reason: 'Imagen sobreexpuesta. Bajá la luz o revisá la cámara.', level: 'fail' };
  if (blur > 0.85) return { ok: false, reason: 'Imagen muy borrosa. Enfocá la cámara sobre el lienzo.', level: 'fail' };
  if (clippedDark > 0.35) return { ok: false, reason: 'Demasiadas zonas negras. Revisá iluminación y encuadre.', level: 'fail' };
  if (clippedLight > 0.35) return { ok: false, reason: 'Demasiadas zonas quemadas. Bajá la luz.', level: 'fail' };

  const warnings = [];
  if (mean < 0.15) warnings.push('poca luz');
  if (mean > 0.88) warnings.push('mucha luz');
  if (blur > 0.7) warnings.push('posible desenfoque');
  if (coverage != null && coverage < 0.15) warnings.push('lienzo pequeño en encuadre');

  if (warnings.length) return { ok: true, reason: warnings.join(', '), level: 'warn' };
  return { ok: true, reason: '', level: 'ok' };
}
