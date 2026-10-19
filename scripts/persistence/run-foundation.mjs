import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.env.PGLITE_MODULE_PATH) throw new Error("PGLITE_MODULE_PATH is required; foundation is tested only in a local synthetic database");
const result = spawnSync(process.execPath, ["--test", "scripts/persistence/contract.test.mjs", "scripts/persistence/foundation.test.mjs"], {
  stdio: "inherit", env: { ...process.env, PERSISTENCE_REQUIRE_TARGET: "0",
    PERSISTENCE_TEST_ADAPTER: fileURLToPath(new URL("./foundation-adapter.mjs", import.meta.url)) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
