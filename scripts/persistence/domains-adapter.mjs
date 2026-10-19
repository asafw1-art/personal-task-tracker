import { capabilities as previous, createHarness as createPrevious } from "./collaboration-adapter.mjs";
export const capabilities = { ...previous, supportedCases: [...previous.supportedCases, "T17", "T18", "T19"] };
export async function createHarness(seed) {
  const h = await createPrevious(seed);
  try { await h.stageDomains(); return h; } catch (error) { await h.close(); throw error; }
}
