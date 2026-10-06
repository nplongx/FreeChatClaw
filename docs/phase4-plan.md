# FreeChatClaw Phase 4 — Provider boundary + ChatGPT Free integration proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and harden the FreeChatClaw Phase 4 provider boundary so the Gateway alone resolves `chatgpt-web/chatgpt-free` through an isolated OpenAI-compatible `/v1` endpoint corresponding to the required ChatGPT Free route, while the ephemeral worker receives no provider credential and cannot fall back to OpenAI Platform/API-key execution.

**Architecture:** Keep provider ownership on the Gateway. The existing worker-inference RPC remains credential-free: it carries only the admitted run identity, `modelRef`, context, and inference options; Gateway-side inference resolves the configured provider route/auth and passes the credential only to the provider transport boundary. Phase 4 adds a narrow FreeChatClaw policy/verification seam around that existing path, focused tests for credential non-propagation and route identity, and one isolated live proof against the existing non-production adapter/provider endpoint.

**Tech Stack:** TypeScript, Vitest, OpenClaw Gateway worker-inference RPC, provider model-route/auth preparation, OpenAI-compatible transport, isolated Gateway state, and an isolated ChatGPT Web-compatible `/v1` provider endpoint.

**Spec:** `docs/phase3-plan.md` plus the FreeChatClaw task specification supplied for this phase (Phase 3 defers provider proof; Phase 4 requires `modelRef -> chatgpt-web/chatgpt-free -> Gateway provider -> 127.0.0.1:8318/v1 -> ChatGPT Web`, with no provider credential visible to the runner).

## Global Constraints

- Never touch, restart, modify, or use production Gateway `127.0.0.1:9010` as an execution target.
- Never touch, restart, modify, or use production adapter `127.0.0.1:8318` as the Phase 4 execution target; the live proof must use an isolated equivalent endpoint/configuration.
- Never edit `/home/long/work/chatgpt-adapter/server.js`, `scripts/runner-agent-openclaw.js`, or `tests/test-m12-runner-agent.js`.
- Never use `OPENAI_API_KEY`.
- Never use OpenAI Platform API or `https://api.openai.com/v1` as the Phase 4 provider endpoint.
- Never use `--session-host`, local `sessions_spawn`, `operator.admin`, or local execution fallback.
- Never put provider credentials into worker admission, worker-inference request/response frames, node environment metadata, runner result files, or worker workspace artifacts.
- Never use `extraBody.tool_choice`; the existing native-exec compatibility seam remains unchanged.
- Canonical profile remains `coding`; do not switch the FreeChatClaw path to `full`.
- Shared lifecycle admission lease and provider device lease remain independent.
- `nodeDeviceId` remains environment/device binding only; it is not part of the shared lifecycle lease.
- Do not weaken strict placement or provider authorization to make tests pass.
- Do not create provider proof from the runner, adapter, Gateway, or test harness.
- Do not use `git add`, `git commit`, or `git reset` during implementation unless the user explicitly authorizes the final repository operation; the current user request explicitly authorizes final commit/push.
- Do not claim TypeScript success without an explicit `TSC_EXIT=0`.
- Phase 4 PASS requires current-tree evidence from the exact build used for the isolated E2E.

## Review Focus

1. **Credential propagation:** a worker-facing request or runner result must never contain the provider credential; add an assertion at the worker-inference boundary that the request contract has no credential field and the node-facing payload remains credential-free.
2. **Gateway-only auth resolution:** the Gateway may resolve the configured ChatGPT Web credential and pass it only to the provider stream; test that the provider stream receives it while the worker RPC identity/request does not.
3. **Provider route identity:** `chatgpt-web/chatgpt-free` must resolve to the isolated ChatGPT Web adapter route at the dedicated non-production `/v1` port in the Phase 4 fixture without silently resolving to OpenAI Platform.
4. **Credential redaction/provenance:** provider credentials must not appear in logs, transcript payloads, terminal replies, runner result JSON, or worker workspace files; add an explicit negative assertion for the credential sentinel.
5. **Failure ownership:** missing/invalid ChatGPT Web auth or wrong provider route must fail in Gateway provider preparation, not trigger local execution or a different provider/API fallback.

## File Map

Expected Phase 4 implementation surface is intentionally narrow:

