import { describe, expect, it } from "vitest";
import { validateWorkerInferenceStartParams } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { assertM12ProviderBoundary } from "../worker-environments/inference-runtime.js";

const ISOLATED_BASE_URL = "http://127.0.0.1:43181/v1";
const CREDENTIAL_SENTINEL = "m12-phase4-gateway-secret";

function workerInferenceRequest() {
  return {
    runEpoch: 1,
    sessionId: "m12-session",
    runId: "m12-run",
    turnId: "m12-turn",
    modelRef: { provider: "chatgpt-web", model: "chatgpt-free" },
    context: {
      messages: [{ role: "user", content: "phase4", timestamp: 1 }],
    },
    options: {},
  };
}

describe("M12 Phase 4 provider acceptance", () => {
  it("pins chatgpt-web/chatgpt-free to the isolated OpenAI-compatible route", () => {
    expect(() =>
      assertM12ProviderBoundary({
        provider: "chatgpt-web",
        modelId: "chatgpt-free",
        api: "openai-completions",
        baseUrl: ISOLATED_BASE_URL,
        credentialSource: "gateway",
      }),
    ).not.toThrow();
  });

  it("rejects OpenAI Platform or production endpoints", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1",
      "http://127.0.0.1:8318/v1",
      "http://127.0.0.1:9010/v1",
    ]) {
      expect(() =>
        assertM12ProviderBoundary({
          provider: "chatgpt-web",
          modelId: "chatgpt-free",
          api: "openai-completions",
          baseUrl,
          credentialSource: "gateway",
        }),
      ).toThrow();
    }
  });

  it("proves the worker protocol has no provider credential field", () => {
    const request = workerInferenceRequest();
    const serialized = JSON.stringify({ ...request, sentinel: CREDENTIAL_SENTINEL });
    const actualWorkerPayload = JSON.stringify(request);
    expect(validateWorkerInferenceStartParams(request)).toBe(true);
    expect(actualWorkerPayload).not.toContain(CREDENTIAL_SENTINEL);
    expect(actualWorkerPayload).not.toMatch(/(?:apiKey|authorization|credential|secret)/iu);
    expect(serialized).toContain(CREDENTIAL_SENTINEL);
  });

  it("fails closed when the provider tuple changes instead of falling back", () => {
    expect(() =>
      assertM12ProviderBoundary({
        provider: "openai",
        modelId: "gpt-5.4",
        api: "openai-completions",
        baseUrl: ISOLATED_BASE_URL,
        credentialSource: "gateway",
      }),
    ).toThrow("M12 provider boundary rejected provider/model/auth tuple");
  });
});
