import { defineConfig, devices } from "@playwright/test";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function assertLocalQaTargets(environment = process.env) {
  for (const [name, rawValue] of Object.entries(environment)) {
    if (!/^QA_[A-Z0-9_]*(?:URL|ORIGIN)$/.test(name) || !String(rawValue || "").trim()) continue;
    let target;
    try {
      target = new URL(String(rawValue));
    } catch {
      throw new Error(`${name} must be a valid local URL before Playwright QA can run.`);
    }
    const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(hostname) && !hostname.endsWith(".localhost")) {
      throw new Error(`${name} must target localhost for Playwright QA; received ${hostname}. Production smoke checks use separate scripts.`);
    }
  }
}

assertLocalQaTargets();

const frontendUrl = process.env.QA_FRONTEND_URL || "http://localhost:5175";

export default defineConfig({
  testDir: "./qa",
  outputDir: "qa-artifacts/test-results",
  workers: 4,
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
