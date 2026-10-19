import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

export const owner = { id: "10000000-0000-4000-8000-000000000001" };
export const recipient = { id: "10000000-0000-4000-8000-000000000002" };
export const outsider = { id: "10000000-0000-4000-8000-000000000003" };
export const task = (number = 1, patch = {}) => ({
  id: `P${number}`, prefix: "P", number, title: `Synthetic task ${number}`,
  category: "Synthetic topic", priority: "normal", status: "open",
  createdAt: "2026-01-01", notes: "Synthetic note",
  subtasks: [{ id: `P${number}.1`, number: 1, title: "Synthetic step", status: "open" }],
  ...patch,
});
export const copy = (value) => structuredClone(value);

function compile(source, requireModule = () => { throw new Error("Unexpected import"); }) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)(requireModule, loaded, loaded.exports);
  return loaded.exports;
}

// Load only named pure functions; never evaluate page.tsx or personal seed tasks.
export function numbering() {
  const source = ts.createSourceFile("page.tsx", readFileSync("src/app/page.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["nextTaskNumber", "nextSubtaskNumber"]);
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  assert.equal(functions.length, names.size, "Numbering functions moved: update the test adapter explicitly");
  return compile(functions.map((node) => `export ${node.getText(source)}`).join("\n"));
}

export function canonicalIds() {
  const source = ts.createSourceFile("tasks.ts", readFileSync("src/lib/tasks.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "canonicalTaskId");
  assert.ok(node, "Canonical ID function moved: update the adapter explicitly");
  return compile(node.getText(source)).canonicalTaskId;
}

// This transport models ordered REST upserts, not PostgreSQL locking or RLS.
export function legacyHarness() {
  const rows = new Map(), calls = [];
  let responseFault = null, optionalColumnFault = false, selectedLimit = Infinity;
  const key = (row) => `${row.user_id}:${row.prefix}:${row.task_number}`;
  const client = {
    from(table) {
      assert.equal(table, "tasks");
      return {
        async upsert(payload, options) {
          calls.push({ kind: "upsert", payload: copy(payload), options: copy(options) });
          assert.equal(options.onConflict, "user_id,prefix,task_number");
          if (optionalColumnFault && Object.hasOwn(payload[0], "subtasks")) {
            return { error: { message: "column subtasks does not exist" } };
          }
          for (const row of payload) rows.set(key(row), { ...rows.get(key(row)), ...copy(row) });
          if (responseFault) throw responseFault;
          return { error: null };
        },
        select() {
          calls.push({ kind: "select" });
          const query = {
            order: () => query,
            then(resolve) { return Promise.resolve({ data: copy([...rows.values()].slice(0, selectedLimit)), error: null }).then(resolve); },
          };
          return query;
        },
      };
    },
  };
  const api = compile(readFileSync("src/lib/supabaseTasks.ts", "utf8"), (name) => {
    assert.equal(name, "@/lib/supabase", "No real Supabase client may be loaded");
    return { supabase: client };
  });
  return {
    ...api, rows, calls,
    row: (number, user = owner) => rows.get(`${user.id}:P:${number}`),
    loseAcknowledgement: () => { responseFault = new Error("Synthetic lost ACK after write"); },
    restoreTransport: () => { responseFault = null; },
    missingSubtasksColumn: () => { optionalColumnFault = true; },
    limitReads: (limit) => { selectedLimit = limit; },
  };
}
