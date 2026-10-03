import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  dispatch: vi.fn(),
  send: vi.fn(),
  loadSession: vi.fn(),
  getRun: vi.fn(),
  waitForTurn: vi.fn(),
}));

vi.mock("./sessions-create.js", () => ({
  sessionCreateHandlers: { "sessions.create": mocks.create },
}));
vi.mock("./sessions-dispatch.js", () => ({
  sessionDispatchHandlers: { "sessions.dispatch": mocks.dispatch },
}));
vi.mock("./sessions-messaging.js", () => ({
  sessionMessagingHandlers: { "sessions.send": mocks.send },
}));
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));
vi.mock("../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: mocks.getRun,
}));
vi.mock("../agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ waitForTurn: mocks.waitForTurn }),
}));

import { m12SpecialistHandlers } from "./m12-specialist.js";

const NODE_ID = "m12-node-01";
const ENVIRONMENT_ID = "env-m12";
const LEASE_ID = "lease-m12";
const OWNER_EPOCH = 7;
const INPUT_COMMIT = "commit-m12";

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

function environment() {
  return {
    environmentId: ENVIRONMENT_ID,
    state: "ready",
    nodeDeviceId: NODE_ID,
    ownerEpoch: OWNER_EPOCH,
    destroyRequestedAtMs: null,
  };
}

function context() {
  return {
    workerEnvironmentService: {
      get: vi.fn((id: string) => (id === ENVIRONMENT_ID ? environment() : undefined)),
      getCloudWorkerBootstrapCapability: vi.fn(() => ({
        leaseId: LEASE_ID,
        ownerEpoch: OWNER_EPOCH,
        expiresAtMs: Date.now() + 60_000,
      })),
    },
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    connect: {
      role: "node",
      device: { id: NODE_ID },
      scopes: [],
      ...overrides,
    },
  };
}

async function start(
  role: string,
  overrides: Record<string, unknown> = {},
  clientOverrides: Record<string, unknown> = {},
  requestContext = context(),
) {
  const respond = vi.fn();
  await m12SpecialistHandlers["m12.specialist.start"]!({
    params: {
      environmentId: ENVIRONMENT_ID,
      admissionIdempotencyKey: "admit-" + role,
      leaseId: LEASE_ID,
      ownerEpoch: OWNER_EPOCH,
      taskId: "task-" + role,
      attempt: 1,
      role,
      inputCommit: INPUT_COMMIT,
      prompt: "do " + role,
      ...overrides,
    },
    respond,
    context: requestContext,
    client: client(clientOverrides),
    req: {},
    isWebchatConnect: false,
    signal: undefined,
  } as never);
  return respond;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadSession.mockReturnValue({ entry: undefined });
  mocks.create.mockImplementation(async ({ respond }) => {
    return respond(true, { sessionId: "native-session-1" }, undefined);
  });
  mocks.dispatch.mockImplementation(async ({ respond }) => {
    return respond(
      true,
      {
        placement: {
          deviceId: NODE_ID,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          activeOwnerEpoch: OWNER_EPOCH,
        },
      },
      undefined,
    );
  });
  mocks.send.mockImplementation(async ({ respond }) => {
    return respond(true, { runId: "native-run-1" }, undefined);
  });
  mocks.waitForTurn.mockResolvedValue({ status: "completed" });
});

