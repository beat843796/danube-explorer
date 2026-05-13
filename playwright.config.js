// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8000",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    video: "off",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: ".venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000",
    url: "http://127.0.0.1:8000/",
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
