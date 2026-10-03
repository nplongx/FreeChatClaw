import { describe, expect, it } from "vitest";
import { assertM12ProviderBoundary, type M12ProviderBoundaryParams } from "./inference-runtime.js";
import { AUTH_MARKER, request } from "./inference-runtime.test-support.js";

describe("M12 Phase 4 provider boundary", () => {
  it("accepts only the Gateway-owned ChatGPT Web tuple on an isolated /v1 endpoint", () => {
    expect(() =>
      assertM12ProviderBoundary({
        provider: "chatgpt-web",
        modelId: "chatgpt-free",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:43181/v1",
        credentialSource: "gateway",
      }),
    ).not.toThrow();
  });

  it.each([
    ["wrong provider", { provider: "openai" }],
    ["wrong model", { modelId: "gpt-5" }],
    ["wrong api", { api: "openai-responses" }],
    ["wrong credential owner", { credentialSource: "worker" as never }],
    ["missing endpoint", { baseUrl: undefined }],
    ["production endpoint", { baseUrl: "http://127.0.0.1:8318/v1" }],
    ["non-loopback endpoint", { baseUrl: "https://chatgpt.example/v1" }],
    ["wrong endpoint path", { baseUrl: "http://127.0.0.1:43181/chat/completions" }],
  ])("fails closed on %s", (_name, mutation) => {
    expect(() =>
      assertM12ProviderBoundary({
        provider: "chatgpt-web",
        modelId: "chatgpt-free",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:43181/v1",
        credentialSource: "gateway",
        ...mutation,
      } as M12ProviderBoundaryParams),
    ).toThrow();
  });

  it("keeps the worker inference request credential-free", () => {
    const workerRequest = request("chatgpt-free");
    const serialized = JSON.stringify({
      ...workerRequest,
      modelRef: { provider: "chatgpt-web", model: "chatgpt-free" },
    });
    expect(serialized).not.toContain(AUTH_MARKER);
    expect(serialized).not.toMatch(/(?:apiKey|authorization|credential|secret)/iu);
  });

  it("keeps the Gateway credential outside the worker request", () => {
    const workerRequest = request("chatgpt-free");
    const outbound = JSON.stringify(workerRequest);
    expect(outbound).not.toContain(AUTH_MARKER);
    expect(outbound).not.toMatch(/(?:apiKey|authorization|credential|secret)/iu);
    expect(Object.keys(workerRequest)).toEqual([
      "runEpoch",
      "sessionId",
      "runId",
      "turnId",
      "modelRef",
      "context",
      "options",
    ]);
  });
});