- Modify: `src/gateway/worker-environments/inference-runtime.ts` — add the smallest FreeChatClaw provider-boundary enforcement/telemetry hook needed to attest that the selected provider is the Gateway-owned ChatGPT Free route and that credential material never enters worker protocol data.
- Modify: `src/gateway/worker-environments/inference-runtime.test.ts` or the nearest existing inference-runtime test surface if present — unit-test Gateway-only credential resolution and provider stream handoff.
- Create: `src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts` — isolated FreeChatClaw-focused tests for provider identity, credential non-propagation, and fail-closed behavior. Keep this separate from generic inference tests.
- Modify: `packages/gateway-protocol/src/schema/worker-inference.ts` only if a schema-level assertion/brand is required to make credential absence explicit; do not add a credential field.
- Create/modify: `src/gateway/server-methods/m12-specialist.test.ts` only if the specialist fixture must prove the fixed `chatgpt-web/chatgpt-free` modelRef survives session creation and dispatch unchanged.
- Create: `src/gateway/server-methods/m12-phase4.acceptance.test.ts` — provider-boundary acceptance harness combining modelRef, route, auth ownership, worker payload inspection, and negative credential assertions.
- Modify: `docs/phase3-plan.md` only after implementation/validation to link Phase 4 evidence; do not rewrite Phase 3 history.
- No adapter source files are in scope.

## Interfaces

The existing worker inference contract remains authoritative:

- Worker-facing request: `runEpoch + sessionId + runId + turnId + modelRef + context + options`.
- Gateway provider preparation consumes the request plus Gateway runtime config/session auth state.
- Provider stream receives the prepared model and the resolved auth value at the existing transport boundary.
- The runner receives only node admission/worker credentials and native run results; it does not receive the provider credential.

If a new helper is needed, prefer one small pure boundary function with an explicit tuple such as:

```ts
assertFreeChatClawProviderBoundary(params: {
  provider: string;
  modelId: string;
  api: string;
  baseUrl?: string;
  credentialSource: "gateway";
}): void
```

It must return `void` on the exact approved tuple and throw a bounded error otherwise. Do not make this helper resolve secrets or perform network calls.

### Task 1: Freeze the Phase 4 provider contract

**Files:**

- Create: `src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts`
- Create: `src/gateway/server-methods/m12-phase4.acceptance.test.ts`
- Modify: `packages/gateway-protocol/src/schema/worker-inference.ts` only if needed for an explicit credential-free contract test.

**Interfaces:**

- Consumes: existing `WorkerInferenceStartParams`, `WorkerInferenceModelRefSchema`, Gateway inference executor.
- Produces: executable assertions that define the exact Phase 4 contract before implementation changes.

- [ ] **Step 1: Write the failing provider-boundary tests.**
  - Assert the FreeChatClaw model tuple is exactly `provider=chatgpt-web`, `model=chatgpt-free`, `api=openai-completions`.
  - Assert the isolated provider route is `http://127.0.0.1:<isolated-adapter-port>/v1`; use a dynamically allocated isolated port in the test harness rather than hard-coding production `8318`.
  - Assert a worker-inference start request contains no `apiKey`, `credential`, `authorization`, or equivalent provider-secret field.
  - Assert a sentinel provider credential such as `m12-phase4-gateway-secret` is absent from the serialized worker request and node-facing result.
  - Assert a wrong provider such as `openai/gpt-*` is rejected by the FreeChatClaw boundary instead of being silently substituted.

- [ ] **Step 2: Run only the new tests.**
  - Run: `pnpm test src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts src/gateway/server-methods/m12-phase4.acceptance.test.ts`
  - Expected: FAIL because the explicit FreeChatClaw provider-boundary enforcement/fixture does not yet exist.

- [ ] **Step 3: Record the exact current transport seam.**
  - Pin the existing call sequence in the test fixture: model resolution -> auth preparation -> `registerProviderStreamForModel` -> provider stream invocation.
  - Do not introduce a second provider transport path.

### Task 2: Add the minimal Gateway-only provider boundary

**Files:**

- Modify: `src/gateway/worker-environments/inference-runtime.ts`
- Create/modify: `src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts`

**Interfaces:**

- Consumes: resolved `approved.provider`, `approved.model`, prepared model metadata, Gateway-resolved auth.
- Produces: a fail-closed FreeChatClaw assertion before provider transport invocation.

- [ ] **Step 1: Implement the smallest pure boundary assertion.**
  - Validate only the FreeChatClaw Phase 4 execution tuple required by the task: provider `chatgpt-web`, model `chatgpt-free`, API `openai-completions`, and an isolated ChatGPT Web base URL supplied by Gateway configuration.
  - Do not resolve secrets in this helper.
  - Do not pass the credential to any worker RPC object, transcript metadata, or runner callback.

- [ ] **Step 2: Place the assertion immediately before provider stream construction/invocation.**
  - The approved model must already be resolved by the existing Gateway auth/model machinery.
  - Keep `authValue = prepared.auth.apiKey` Gateway-local.
  - Continue passing `authValue` only through the existing `SimpleStreamOptions.apiKey` transport path.
  - Do not change `WorkerInferenceStartParamsSchema`.

