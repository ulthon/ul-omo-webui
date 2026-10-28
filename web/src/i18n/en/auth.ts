// auth domain strings (en): settings "Auth" section (r10 batch todo 13).
// Key set locked to zh/auth.ts via the aggregator satisfies clause.
export const auth = {
  heading: "Auth",
  note: "Paste an API key and click test; the key is only saved to the engine auth config when the test passes. Invalid keys are not stored. The key is never shown or logged in plaintext.",
  providerLabel: "provider",
  providerCustom: "Custom…",
  providerCustomPlaceholder: "provider name",
  providerRequired: "Select or enter a provider first",
  keyRequired: "Paste an API key first",
  keyPlaceholder: "Paste API key",
  test: "Test & save",
  testing: "Testing…",
  testOk: "Key verified and saved",
  testFailed: "Credential test failed",
  rejectNotConfigured: "The engine rejected this key (invalid or malformed)",
} as const;