describe("M12 specialist acceptance harness", () => {
  it.each([
    ["non-node client", client({ role: "operator" })],
    ["missing node identity", client({ device: { id: "" } })],
  ])("rejects %s before native session creation", async (_case, requestClient) => {
    const respond = vi.fn();
    await m12SpecialistHandlers["m12.specialist.start"]!({
      params: {
        environmentId: ENVIRONMENT_ID,
        admissionIdempotencyKey: "admit-authz",
        leaseId: LEASE_ID,
        ownerEpoch: OWNER_EPOCH,
        taskId: "task-authz",
        attempt: 1,
        role: "reviewer",
        inputCommit: INPUT_COMMIT,
        prompt: "authz",
      },
      respond,
      context: context(),
      client: requestClient,
      req: {},
      isWebchatConnect: false,
    } as never);
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong node", {}, { device: { id: "other-node" } }],
    ["wrong lease", { leaseId: "other-lease" }],
    ["wrong epoch", { ownerEpoch: OWNER_EPOCH + 1 }],
    ["missing environment", { environmentId: "missing-env" }],
  ])("fails closed on %s binding", async (_case, mutation, clientMutation = {}) => {
    const respond = await start("reviewer", mutation, clientMutation);
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires native run identity and never fabricates one", async () => {
    mocks.send.mockImplementationOnce(async ({ respond }) => {
      respond(true, {}, undefined);
    });
    const respond = await start("tester");
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(respond.mock.calls[0]?.[2]?.message).toContain("no runId");
  });

  it("rejects an existing session owned by a conflicting task binding", async () => {
    mocks.loadSession.mockReturnValue({
      entry: {
        sessionId: "native-existing",
        label:
          "M12 reviewer task-reviewer " +
          INPUT_COMMIT +
          " " +
          ENVIRONMENT_ID +
          " " +
          LEASE_ID +
          " " +
          OWNER_EPOCH +
          " other-node",
      },
    });
    const respond = await start("reviewer");
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(respond.mock.calls[0]?.[2]?.message).toContain(
      "already owned by a different task binding",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is idempotent for an existing matching native session", async () => {
    mocks.loadSession.mockReturnValue({
      entry: {
        sessionId: "native-existing",
        label:
          "M12 reviewer task-reviewer " +
          INPUT_COMMIT +
          " " +
          ENVIRONMENT_ID +
          " " +
          LEASE_ID +
          " " +
          OWNER_EPOCH +
          " " +
          NODE_ID,
      },
    });
    const respond = await start("reviewer");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: "native-existing",
        runId: "native-run-1",
        nodeId: NODE_ID,
        leaseId: LEASE_ID,
        ownerEpoch: OWNER_EPOCH,
      }),
      undefined,
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ deviceId: NODE_ID }),
      }),
    );
  });

  it("replays the same runId for an exact duplicate start and rejects parameter drift", async () => {
    const requestContext = context();
    mocks.send
      .mockImplementationOnce(async ({ respond }) => {
        return respond(true, { runId: "native-run-original" }, undefined);
      })
      .mockImplementationOnce(async ({ respond }) => {
        return respond(true, { runId: "native-run-should-not-exist" }, undefined);
      });
    const first = await start("reviewer", {}, {}, requestContext);
    const second = await start("reviewer", {}, {}, requestContext);
    expect(first).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "native-run-original" }),
      undefined,
    );
    expect(second).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "native-run-original" }),
      undefined,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);

    const drifted = await start("reviewer", { prompt: "different prompt" }, {}, requestContext);
    expect(drifted).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(drifted.mock.calls[0]?.[2]?.message).toContain(
      "idempotency key was reused with different parameters",
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("rejects admission-key reuse with a conflicting task binding before native dispatch", async () => {
    const requestContext = context();
    const first = await start(
      "reviewer",
      { admissionIdempotencyKey: "shared-admission" },
      {},
      requestContext,
    );
    expect(first).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId: "native-run-1" }),
      undefined,
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);

    const conflicting = await start(
      "reviewer",
      {
        admissionIdempotencyKey: "shared-admission",
        taskId: "task-different",
      },
      {},
      requestContext,
    );
    expect(conflicting).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(conflicting.mock.calls[0]?.[2]?.message).toContain(
      "idempotency key was reused with different parameters",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired lease before native session creation", async () => {
    const expiredContext = context();
    expiredContext.workerEnvironmentService.getCloudWorkerBootstrapCapability.mockReturnValue({
      leaseId: LEASE_ID,
      ownerEpoch: OWNER_EPOCH,
      expiresAtMs: Date.now() - 1,
    });
    const respond = await start("reviewer", {}, {}, expiredContext);
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(respond.mock.calls[0]?.[2]?.message).toContain("stale or mismatched");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a destroyed environment before native session creation", async () => {
    const destroyedContext = context();
    destroyedContext.workerEnvironmentService.get.mockReturnValue({
      ...environment(),
      state: "destroyed",
    });
    const respond = await start("reviewer", {}, {}, destroyedContext);
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an existing task session bound to another environment or lease", async () => {
    mocks.loadSession.mockReturnValue({
      entry: {
        sessionId: "native-existing",
        label:
          "M12 reviewer task-reviewer " +
          INPUT_COMMIT +
          " other-env other-lease " +
          OWNER_EPOCH +
          " " +
          NODE_ID,
      },
    });
    const respond = await start("reviewer");
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("runs the frozen ten-role workflow with one exact admitted node binding", async () => {
    for (const [index, role] of roles.entries()) {
      mocks.create.mockImplementationOnce(async ({ respond }) => {
        return respond(true, { sessionId: "native-session-" + (index + 1) }, undefined);
      });
      mocks.send.mockImplementationOnce(async ({ respond }) => {
        return respond(true, { runId: "native-run-" + (index + 1) }, undefined);
      });
      const respond = await start(role);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          taskId: "task-" + role,
          attempt: 1,
          role,
          sessionKey: "agent:m12-task-" + role + ":specialist:1",
          sessionId: "native-session-" + (index + 1),
          runId: "native-run-" + (index + 1),
          nodeId: NODE_ID,
          environmentId: ENVIRONMENT_ID,
          leaseId: LEASE_ID,
          ownerEpoch: OWNER_EPOCH,
        }),
        undefined,
      );
    }
    expect(mocks.create).toHaveBeenCalledTimes(10);
    expect(mocks.dispatch).toHaveBeenCalledTimes(10);
    expect(mocks.send).toHaveBeenCalledTimes(10);
    expect(mocks.dispatch.mock.calls.every(([call]) => call.params.deviceId === NODE_ID)).toBe(
      true,
    );
    expect(
      mocks.send.mock.calls.every(
        ([call]) => !String(call.params.message).includes("OPENAI_API_KEY"),
      ),
    ).toBe(true);
  });

  it("wait requires the native run to belong to the exact task and attempt", async () => {
    mocks.getRun.mockReturnValue({
      sessionKey: "agent:m12-task-reviewer:specialist:1",
      sessionId: "native-session-1",
    });
    const respond = vi.fn();
    await m12SpecialistHandlers["m12.specialist.wait"]!({
      params: {
        environmentId: ENVIRONMENT_ID,
        leaseId: LEASE_ID,
        ownerEpoch: OWNER_EPOCH,
        taskId: "task-reviewer",
        attempt: 1,
        runId: "native-run-1",
      },
      respond,
      context: context(),
      client: client(),
      req: {},
      isWebchatConnect: false,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionId: "native-session-1",
        runId: "native-run-1",
      }),
      undefined,
    );

    mocks.getRun.mockReturnValue({
      sessionKey: "agent:m12-other-task:specialist:1",
      sessionId: "native-session-other",
    });
    const rejected = vi.fn();
    await m12SpecialistHandlers["m12.specialist.wait"]!({
      params: {
        environmentId: ENVIRONMENT_ID,
        leaseId: LEASE_ID,
        ownerEpoch: OWNER_EPOCH,
        taskId: "task-reviewer",
        attempt: 1,
        runId: "native-run-other",
      },
      respond: rejected,
      context: context(),
      client: client(),
      req: {},
      isWebchatConnect: false,
    } as never);
    expect(rejected).toHaveBeenCalledWith(false, undefined, expect.any(Object));
    expect(mocks.waitForTurn).toHaveBeenCalledTimes(1);
  });
});
