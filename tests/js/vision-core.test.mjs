import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DetectionTracker,
  RequestCoordinator,
  calculateValueMetrics,
  clampNormalizedRegion,
  displayPointToSource,
  formatCritique,
  orderQuad,
} from '../../static/vision-core.mjs';
import * as core from '../../static/vision-core.mjs';

test('maps a covered 16:9 video into a 4:3 preview', () => {
  const point = displayPointToSource(
    { x: 0, y: 0.5 },
    { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 800, displayHeight: 600 },
  );

  assert.ok(Math.abs(point.x - 0.125) < 0.001);
  assert.equal(point.y, 0.5);
});

test('clamps mapped points and normalized regions inside the source canvas', () => {
  const point = displayPointToSource(
    { x: -0.2, y: 1.4 },
    { sourceWidth: 640, sourceHeight: 480, displayWidth: 640, displayHeight: 480 },
  );

  assert.deepEqual(point, { x: 0, y: 1 });
  assert.deepEqual(
    clampNormalizedRegion({ x: 0.9, y: -0.2, width: 0.5, height: 0.4 }),
    { x: 0.9, y: 0, width: 0.1, height: 0.4 },
  );
});

test('orders a shuffled perspective quad as top-left, top-right, bottom-right, bottom-left', () => {
  const ordered = orderQuad([
    { x: 0.8, y: 0.9 },
    { x: 0.2, y: 0.1 },
    { x: 0.85, y: 0.15 },
    { x: 0.1, y: 0.8 },
  ]);

  assert.deepEqual(ordered, [
    { x: 0.2, y: 0.1 },
    { x: 0.85, y: 0.15 },
    { x: 0.8, y: 0.9 },
    { x: 0.1, y: 0.8 },
  ]);
});

test('keeps top-left first when the top-right corner is visually higher', () => {
  const ordered = orderQuad([
    { x: 0.9, y: 0.8 },
    { x: 0.85, y: 0.1 },
    { x: 0.1, y: 0.9 },
    { x: 0.15, y: 0.25 },
  ]);

  assert.deepEqual(ordered, [
    { x: 0.15, y: 0.25 },
    { x: 0.85, y: 0.1 },
    { x: 0.9, y: 0.8 },
    { x: 0.1, y: 0.9 },
  ]);
});

test('rejects duplicate, concave, and near-zero-area quads', () => {
  assert.throws(() => orderQuad([
    { x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
  ]), /unique/i);
  assert.throws(() => orderQuad([
    { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 },
    { x: 0.45, y: 0.45 }, { x: 0.1, y: 0.9 },
  ]), /convex/i);
  assert.throws(() => orderQuad([
    { x: 0.1, y: 0.1 }, { x: 0.1001, y: 0.1 },
    { x: 0.1001, y: 0.1001 }, { x: 0.1, y: 0.1001 },
  ]), /area/i);
});

test('computes normalized canvas coverage from polygon area', () => {
  assert.equal(core.normalizedQuadArea([
    { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 },
    { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 },
  ]), 0.25);
});

test('accepts only canvas-sized quadrilaterals with plausible 30 by 40 aspect', () => {
  const portraitCanvas = [
    { x: 0.25, y: 0.05 }, { x: 0.75, y: 0.05 },
    { x: 0.75, y: 0.95 }, { x: 0.25, y: 0.95 },
  ];
  const tinyCanvas = portraitCanvas.map((point) => ({ x: point.x * 0.1, y: point.y * 0.1 }));
  const veryWide = [
    { x: 0.05, y: 0.4 }, { x: 0.95, y: 0.4 },
    { x: 0.95, y: 0.6 }, { x: 0.05, y: 0.6 },
  ];

  assert.equal(core.isCanvasQuadCandidate(portraitCanvas), true);
  assert.equal(core.isCanvasQuadCandidate(tinyCanvas), false);
  assert.equal(core.isCanvasQuadCandidate(veryWide), false);
});

test('expires a stale detected quad after misses', () => {
  const tracker = new DetectionTracker({ maxMisses: 3 });
  const quad = [
    { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 },
    { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
  ];

  tracker.hit(quad);
  tracker.miss(); tracker.miss(); tracker.miss();

  assert.equal(tracker.current(), null);
});

test('calculates percentile luminance and capture metrics from RGBA pixels', () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255,
    64, 64, 64, 255,
    192, 192, 192, 255,
    255, 255, 255, 255,
  ]);
  const metrics = calculateValueMetrics(pixels, 2, 2, { canvasCoverage: 0.75 });

  assert.equal(metrics.p10, 0);
  assert.ok(Math.abs(metrics.median - (64 / 255)) < 0.001);
  assert.ok(Math.abs(metrics.p90 - 1) < 0.001);
  assert.equal(metrics.clipped_dark_pct, 0.25);
  assert.equal(metrics.clipped_light_pct, 0.25);
  assert.equal(metrics.canvas_coverage, 0.75);
});

