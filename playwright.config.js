import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:8000',
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'uvicorn app:app --port 8000',
    port: 8000,
    reuseExistingServer: true,
    timeout: 15_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
