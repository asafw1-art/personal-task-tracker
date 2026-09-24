import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Local visual fixtures: no credentials, database or external AI calls.
const require = createRequire(import.meta.url);
function load(file) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)((name) => name.startsWith("@/") ? load(resolve(`src/${name.slice(2)}.ts`)) : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const { AssistantContextReview } = load("src/components/AssistantContextReview.tsx");
const { ServiceHealthPanel } = load("src/components/ServiceHealthPanel.tsx");
const noOp = () => {};
const preview = { digest: "synthetic", message: "מה כדאי לקדם במשימה P19?", includeDetails: true,
  tasks: [{ id: "P19", title: "משימת בדיקה בעלת כותרת ארוכה שמוודאת התאמה גם למסך קטן", status: "open", priority: "high", dueDate: "2026-09-25", notes: "פרטי בדיקה בלבד, ללא מידע אישי", subtasks: [{ number: 1, title: "צעד בדיקה", status: "open" }] }],
  providers: [{ id: "gemini", label: "Gemini", model: "gemini-test", privacyVerified: false }, { id: "gateway", label: "Vercel AI Gateway", model: "test/model", privacyVerified: false }],
};
const overview = { monitoringAvailable: true, generatedAt: "2026-09-23T12:00:00Z", services: [
  { id: "gemini", label: "Gemini", configured: true, enabled: true, state: "unknown", reason: "not_checked", checkedAt: null, lastSuccessAt: null, source: "policy", model: "gemini-test", privacyVerified: false },
  { id: "gateway", label: "Vercel AI Gateway", configured: true, enabled: false, state: "disabled", reason: "disabled_by_operator", checkedAt: "2026-09-23T12:00:00Z", lastSuccessAt: null, source: "policy" },
  { id: "database", label: "מסד הנתונים", configured: true, enabled: true, state: "healthy", reason: "ok", checkedAt: "2026-09-23T12:00:00Z", lastSuccessAt: "2026-09-23T12:00:00Z", source: "probe" },
] };
const server = createServer((request, response) => {
  if (request.url === "/styles.css") { response.writeHead(200, { "Content-Type": "text/css" }); response.end(readFileSync("src/app/globals.css")); return; }
  const url = new URL(request.url, "http://localhost");
  const panel = url.searchParams.get("view") === "services"
    ? React.createElement(ServiceHealthPanel, { overview, busy: false, error: "", onRefresh: noOp })
    : React.createElement(AssistantContextReview, { preview, busy: false, onConfirm: noOp, onCancel: noOp, onDetails: noOp });
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="he" dir="rtl" data-theme="${url.searchParams.get("theme") === "dark" ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>בדיקת UI סינתטית</title></head><body><main style="max-width:760px;margin:0 auto;padding:16px">${renderToStaticMarkup(panel)}</main></body></html>`);
});
server.listen(4174, "127.0.0.1", () => console.log("Synthetic UI fixtures: http://127.0.0.1:4174"));
