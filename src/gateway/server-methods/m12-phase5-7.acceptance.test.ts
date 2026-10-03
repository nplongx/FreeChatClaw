import { describe, expect, it, vi } from "vitest";
import { resolveCompletionFromSessionEntry } from "../../agents/subagents/registry/subagent-session-reconciliation.js";
import { STALE_WORKER_BUILD_REASON } from "../worker-environments/admission.js";
import {
  REQUEST,
  seedActivePlacement,
} from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "../worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import * as support from "../worker-environments/service.test-support.js";

const roles = [
  "planner",
  "architect",
  "researcher",
  "implementer",
  "tester",
  "reviewer",
  "security",
  "docs",
  "release",
  "integrator",
] as const;

describe("M12 Phase 5–7 acceptance harness", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("reclaims a disconnected stale worker placement through the real lifecycle reconciler", async () => {
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = createHarness(support.testState.stateDb, placements);
    seedAttachedPlacementEnvironment(support.testState.stateDb, {
      environmentId: harness.attached.environmentId,
      sessionId: REQUEST.sessionId,
      ownerEpoch: harness.attached.ownerEpoch,
    });
    const active = seedActivePlacement(placements, {
      environmentId: harness.attached.environmentId,
      ownerEpoch: harness.attached.ownerEpoch,
    });
    expect(active.state).toBe("active");

    support.testState.store.requestDestroy({
      environmentId: harness.attached.environmentId,
      state: "attached",
      terminalState: "failed",
      lastError: STALE_WORKER_BUILD_REASON,
    });
    support.testState.store.transition({
      environmentId: harness.attached.environmentId,
      from: "attached",
      to: "draining",
      patch: {
        tunnelStatus: "stopped",
        lastError: STALE_WORKER_BUILD_REASON,
      },
    });
    support.testState.store.transition({
      environmentId: harness.attached.environmentId,
      from: "draining",
      to: "destroying",
      patch: {
        destroyRequestedAtMs: 2,
        tunnelStatus: "stopped",
        lastError: STALE_WORKER_BUILD_REASON,
      },
    });
    support.testState.store.transition({
      environmentId: harness.attached.environmentId,
      from: "destroying",
      to: "failed",
      patch: {
        leaseId: null,
        nodeDeviceId: null,
        sshEndpoint: null,
        tunnelStatus: "stopped",
        teardownTerminalState: "failed",
        lastError: STALE_WORKER_BUILD_REASON,
        error: STALE_WORKER_BUILD_REASON,
      },
    });
    vi.mocked(harness.environments.get).mockReturnValue({
      ...support.testState.store.get(harness.attached.environmentId),
      error: STALE_WORKER_BUILD_REASON,
    });

    await harness.service.reconcileActive();

    expect(placements.get(REQUEST.sessionId)).toMatchObject({
      state: "reclaimed",
      turnClaim: null,
      terminalReason: null,
    });
    expect(harness.environments.destroy).not.toHaveBeenCalled();
  });

  it("builds CTO synthesis input only from fresh durable role completions", () => {
    const now = 10_000;
    const completionByRole = new Map(
      roles.map((role, index) => [
        role,
        resolveCompletionFromSessionEntry(
          {
            sessionId: `session-${role}`,
            status: "done",
            startedAt: now - 100 - index,
            endedAt: now - index,
            updatedAt: now - index,
          } as never,
          now,
          { notBeforeMs: now - 1_000 },
        ),
      ]),
    );

    expect(
      [...completionByRole.values()].every((completion) => completion?.outcome.status === "ok"),
    ).toBe(true);

    const synthesisInput = roles.map((role) => ({
      role,
      completion: completionByRole.get(role),
    }));

    expect(synthesisInput).toHaveLength(10);
    expect(synthesisInput.map((item) => item.role)).toEqual([...roles]);

    const stale = resolveCompletionFromSessionEntry(
      {
        sessionId: "session-stale",
        status: "done",
        startedAt: 100,
        endedAt: 200,
        updatedAt: 200,
      } as never,
      now,
      { notBeforeMs: now - 1_000 },
    );
    expect(stale).toBeNull();

    const interrupted = resolveCompletionFromSessionEntry(
      {
        sessionId: "session-interrupted",
        status: "interrupted",
        updatedAt: now,
      } as never,
      now,
    );
    expect(interrupted).toBeNull();
  });
});
