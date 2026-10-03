import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionDispatchHandlers } from "./sessions-dispatch.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";

type SpecialistReplay = {
  requestIdentity: string;
  result: Record<string, unknown>;
};

type SpecialistReplayState = {
  requestIdentity: string;
  completed?: SpecialistReplay;
  inflight?: Promise<Record<string, unknown> | undefined>;
};

const specialistReplayByContext = new WeakMap<object, Map<string, SpecialistReplayState>>();

type StartParams = {
  environmentId: string;
  admissionIdempotencyKey: string;
  leaseId: string;
  ownerEpoch: number;
  taskId: string;
  attempt: number;
  role: string;
  inputCommit: string;
  prompt: string;
  agentId?: string;
  waitTimeoutMs?: number;
};

type WaitParams = {
  environmentId: string;
  leaseId: string;
  ownerEpoch: number;
  taskId: string;
  attempt: number;
  runId: string;
  timeoutMs?: number;
};

function reject(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function requireNode(client: Parameters<GatewayRequestHandler>[0]["client"], respond: RespondFn) {
  if (client?.connect?.role !== "node") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "M12 specialist RPC requires node role"),
    );
    return undefined;
  }
  const nodeId = normalizeOptionalString(client.connect.device?.id);
  if (!nodeId) {
    respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, "node identity is required"));
    return undefined;
  }
  if ((client.connect.scopes ?? []).some((scope) => scope.startsWith("operator."))) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "node must not carry operator scopes"),
    );
    return undefined;
  }
  return nodeId;
}

function parseStart(params: unknown): StartParams | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const p = params as Record<string, unknown>;
  for (const key of [
    "environmentId",
    "admissionIdempotencyKey",
    "leaseId",
    "taskId",
    "role",
    "inputCommit",
    "prompt",
  ] as const) {
    if (typeof p[key] !== "string" || !p[key].trim()) return undefined;
  }
  if (!Number.isSafeInteger(p.ownerEpoch) || (p.ownerEpoch as number) < 0) return undefined;
  if (!Number.isSafeInteger(p.attempt) || (p.attempt as number) < 1) return undefined;
  if (p.agentId !== undefined && (typeof p.agentId !== "string" || !p.agentId.trim()))
    return undefined;
  if (
    p.waitTimeoutMs !== undefined &&
    (!Number.isSafeInteger(p.waitTimeoutMs) || (p.waitTimeoutMs as number) < 0)
  )
    return undefined;
  return {
    environmentId: p.environmentId as string,
    admissionIdempotencyKey: p.admissionIdempotencyKey as string,
    leaseId: p.leaseId as string,
    ownerEpoch: p.ownerEpoch as number,
    taskId: p.taskId as string,
    attempt: p.attempt as number,
    role: p.role as string,
    inputCommit: p.inputCommit as string,
    prompt: p.prompt as string,
    ...(p.agentId ? { agentId: p.agentId as string } : {}),
    ...(p.waitTimeoutMs !== undefined ? { waitTimeoutMs: p.waitTimeoutMs as number } : {}),
  };
}

function parseWait(params: unknown): WaitParams | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const p = params as Record<string, unknown>;
  for (const key of ["environmentId", "leaseId", "taskId", "runId"] as const) {
    if (typeof p[key] !== "string" || !p[key].trim()) return undefined;
  }
  if (!Number.isSafeInteger(p.ownerEpoch) || (p.ownerEpoch as number) < 0) return undefined;
  if (!Number.isSafeInteger(p.attempt) || (p.attempt as number) < 1) return undefined;
  if (
    p.timeoutMs !== undefined &&
    (!Number.isSafeInteger(p.timeoutMs) || (p.timeoutMs as number) < 0)
  )
    return undefined;
  return {
    environmentId: p.environmentId as string,
    leaseId: p.leaseId as string,
    ownerEpoch: p.ownerEpoch as number,
    taskId: p.taskId as string,
    attempt: p.attempt as number,
    runId: p.runId as string,
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs as number } : {}),
  };
}

