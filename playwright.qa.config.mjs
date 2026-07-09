import { defineConfig, devices } from "@playwright/test";

const frontendUrl = process.env.QA_FRONTEND_URL || "http://localhost:5175";

export default defineConfig({
  testDir: "./qa",
  outputDir: "qa-artifacts/test-results",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "qa-artifacts/playwright-report", open: "never" }]
  ],
  use: {
    baseURL: frontendUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] }
    }
  ]
});
