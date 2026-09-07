import { test, expect } from '@playwright/test';

test.describe('Vision Profesor de Arte — UI', () => {
  test('index page loads and shows title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Profesor de Arte/i);
  });

  test('health endpoint returns ok', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.model).toBe('string');
  });

  test('styles endpoint returns known styles', async ({ request }) => {
    const response = await request.get('/api/styles');
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body).toHaveProperty('libre');
    expect(body).toHaveProperty('rembrandt');
  });

  test('main UI elements are visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#startCam')).toBeVisible();
    await expect(page.locator('#capture')).toBeVisible();
    await expect(page.locator('#clear')).toBeVisible();
    await expect(page.locator('#prompt')).toBeVisible();
    await expect(page.locator('#medium')).toBeVisible();
    await expect(page.locator('#stage')).toBeVisible();
    await expect(page.locator('#critiqueMode')).toBeVisible();
    await expect(page.locator('#style')).toBeVisible();
    await expect(page.locator('#speak')).toBeVisible();
    await expect(page.locator('#useRef')).toBeVisible();
  });

  test('canvas and video elements exist', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#video')).toHaveCount(1);
    await expect(page.locator('#canvas')).toHaveCount(1);
    await expect(page.locator('#gridCanvas')).toHaveCount(1);
    await expect(page.locator('#overlayCanvas')).toHaveCount(1);
  });

  test('auto toggle shows pause button when camera active', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#pauseAuto')).toBeHidden();
    // Mock getUserMedia so the app thinks a camera is active
    await page.evaluate(() => {
      window._originalGetUserMedia = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = () =>
        Promise.resolve({ getTracks: () => [], getVideoTracks: () => [] });
    });
    await page.locator('#startCam').click();
    await page.waitForTimeout(500);
    // Set interval to non-zero so auto activates
    await page.selectOption('#interval', '8000');
    await page.locator('#toggleAuto').click();
    await expect(page.locator('#pauseAuto')).toBeVisible();
  });

  test('voice button exists', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#speak')).toBeVisible();
  });

  test('medium select has expected options', async ({ page }) => {
    await page.goto('/');
    const medium = page.locator('#medium');
    await expect(medium).toBeVisible();
    const options = await medium.locator('option').allTextContents();
    expect(options.some((o) => o.includes('Óleo'))).toBeTruthy();
    expect(options.some((o) => o.includes('Acuarela'))).toBeTruthy();
  });

  test('stage select has expected options', async ({ page }) => {
    await page.goto('/');
    const stage = page.locator('#stage');
    const options = await stage.locator('option').allTextContents();
    expect(options.some((o) => o.includes('Encaje'))).toBeTruthy();
    expect(options.some((o) => o.includes('Terminación'))).toBeTruthy();
  });

  test('critique mode select has expected options', async ({ page }) => {
    await page.goto('/');
    const mode = page.locator('#critiqueMode');
    const options = await mode.locator('option').allTextContents();
    expect(options.some((o) => o.includes('Próxima pincelada'))).toBeTruthy();
    expect(options.some((o) => o.includes('Crítica profunda'))).toBeTruthy();
  });

  test('analysis counter starts at 0', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#counter')).toHaveText('0 análisis');
  });

  test('messages area starts empty', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#msgs')).toHaveText('');
  });

  test('snapshot preview starts hidden', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#snapshotPreview')).toBeHidden();
  });

  test('pause button is hidden initially', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#pauseAuto')).toBeHidden();
  });

  test('reference checkbox is checked by default', async ({ page }) => {
    await page.goto('/');
    const useRef = page.locator('#useRef');
    await expect(useRef).toBeVisible();
    await expect(useRef).toBeChecked();
  });

  test('index page has correct CSS for overlay canvas', async ({ page }) => {
    await page.goto('/');
    const overlay = page.locator('#overlayCanvas');
    await expect(overlay).toHaveCSS('z-index', '2');
  });

  test('no JS console errors on load', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => {
      // Ignore OpenCV loading artifacts during startup
      if (!err.message.includes('candidate.then') && !err.message.includes('OpenCV')) {
        errors.push(err.message);
      }
    });
    await page.goto('/');
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });
});