- [ ] **Step 3: Add fail-closed tests.**
  - Wrong provider -> `provider-error` or bounded FreeChatClaw policy error.
  - Wrong model -> rejected.
  - Wrong API -> rejected.
  - Missing/empty Gateway auth -> rejected before provider request.
  - Credential present in the Gateway provider stream -> accepted only at that boundary.
  - Credential present in worker request serialization -> impossible/test failure.

- [ ] **Step 4: Run the focused provider tests.**
  - Run: `pnpm test src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts src/gateway/worker-environments/inference-runtime.test.ts`
  - Expected: PASS.

### Task 3: Prove the provider route and auth owner without exposing the secret

**Files:**

- Create/modify: `src/gateway/server-methods/m12-phase4.acceptance.test.ts`
- Reuse: existing model-route/auth test helpers under `src/agents/runtime-plan/`, `src/agents/model-auth*.test.ts`, and worker-inference test support.
- Do not modify adapter files.

**Interfaces:**

- Consumes: Gateway config/model route/auth profile fixtures.
- Produces: deterministic assertions for `chatgpt-web/chatgpt-free -> isolated adapter /v1`.

- [ ] **Step 1: Build an isolated Gateway fixture.**
  - Allocate a non-production adapter port.
  - Configure provider `chatgpt-web` with `api: "openai-completions"`, model `chatgpt-free`, and `baseUrl: http://127.0.0.1:<isolated-port>/v1`.
  - Configure the credential in the Gateway-owned auth/profile mechanism used by the current model preparation path.
  - Do not place the credential in node config, runner environment, worker workspace, or admission payload.

- [ ] **Step 2: Add a route-resolution assertion.**
  - Resolve `chatgpt-web/chatgpt-free` through the same Gateway path used by `executeWorkerInference`.
  - Assert the resolved model API/base URL match the isolated adapter.
  - Assert `api.openai.com` is never selected by the fixture.

- [ ] **Step 3: Add an auth-ownership assertion.**
  - Use a unique secret sentinel.
  - Assert Gateway provider preparation can see/use the sentinel.
  - Assert the worker-inference request, worker admission payload, node runner environment, and terminal result do not contain it.
  - Assert logs/transcript projections used by the test do not contain the raw sentinel.

- [ ] **Step 4: Run the route/auth tests.**
  - Run: `pnpm test src/gateway/server-methods/m12-phase4.acceptance.test.ts src/agents/runtime-plan/prepare-auth.test.ts src/agents/runtime-plan/materialize-model.test.ts`
  - Expected: PASS.

### Task 4: Add the real isolated provider E2E harness

**Files:**

- Create: `src/gateway/server-methods/m12-phase4.acceptance.test.ts` if Task 3 has not already created it; otherwise extend the same acceptance harness.
- Create: an isolated test launcher/config only under a temporary runtime directory; do not commit runtime state.
- Modify: `docs/phase3-plan.md` only after the first complete Phase 4 evidence set.

**Interfaces:**

- Consumes: Phase 3 native specialist session/run path and Task 2 provider boundary.
- Produces: one coherent current-tree Phase 4 evidence bundle.

- [ ] **Step 1: Start an isolated ChatGPT Web adapter endpoint.**
  - Use a non-production port and isolated state/config.
  - The endpoint must be OpenAI-compatible at `/v1`.
  - It must exercise the real ChatGPT Free route/provider behavior required by the Phase 4 environment; do not replace it with a fake provider response if the acceptance claim is intended to be live.
  - Never start/reconfigure `127.0.0.1:8318`.

- [ ] **Step 2: Start an isolated Gateway from the exact current build.**
  - Use a fresh state directory and a unique FreeChatClaw task/admission/environment/node identity.
  - Confirm the built Gateway imports the current source revision.
  - Record build artifact path/hash and isolated ports before dispatch.

- [ ] **Step 3: Perform the existing Phase 3 admission/node/session flow.**
  - Reuse the proven Phase 3 native specialist path.
  - Do not add provider credentials to the runner.
  - Record sessionKey, native sessionId, native runId, environmentId, nodeId, leaseId, ownerEpoch, and modelRef.

- [ ] **Step 4: Execute one real provider-backed native turn.**
  - The worker-facing inference request contains only modelRef/context/options.
  - Gateway resolves the ChatGPT Web credential.
  - Gateway provider transport calls the isolated `/v1` endpoint.
  - Native worker tool execution remains the Phase 3 path; no local fallback.