test('omits unknown coverage and reports more blur for a flat image than a sharp one', () => {
  const flat = new Uint8ClampedArray(4 * 4 * 4).fill(128);
  for (let offset = 3; offset < flat.length; offset += 4) flat[offset] = 255;
  const sharp = new Uint8ClampedArray(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1) {
    const value = (pixel + Math.floor(pixel / 4)) % 2 ? 255 : 0;
    sharp.set([value, value, value, 255], pixel * 4);
  }

  const flatMetrics = calculateValueMetrics(flat, 4, 4);
  const sharpMetrics = calculateValueMetrics(sharp, 4, 4);
  assert.equal(flatMetrics.canvas_coverage, null);
  assert.ok(flatMetrics.blur_estimate > sharpMetrics.blur_estimate);
  assert.ok(flatMetrics.blur_estimate >= 0 && flatMetrics.blur_estimate <= 1);
  assert.ok(sharpMetrics.blur_estimate >= 0 && sharpMetrics.blur_estimate <= 1);
});

test('bounds canonical output while preserving orientation and aspect', () => {
  assert.deepEqual(
    core.boundedCanonicalSize({ width: 20, height: 40 }),
    { width: 96, height: 192 },
  );
  const large = core.boundedCanonicalSize({ width: 8000, height: 4000 });
  assert.ok(Math.max(large.width, large.height) <= 2048);
  assert.ok(large.width * large.height <= 4_000_000);
  assert.ok(Math.abs(large.width / large.height - 2) < 0.01);
});

test('serializes requests and marks an aborted older response stale', async () => {
  const coordinator = new RequestCoordinator();
  let started = 0;
  let releaseFirst;
  const first = coordinator.request(async ({ signal }) => {
    started += 1;
    await new Promise((resolve) => { releaseFirst = resolve; });
    return signal.aborted ? 'old-aborted' : 'old';
  });
  const second = coordinator.request(async () => {
    started += 1;
    return 'new';
  });

  assert.equal(started, 1);
  releaseFirst();
  assert.deepEqual(await first, { id: 1, stale: true, value: 'old-aborted' });
  assert.deepEqual(await second, { id: 2, stale: false, value: 'new' });
  assert.equal(started, 2);
});

test('cancel aborts active and pending work and advances the session generation', async () => {
  const coordinator = new RequestCoordinator();
  let release;
  let activeSignal;
  const first = coordinator.request(async ({ signal }) => {
    activeSignal = signal;
    await new Promise((resolve) => { release = resolve; });
    return 'late';
  });
  const pending = coordinator.request(async () => 'must-not-run');

  assert.equal(coordinator.busy, true);
  const generation = coordinator.generation;
  coordinator.cancel();
  assert.equal(activeSignal.aborted, true);
  assert.ok(coordinator.generation > generation);
  release();

  assert.equal((await first).stale, true);
  assert.equal((await pending).stale, true);
  assert.equal(coordinator.busy, false);
});

test('formats structured critiques as plain text sections without markup interpretation', () => {
  const formatted = formatCritique({
    frame_usable: true,
    strength: 'Mantené <ese borde>',
    corrections: [{
      evidence: 'El plano claro pierde contraste.',
      action: 'Oscurecé el fondo inmediato.',
      verification: 'Entrecerrá los ojos y revisá la silueta.',
    }],
    spoken_summary: 'Separá primero la forma central.',
  });

  assert.deepEqual(formatted, [
    ['Preservá', 'Mantené <ese borde>'],
    ['Leé', 'El plano claro pierde contraste.'],
    ['Actuá', 'Oscurecé el fondo inmediato.'],
    ['Comprobá', 'Entrecerrá los ojos y revisá la silueta.'],
    ['Resumen', 'Separá primero la forma central.'],
  ]);
});

