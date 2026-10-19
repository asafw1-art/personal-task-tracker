import { capabilities as transport, createHarness as createTransport } from "./transport-adapter.mjs";
export const capabilities = { ...transport, supportedCases: [...transport.supportedCases, "T08", "T09", "T10", "T20"] };
export async function createHarness(seed) {
  const h = await createTransport(seed);
  try { await h.stageCollaboration(); return h; }
  catch (error) { await h.close(); throw error; }
}
