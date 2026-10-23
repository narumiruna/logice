import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.LOGICE_E2E_OUTPUT_DIR ?? "test-results",
  use: {
    baseURL: process.env.LOGICE_E2E_URL ?? "http://127.0.0.1:1",
    // Authentication responses contain disposable bearer tokens. Do not save them.
    trace: "off",
    screenshot: "off",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium",
      testIgnore: /auth\.setup\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
