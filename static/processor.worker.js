/** Web Worker — off-thread pixel processing for capture pipeline. */

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
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

function computeValueMetrics(rgba, width, height, canvasCoverage) {
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
  const pixelCount = luminance.length;

  return {
    p10: histogramPercentile(histogram, pixelCount, 0.1),
    median: histogramPercentile(histogram, pixelCount, 0.5),
    p90: histogramPercentile(histogram, pixelCount, 0.9),
    mean: sum / pixelCount / 255,
    clipped_dark_pct: clippedDark / pixelCount,
    clipped_light_pct: clippedLight / pixelCount,
    canvas_coverage: Number.isFinite(canvasCoverage) ? clamp(canvasCoverage) : null,
    blur_estimate: clamp(1 - sharpness),
  };
}

function computeBw(rgba, width, height) {
  const bw = new Uint8ClampedArray(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const value = Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]);
    bw[offset] = value;
    bw[offset + 1] = value;
    bw[offset + 2] = value;
    bw[offset + 3] = rgba[offset + 3];
  }
  return new ImageData(bw, width, height);
}

self.onmessage = function (event) {
  const { id, rgba, width, height, canvasCoverage } = event.data;
  try {
    const uint8 = new Uint8ClampedArray(rgba);
    const valueMetrics = computeValueMetrics(uint8, width, height, canvasCoverage);
    const bwImageData = computeBw(uint8, width, height);
    const offscreen = new OffscreenCanvas(width, height);
    offscreen.getContext('2d').putImageData(bwImageData, 0, 0);
    offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.88 }).then((blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        self.postMessage({
          id,
          ok: true,
          valueMetrics,
          imageBwBase64: reader.result,
        });
      };
      reader.onerror = () => {
        self.postMessage({ id, ok: true, valueMetrics, imageBwBase64: null });
      };
      reader.readAsDataURL(blob);
    }).catch(() => {
      self.postMessage({ id, ok: true, valueMetrics, imageBwBase64: null });
    });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};
