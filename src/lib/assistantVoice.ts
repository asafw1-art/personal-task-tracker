export type AssistantVoiceTurn = {
  transcript: string;
};

export type AssistantVoiceAdapter = {
  isAvailable(): boolean;
  start(): Promise<AssistantVoiceTurn>;
};

// The UI must only expose voice once a provider implements this adapter end to end.
export const assistantVoiceAdapter: AssistantVoiceAdapter = {
  isAvailable: () => false,
  start: async () => {
    throw new Error("קול עדיין לא מוגדר.");
  },
};