async function callHandler(
  handler: GatewayRequestHandler,
  options: Omit<GatewayRequestHandlerOptions, "respond">,
): Promise<{ ok: boolean; payload?: unknown; error?: ReturnType<typeof errorShape> }> {
  let result: { ok: boolean; payload?: unknown; error?: ReturnType<typeof errorShape> } | undefined;
  await handler({
    ...options,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
  });
  return (
    result ?? {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "M12 specialist handler did not respond"),
    }
  );
}

function verifyEnvironmentBinding(
  context: Parameters<GatewayRequestHandler>[0]["context"],
  params: Pick<StartParams, "environmentId" | "leaseId" | "ownerEpoch"> & { nodeId: string },
  respond: RespondFn,
  allowedStates: readonly string[] = ["ready", "idle"],
): boolean {
  const service = context.workerEnvironmentService;
  if (!service) {
    reject(respond, "M12 specialist worker environment service unavailable");
    return false;
  }
  const environment = service.get(params.environmentId);
  if (!environment) {
    reject(respond, "M12 specialist environment not found");
    return false;
  }
  const admission = service.getCloudWorkerBootstrapCapability?.(params.environmentId);
  if (
    environment.nodeDeviceId !== params.nodeId ||
    admission?.leaseId !== params.leaseId ||
    environment.ownerEpoch !== params.ownerEpoch ||
    admission?.ownerEpoch !== params.ownerEpoch ||
    (admission?.expiresAtMs !== undefined && admission.expiresAtMs <= Date.now()) ||
    !allowedStates.includes(environment.state)
  ) {
    reject(respond, "M12 specialist environment binding is stale or mismatched");
    return false;
  }
  return true;
}

