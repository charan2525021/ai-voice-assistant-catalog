export const SDK_CATALOG_SCHEMA_VERSION = 1 as const;
export const SDK_WORKFLOW_SCHEMA_VERSION = 1 as const;
export const SDK_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const SDK_PROTOCOL_VERSION = 1 as const;
export const SDK_TOKEN_SCHEMA_VERSION = 1 as const;
export const SDK_TELEMETRY_SCHEMA_VERSION = 1 as const;

export const SDK_TOKEN_MAX_LIFETIME_SECONDS = Object.freeze({
  sdk_identity: 5 * 60,
  sdk_session: 8 * 60 * 60,
  sdk_socket_ticket: 2 * 60,
});

/** Maximum structural sizes accepted by the data-contract validators. */
export const CONTRACT_LIMITS = Object.freeze({
  screens: 2_000,
  controls: 20_000,
  journeys: 5_000,
  demoAudioAssets: 2_000,
  demoQuestions: 100,
  demoPersonas: 100,
  demoModules: 500,
  salesPlays: 5_000,
  tools: 500,
  workflowSteps: 500,
  workflowDepth: 20,
  locatorsPerControl: 20,
  observedElements: 5_000,
  telemetryEventsPerBatch: 500,
  stringChars: 100_000,
});
