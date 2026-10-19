import { capabilities as foundation, createHarness as createFoundation } from "./foundation-adapter.mjs";
export const capabilities = { ...foundation, supportedCases: [...foundation.supportedCases, "T22"] };
export async function createHarness(seed) {
  const h = await createFoundation(seed);
  try { await h.stageTransport(); return h; }
  catch (error) { await h.close(); throw error; }
}
