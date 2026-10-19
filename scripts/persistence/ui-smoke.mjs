// Focused package-6b smoke test. Synthetic auth/network/data only; never targets Production.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createHarness } from "./domains-adapter.mjs";
import { syntheticSeed as seed } from "./contract-cases.mjs";
const baseURL = process.env.PERSISTENCE_UI_URL ?? "http://localhost:3106";
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Loopback QA only");
if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error("PLAYWRIGHT_MODULE_PATH required");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
const h = await createHarness(structuredClone(seed)), browser = await chromium.launch({ headless: true, channel: "chrome" });
const commands = [], errors = [];
try {
  for (const [label, viewport, theme] of [["desktop", { width: 1440, height: 1000 }, "light"], ["mobile", { width: 390, height: 844 }, "dark"]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify({ sub: seed.owner, email: "owner@example.invalid", aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now()/1000)+3600 })).toString("base64url"), Buffer.from("synthetic-signature").toString("base64url")].join(".");
    await context.addInitScript(({ token, owner, theme }) => {
      localStorage.setItem("sb-synthetic-auth-token", JSON.stringify({ access_token: token, refresh_token: "synthetic-refresh", token_type: "bearer", expires_at: Math.floor(Date.now()/1000)+3600,
        user: { id: owner, email: "owner@example.invalid", aud: "authenticated", role: "authenticated", user_metadata: {} } }));
      localStorage.setItem("asaf-task-tracker-theme-v1", theme);
    }, { token, owner: seed.owner, theme });
    await page.route("https://synthetic.invalid/**", async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({ json: url.pathname.includes("/auth/") ? { id: seed.owner, email: "owner@example.invalid", role: "authenticated", aud: "authenticated" } : [], headers: { "Content-Range": "0-0/0" } });
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname !== "/api/persistence") { await route.fulfill({ status: 503, json: { error: "Synthetic QA: service disabled" } }); return; }
      let result;
      if (request.method() === "POST") { const command = request.postDataJSON(); commands.push(command); result = await h.send(seed.owner, command); }
      else if (url.searchParams.has("context")) result = (await h.asActor(seed.owner, "select public.persistence_context_v1() value")).rows[0].value;
      else if (url.searchParams.has("operationId")) result = await h.receipt(seed.owner, url.searchParams.get("operationId"));
      else if (url.searchParams.has("export")) result = (await h.asActor(seed.owner, "select public.persistence_export_self_v1() value")).rows[0].value;
      else result = await h.page(seed.owner, { limit: Number(url.searchParams.get("limit") ?? 100), cursor: JSON.parse(url.searchParams.get("cursor") ?? "null") });
      await route.fulfill({ status: ["committed", "prepared", "ok", "context", "backup"].includes(result.status) ? 200 : 409, json: result });
    });
    await page.goto(baseURL, { waitUntil: "networkidle" });
    const title = `Synthetic ${label} edited`;
    const before = commands.length;
    const beforeTitle = (await h.read(seed.owner, seed.tasks[1].id)).title;
    await page.getByText(beforeTitle, { exact: true }).first().waitFor();
    assert.equal(commands.length, before, "Initial load must not write tasks/settings/taxonomy");
    await page.getByRole("button", { name: `עריכת ${beforeTitle}`, exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "עריכת משימה", exact: true });
    await dialog.getByLabel("שם משימה", { exact: true }).fill(title);
    await dialog.getByRole("button", { name: "שמירת שינויים", exact: true }).click();
    await page.getByText(title, { exact: true }).first().waitFor();
    assert.equal((await h.read(seed.owner, seed.tasks[1].id)).title, title);
    assert.ok(commands.slice(before).some((command) => command.kind === "import"));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false, label + " must not overflow horizontally");
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    if (process.env.PERSISTENCE_QA_DIR) await page.screenshot({ path: resolve(process.env.PERSISTENCE_QA_DIR, `persistence-${label}.png`), fullPage: false });
    console.log(JSON.stringify({ viewport: label, saved: true, overflow: false, writeCount: commands.length-before }));
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await h.close(); }
