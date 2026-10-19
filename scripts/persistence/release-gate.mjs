import { spawnSync } from "node:child_process";

if (!process.env.PGLITE_MODULE_PATH) {
  console.error("NOT READY: PGLITE_MODULE_PATH is required; SQL tests may not be silently skipped at the release gate.");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "scripts/persistence/legacy.test.mjs", "scripts/persistence/sql.test.mjs", "scripts/persistence/contract.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, PERSISTENCE_REQUIRE_TARGET: "1" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