- [ ] **Step 5: Capture provider-boundary evidence.**
  - Record provider/model/api/baseUrl from Gateway-side model attribution.
  - Record isolated adapter request metadata sufficient to prove the request reached the intended `/v1` endpoint.
  - Record that the adapter/provider request carried the Gateway-resolved credential only at the provider egress boundary.
  - Record negative evidence that the runner/node never received the raw credential.

- [ ] **Step 6: Verify terminal/native evidence.**
  - Native session/run must complete normally.
  - Existing Phase 3 proof must still be worker-created; Phase 4 must not create or repair it.
  - The terminal result must contain no credential sentinel.

### Task 5: Add credential-leak and forbidden-fallback regression coverage

**Files:**

- Create/modify: `src/gateway/server-methods/m12-phase4.acceptance.test.ts`
- Create/modify: `src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts`
- Modify: `src/agents/embedded-agent-runner/run/auth-store.test.ts` only if the current attempt-dispatch contract needs an explicit FreeChatClaw regression assertion.

**Interfaces:**

- Consumes: Gateway provider boundary and worker result paths.
- Produces: negative tests that fail if Phase 4 ever leaks credentials or falls back.

- [ ] **Step 1: Test worker request serialization.**
  - Serialize the exact `worker.inference.start` request.
  - Assert the raw credential sentinel is absent.
  - Assert there is no `apiKey`, `authorization`, `headers`, or provider-secret object in the request.

- [ ] **Step 2: Test runner/result serialization.**
  - Serialize the node runner result and terminal native result.
  - Assert the sentinel is absent.
  - Assert provider route details may be attributed as non-secret metadata, but credential material is never returned.

- [ ] **Step 3: Test fallback rejection.**
  - Remove the ChatGPT Web auth/profile or make the route invalid.
  - Assert the turn fails in Gateway provider preparation.
  - Assert no OpenAI Platform endpoint is selected.
  - Assert no local execution path is invoked.
  - Assert no second provider is silently selected.

- [ ] **Step 4: Run the negative suite.**
  - Run: `pnpm test src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts src/gateway/server-methods/m12-phase4.acceptance.test.ts src/agents/embedded-agent-runner/run/auth-store.test.ts`
  - Expected: PASS.

### Task 6: Current-tree Phase 4 validation and evidence gate

**Files:**

- Modify: `docs/phase3-plan.md` only after all gates pass.
- No implementation files should be changed during this task except a test fix that is directly proven necessary by a failing Phase 4 gate.

**Interfaces:**

- Consumes: all prior tasks and the exact build/runtime artifacts.
- Produces: a reproducible Phase 4 evidence record.

- [ ] **Step 1: Review the diff before build.**
  - Run: `git diff --check`
  - Run: `git diff --name-only -- /home/long/work/chatgpt-adapter/server.js /home/long/work/chatgpt-adapter/scripts/runner-agent-openclaw.js /home/long/work/chatgpt-adapter/tests/test-m12-runner-agent.js`
  - Expected: no forbidden adapter files in the diff.

- [ ] **Step 2: Scan the FreeChatClaw diff for forbidden mechanisms.**
  - Check the current diff for `OPENAI_API_KEY`, `--session-host`, `operator.admin`, local `sessions_spawn`, `tool_choice`, and any proof writer.
  - Expected: no newly added forbidden mechanism.

- [ ] **Step 3: Build the exact current tree.**
  - Run:
    ```bash
    timeout 240s env OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=6144 pnpm build
    rc=$?
    echo BUILD_EXIT=$rc
    exit $rc
    ```
  - Expected: explicit `BUILD_EXIT=0`.

- [ ] **Step 4: Run the Phase 4 focused suite from that tree.**
  - Run:
    ```bash
    pnpm test \\
      src/gateway/worker-environments/inference-runtime.m12-provider-boundary.test.ts \\
      src/gateway/server-methods/m12-phase4.acceptance.test.ts \\
      src/gateway/server-methods/m12-specialist.test.ts
    rc=$?
    echo PHASE4_FOCUSED_EXIT=$rc
    exit $rc
    ```
  - Expected: explicit zero exit and all Phase 4 tests passing.

- [ ] **Step 5: Run the isolated E2E against the exact build.**
  - Use a fresh state directory and fresh admission idempotency key.
  - Record:
    - Gateway build artifact/hash
    - isolated provider endpoint
    - provider/model/api
    - sessionKey/sessionId/runId
    - environment/node/lease/ownerEpoch
    - provider request attribution
    - credential sentinel negative checks
    - native terminal result
    - existing worker-created proof provenance.
  - Expected: all values belong to the same current-tree execution.

