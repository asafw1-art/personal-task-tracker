import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { cases, syntheticSeed } from "./contract-cases.mjs";
import { uiCases } from "./ui-cases.mjs";

const adapterPath = process.env.PERSISTENCE_TEST_ADAPTER;
const strict = process.env.PERSISTENCE_REQUIRE_TARGET === "1";
const adapter = adapterPath ? await import(pathToFileURL(resolve(adapterPath)).href) : null;
if (adapter) {
  assert.equal(adapter.capabilities?.syntheticOnly, true);
  assert.equal(adapter.capabilities?.productionTarget, false);
  assert.equal(adapter.capabilities?.realImplementation, true, "A test-only reference engine is not a valid implementation target");
  assert.equal(typeof adapter.createHarness, "function");
}

test("test inventory: T01-T24 and U01-U16 are unique, ordered and documented", async () => {
  for (const [list, prefix, count, file] of [
    [cases, "T", 24, "persistence-contract-v1-2026-10-19.md"],
    [uiCases, "U", 16, "persistence-ux-v1-2026-10-19.md"],
  ]) {
    assert.deepEqual(list.map((item) => item.id), Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`));
    const document = await readFile(`docs/internal/${file}`, "utf8");
    for (const item of list) assert.match(document, new RegExp(`\\| ${item.id}(?: |\\b)`));
    for (const item of list) assert.equal(typeof item.run, "function");
  }
});

test("release gate: real synthetic adapter is required, pending is not readiness", { skip: !strict }, () => {
  assert.ok(adapter, "Package 6 adapter missing: all 40 target acceptance tests remain pending; NOT release-ready");
  assert.equal(adapter.capabilities.renderedUi, true, "Release gate also requires a rendered UI adapter");
});

for (const [scope, list] of [["contract", cases], ["ui", uiCases]]) {
  for (const item of list) {
    const title = `${item.id} / TARGET ${scope}: ${item.title}`;
    if (!adapter) {
      test.todo(`${title} [BLOCKED: package 6 implementation adapter]`);
      continue;
    }
    test(title, async () => {
      const h = await adapter.createHarness(structuredClone(syntheticSeed));
      try {
        if (scope === "ui") await item.run(await h.client());
        else await item.run(h);
      } finally {
        await h.close();
      }
    });
  }
}