test('formats all actionable fields and an immediately dependent follow-up', () => {
  const correction = {
    location: 'tercio superior',
    evidence: 'El cielo y la loma comparten el mismo valor.',
    consequence: 'Se pierde profundidad.',
    action: 'Aclará el cielo.',
    amount: 'Medio paso.',
    mixture: 'Blanco con una punta de ocre.',
    verification: 'Entrecerrá los ojos.',
    confidence: 'high',
  };
  const sections = formatCritique({
    frame_usable: true,
    corrections: [correction, { ...correction, location: 'borde de la loma', action: 'Perdé un tramo del borde.' }],
  });

  assert.deepEqual(sections, [
    ['Leé', 'tercio superior: El cielo y la loma comparten el mismo valor. Se pierde profundidad.'],
    ['Actuá', 'Aclará el cielo. Cantidad: Medio paso. Mezcla o herramienta: Blanco con una punta de ocre.'],
    ['Comprobá', 'Entrecerrá los ojos.'],
    ['Confianza', 'Alta'],
    ['Después · Leé', 'borde de la loma: El cielo y la loma comparten el mismo valor. Se pierde profundidad.'],
    ['Después · Actuá', 'Perdé un tramo del borde. Cantidad: Medio paso. Mezcla o herramienta: Blanco con una punta de ocre.'],
    ['Después · Comprobá', 'Entrecerrá los ojos.'],
    ['Después · Confianza', 'Alta'],
  ]);
});

test('unusable critique preserves both capture problems and the recapture instruction', () => {
  assert.deepEqual(formatCritique({
    frame_usable: false,
    capture_problems: ['La imagen está movida.', 'Falta el borde inferior.'],
    spoken_summary: 'Apoyá el teléfono y encuadrá el lienzo completo.',
  }), [
    ['Problemas de captura', 'La imagen está movida. Falta el borde inferior.'],
    ['Recapturá', 'Apoyá el teléfono y encuadrá el lienzo completo.'],
  ]);
});

test('normalizes structured API errors without losing field details', () => {
  assert.equal(
    core.formatApiError({ detail: { field: 'capture_metadata', reason: 'width does not match' } }, 422),
    'capture_metadata: width does not match',
  );
  assert.equal(
    core.formatApiError({ detail: [{ loc: ['body', 'stage'], msg: 'Input should be valid' }] }, 422),
    'body.stage: Input should be valid',
  );
});

test('builds an analyze payload with coherent previous and reference context', () => {
  const capture = {
    imageBase64: 'current',
    imageBwBase64: 'bw',
    valueMetrics: { median: 0.5 },
    captureMetadata: { crop_mode: 'full_frame', crop_source: 'none' },
  };
  const context = {
    user_prompt: 'Revisá el foco', medium: 'oil', stage: 'block-in',
    intention: 'Profundidad', critique_mode: 'next_brushstroke', style: 'libre',
  };
  const complete = core.buildAnalyzePayload({
    capture,
    previous: { imageBase64: 'previous', valueMetrics: { median: 0.4 }, critique: { frame_usable: true } },
    reference: { imageBase64: 'reference', purpose: 'color' },
    context,
    history: [{ role: 'user', text: 'Anterior' }],
    apiKey: 'key',
  });
  assert.equal(complete.capture_metadata, capture.captureMetadata);
  assert.equal(complete.previous_image_base64, 'previous');
  assert.deepEqual(complete.previous_value_metrics, { median: 0.4 });
  assert.deepEqual(complete.previous_critique, { frame_usable: true });
  assert.equal(complete.image_ref_base64, 'reference');
  assert.equal(complete.reference_purpose, 'color');

  const currentOnly = core.buildAnalyzePayload({
    capture,
    previous: { valueMetrics: { median: 0.4 }, critique: { frame_usable: true } },
    reference: { purpose: 'color' },
    context,
    history: [],
  });
  assert.equal('previous_value_metrics' in currentOnly, false);
  assert.equal('previous_critique' in currentOnly, false);
  assert.equal('reference_purpose' in currentOnly, false);
});
