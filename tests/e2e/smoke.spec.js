// @ts-check
const { test, expect } = require("@playwright/test");

test("loads the map and the river-km controls", async ({ page }) => {
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Real Chrome auto-fetches /favicon.ico; the static handler returns 404.
    // That's a resource issue, not a JS error — skip it.
    if (msg.text().startsWith("Failed to load resource")) return;
    consoleErrors.push(msg.text());
  });

  await page.goto("/");
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator("#river-km")).toBeVisible();
  await expect(page.locator("#km-input")).toBeVisible();
  await expect(page.locator("#tab-locks")).toBeVisible();

  // Wait for init() to finish — the locks list gets populated after fetch.
  await expect(page.locator("#lock-list .lock-item").first()).toBeVisible({
    timeout: 10_000,
  });

  // No JS errors should have fired during load.
  expect(
    consoleErrors,
    `Unexpected console/page errors:\n${consoleErrors.join("\n")}`
  ).toEqual([]);
});

test("km input rejects out-of-range and accepts valid km", async ({ page }) => {
  await page.goto("/");
  const input = page.locator("#km-input");
  const go = page.locator("#km-go");

  await input.fill("9999");
  await expect(input).toHaveClass(/invalid/);
  await expect(go).toBeDisabled();

  await input.fill("1500");
  await expect(input).not.toHaveClass(/invalid/);
  await expect(go).toBeEnabled();
});