async function waitForEnvironmentReady(
  context: Parameters<GatewayRequestHandler>[0]["context"],
  params: Pick<StartParams, "environmentId" | "leaseId" | "ownerEpoch"> & { nodeId: string },
  signal?: AbortSignal,
): Promise<boolean> {
  const service = context.workerEnvironmentService;
  if (!service) return false;
  const deadline = Date.now() + 180_000;
  while (true) {
    signal?.throwIfAborted();
    const environment = service.get(params.environmentId);
    if (!environment) return false;
    if (
      ["destroyed", "failed", "orphaned"].includes(environment.state) ||
      environment.destroyRequestedAtMs !== null
    ) {
      return false;
    }
    if (
      environment.nodeDeviceId !== null &&
      environment.nodeDeviceId !== params.nodeId &&
      environment.state !== "provisioning"
    ) {
      return false;
    }
    if (environment.state === "ready" || environment.state === "idle") {
      const admission = service.getCloudWorkerBootstrapCapability?.(params.environmentId);
      return (
        environment.nodeDeviceId === params.nodeId &&
        admission?.leaseId === params.leaseId &&
        admission?.ownerEpoch === params.ownerEpoch &&
        environment.ownerEpoch === params.ownerEpoch
      );
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}

function sessionKeyFor(taskId: string, attempt: number): string {
  return "agent:m12-" + taskId + ":specialist:" + String(attempt);
}

function specialistReplayKey(params: { admissionIdempotencyKey: string }): string {
  return "m12:specialist:" + params.admissionIdempotencyKey;
}

function specialistRequestIdentity(p: StartParams, nodeId: string, agentId: string): string {
  return stableStringify({
    ...p,
    nodeId,
    agentId,
  });
}

export const m12SpecialistHandlers: GatewayRequestHandlers = {
  "m12.specialist.start": async ({
    params,
    respond,
    context,
    client,
    req,
    isWebchatConnect,
    signal,
  }) => {
    const nodeId = requireNode(client, respond);
    if (!nodeId) return;
    const p = parseStart(params);
    if (!p) return reject(respond, "invalid M12 specialist start request");
    if (!(await waitForEnvironmentReady(context, { ...p, nodeId }, signal))) {
      return reject(
        respond,
        "M12 specialist environment did not become ready with the admitted node binding",
      );
    }
    if (
      !verifyEnvironmentBinding(context, { ...p, nodeId }, respond, ["ready", "idle", "attached"])
    )
      return;

    const key = sessionKeyFor(p.taskId, p.attempt);
    const keyAgentId = parseAgentSessionKey(key)?.agentId;
    const agentId = normalizeOptionalString(p.agentId) ?? keyAgentId;
    if (!agentId) return reject(respond, "M12 specialist session key has no agent owner");
    if (keyAgentId && agentId !== keyAgentId) {
      return reject(respond, "M12 specialist agentId does not match session key owner");
    }
    const replayKey = specialistReplayKey({
      admissionIdempotencyKey: p.admissionIdempotencyKey,
    });
    const requestIdentity = specialistRequestIdentity(p, nodeId, agentId);
    let replayByKey = specialistReplayByContext.get(context);
    if (!replayByKey) {
      replayByKey = new Map();
      specialistReplayByContext.set(context, replayByKey);
    }
    const replay = replayByKey.get(replayKey);
    if (replay) {
      if (replay.requestIdentity !== requestIdentity) {
        return reject(
          respond,
          "M12 specialist idempotency key was reused with different parameters",
        );
      }
      if (replay.inflight) {
        const result = await replay.inflight;
        if (!result) {
          return reject(
            respond,
            "M12 specialist duplicate request replay has no successful result",
          );
        }
        return respond(true, result, undefined);
      }
      if (replay.completed) {
        return respond(true, replay.completed.result, undefined);
      }
    }

    let resolveReplay!: (result: Record<string, unknown> | undefined) => void;
    const replayPromise = new Promise<Record<string, unknown> | undefined>((resolve) => {
      resolveReplay = resolve;
    });
    replayByKey.set(replayKey, { inflight: replayPromise, requestIdentity });
    const existing = loadGatewaySessionEntryReadOnly(key, { agentId }).entry;
    if (existing?.sessionId) {
      const label = existing.label ?? "";
      const expectedBinding = [
        p.role,
        p.taskId,
        p.inputCommit,
        p.environmentId,
        p.leaseId,
        String(p.ownerEpoch),
        nodeId,
      ];
      if (!expectedBinding.every((value) => label.includes(value))) {
        replayByKey.delete(replayKey);
        resolveReplay(undefined);
        return reject(
          respond,
          "M12 specialist task key is already owned by a different task binding",
        );
      }
    }

    const created = existing?.sessionId
      ? { ok: true, payload: { key, sessionId: existing.sessionId, entry: existing } }
      : await callHandler(sessionCreateHandlers["sessions.create"]!, {
          req,
          params: {
            key,
            agentId,
            idempotencyKey: p.admissionIdempotencyKey,
            model: "chatgpt-web/chatgpt-free",
            worktree: true,
            worktreeSource: "empty",
            label:
              "M12 " +
              p.role +
              " " +
              p.taskId +
              " " +
              p.inputCommit +
              " " +
              p.environmentId +
              " " +
              p.leaseId +
              " " +
              String(p.ownerEpoch) +
              " " +
              nodeId,
          },
          context,
          client,
          isWebchatConnect,
          signal,
        });
    if (!created.ok) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return respond(
        false,
        undefined,
        created.error ?? errorShape(ErrorCodes.UNAVAILABLE, "native session creation failed"),
      );
    }
    const sessionId =
      typeof (created.payload as { sessionId?: unknown } | undefined)?.sessionId === "string"
        ? (created.payload as { sessionId: string }).sessionId
        : existing?.sessionId;
    if (!sessionId) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return reject(respond, "native session creation returned no sessionId");
    }

    const placement = await callHandler(sessionDispatchHandlers["sessions.dispatch"]!, {
      req,
      params: {
        key,
        agentId,
        deviceId: nodeId,
        placementBinding: {
          environmentId: p.environmentId,
          ownerEpoch: p.ownerEpoch,
          leaseId: p.leaseId,
          nodeDeviceId: nodeId,
        },
      },
      context,
      client,
      isWebchatConnect,
      sessionMutationAuthorization: undefined,
      signal,
    });
    if (!placement.ok) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return respond(
        false,
        undefined,
        placement.error ?? errorShape(ErrorCodes.UNAVAILABLE, "native worker placement failed"),
      );
    }

    const nativeExecCompat = /with exactly:\s*(.+?)\.\s+The command must actually execute/s
      .exec(p.prompt)?.[1]
      ?.trim();
    const message = [
      "agent=" + p.role,
      "M12 taskId=" + p.taskId,
      "attempt=" + String(p.attempt),
      "role=" + p.role,
      "input_commit=" + p.inputCommit,
      "environment_id=" + p.environmentId,
      "node_id=" + nodeId,
      "",
      p.prompt,
      "",
      "You are the native specialist worker. Complete the task in the assigned workspace.",
      "If the task requires an artifact, write it into the assigned workspace and report its path.",
      "EXECUTION WIRE CONTRACT — DO NOT ANSWER WITH A RESULT.",
      "When execution is required, the NEXT assistant response MUST be exactly one JSON tool-call object for the native exec tool, not prose and not a fabricated result.",
      'Exact shape: {"name":"exec","arguments":{"command":"<absolute command>"}}',
      "Use the exact command required by the task. Execute it in the assigned workspace before any final answer. Do not add markdown or explanatory text around the tool call.",
      ...(nativeExecCompat
        ? [
            "M12_NATIVE_EXEC_COMPAT with exactly: " +
              nativeExecCompat +
              ". The command must actually execute",
          ]
        : []),
    ].join("\n");
    const sent = await callHandler(sessionMessagingHandlers["sessions.send"]!, {
      req,
      params: {
        key,
        agentId,
        message,
        idempotencyKey: "m12:" + p.taskId + ":" + String(p.attempt),
      },
      context,
      client,
      isWebchatConnect,
      signal,
    });
    if (!sent.ok) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return respond(
        false,
        undefined,
        sent.error ?? errorShape(ErrorCodes.UNAVAILABLE, "native worker turn dispatch failed"),
      );
    }
    const runId = (sent.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId !== "string" || !runId) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return reject(respond, "native worker dispatch returned no runId");
    }

    const placementPayload = placement.payload as
      | { placement?: Record<string, unknown> }
      | undefined;
    const activeOwnerEpoch = placementPayload?.placement?.activeOwnerEpoch;
    if (
      typeof activeOwnerEpoch !== "number" ||
      !Number.isInteger(activeOwnerEpoch) ||
      activeOwnerEpoch < 1
    ) {
      replayByKey.delete(replayKey);
      resolveReplay(undefined);
      return reject(respond, "native worker placement returned no active owner epoch");
    }
    const result: Record<string, unknown> = {
      taskId: p.taskId,
      attempt: p.attempt,
      role: p.role,
      inputCommit: p.inputCommit,
      environmentId: p.environmentId,
      nodeId,
      ownerEpoch: activeOwnerEpoch,
      leaseId: p.leaseId,
      sessionKey: key,
      sessionId,
      runId,
      placement: placementPayload?.placement,
    };
    if (p.waitTimeoutMs !== undefined) {
      result.result = await createAgentTurnService({ context, isWebchatConnect }).waitForTurn({
        runId,
        timeoutMs: p.waitTimeoutMs,
      });
    }
    replayByKey.set(replayKey, { requestIdentity, completed: { requestIdentity, result } });
    resolveReplay(result);
    respond(true, result, undefined);
  },

  "m12.specialist.wait": async ({ params, respond, context, client, isWebchatConnect }) => {
    const nodeId = requireNode(client, respond);
    if (!nodeId) return;
    const p = parseWait(params);
    if (!p) return reject(respond, "invalid M12 specialist wait request");
    if (
      !verifyEnvironmentBinding(context, { ...p, nodeId }, respond, ["ready", "idle", "attached"])
    )
      return;
    const run = getAgentRunContext(p.runId);
    if (!run || run.sessionKey !== sessionKeyFor(p.taskId, p.attempt)) {
      return reject(respond, "M12 specialist run does not belong to this task");
    }
    const result = await createAgentTurnService({ context, isWebchatConnect }).waitForTurn({
      runId: p.runId,
      timeoutMs: p.timeoutMs ?? 30_000,
    });
    respond(
      true,
      {
        taskId: p.taskId,
        attempt: p.attempt,
        environmentId: p.environmentId,
        nodeId,
        ownerEpoch: p.ownerEpoch,
        leaseId: p.leaseId,
        sessionKey: run.sessionKey,
        sessionId: run.sessionId,
        runId: p.runId,
        result,
      },
      undefined,
    );
  },
};