- [ ] **Step 6: Audit production safety.**
  - Inspect listeners for `127.0.0.1:9010` and `127.0.0.1:8318` only.
  - Expected: production processes were not restarted or repurposed.
  - Do not send Phase 4 test traffic to either production endpoint.

- [ ] **Step 7: TypeScript verification, only if feasible.**
  - Run:
    ```bash
    pnpm exec tsc --noEmit --pretty false
    rc=$?
    echo TSC_EXIT=$rc
    exit $rc
    ```
  - Claim TypeScript PASS only if the output contains `TSC_EXIT=0`. A timeout is not PASS.

- [ ] **Step 8: Write the Phase 4 evidence summary into `docs/phase3-plan.md`.**
  - Add a dated Phase 4 evidence section.
  - Include exact isolated provider endpoint, current build artifact, modelRef, session/run identity, and credential-boundary results.
  - Do not rewrite or upgrade the Phase 3 acceptance history.

## Phase 4 Acceptance Gate

Phase 4 is **PASS** only when one current-tree isolated evidence set demonstrates all of:

| Gate                  | Required evidence                                                 | Reject if                                 |
| --------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| P1 model identity     | `chatgpt-web/chatgpt-free` selected by native session             | provider/model silently changes           |
| P2 transport          | Gateway provider resolves isolated `/v1` endpoint                 | OpenAI Platform or production endpoint    |
| P3 Gateway auth owner | credential is resolved/used by Gateway provider transport         | credential enters worker/node             |
| P4 worker protocol    | worker-inference payload contains no provider credential          | secret appears in request/frame           |
| P5 runner boundary    | node runner/result contains no provider credential                | raw credential visible on node            |
| P6 provider request   | isolated adapter receives the Gateway provider request            | local/fake execution                      |
| P7 native result      | native session/run reaches terminal result                        | locally synthesized result                |
| P8 negative fallback  | invalid ChatGPT Web auth/route fails closed                       | fallback to OpenAI/local/another provider |
| P9 provenance         | all evidence belongs to the exact current build/tree              | historical/stale evidence                 |
| P10 safety            | production 9010/8318 untouched; forbidden adapter files unchanged | production impact or forbidden edit       |

## Stop Conditions

Stop the implementation instead of adding another workaround if any of the following occurs:

- Provider credential appears in a worker frame, node environment, runner result, transcript, or proof artifact.
- `OPENAI_API_KEY` is required or observed in the Phase 4 path.
- OpenAI Platform/API endpoint is selected.
- Provider route resolves outside the Gateway-owned provider boundary.
- The worker must receive the provider credential to complete inference.
- Provider failure triggers local execution or an unrelated provider fallback.
- Production 9010/8318 must be restarted or reconfigured to make the isolated test pass.
- A Phase 4 test requires weakening Phase 3 placement/auth invariants.
- Evidence comes from a historical build or stale runtime.
- A test can only pass by fabricating provider/tool/result evidence.

## Non-goals

- Phase 5 crash/isolation matrix.
- Phase 6 ten-role production-shaped E2E.
- Phase 7 overall FreeChatClaw acceptance.
- Production Gateway/adapter changes.
- Provider credential delivery to the runner.
- OpenAI Platform API integration.
- Replacing the existing native worker execution chain.
- Reintroducing `context.tools` dependency or `extraBody.tool_choice`.
- Changing the canonical FreeChatClaw profile from `coding`.

## Self-Review

### 1. Spec coverage

- Provider/model identity: Tasks 1–4.
- Gateway provider route: Tasks 2–4.
- ChatGPT Web endpoint proof: Tasks 3–4.
- Credential isolation: Tasks 1, 3, 5.
- Negative fallback: Task 5.
- Current-build evidence and production safety: Task 6.
- Phase 4 evidence update: Task 6.

### 2. Step scan

Every implementation step is one checkable action: write failing test, run it, add one boundary assertion, run focused tests, run isolated E2E, or capture one verification result. No step delegates an unspecified "appropriate" validation.

### 3. Type consistency

The plan keeps the existing worker-inference request type credential-free and treats Gateway-prepared auth as an internal provider-stream concern. No new worker credential field is introduced.

### 4. Review-focus coverage

All five review-focus failure classes have explicit tests in Tasks 1, 2, 3, and 5.

### 5. Proportion

The plan intentionally avoids redesigning the existing inference/auth stack. It adds only the smallest FreeChatClaw policy seam plus focused tests and an isolated E2E proof.

## Execution Handoff

The user has already supplied the execution method: patch the plan into the existing repo and keep it unstaged. Use the plan task-by-task; do not create commits. Review the plan before implementation.
