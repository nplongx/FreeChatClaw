import fs from "node:fs/promises";
/** CLI runner for node-host stdin/stdout command dispatch. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { copyConfigResolutionFactsExcept } from "../config/resolution-facts.js";
import { GatewayClientRequestError, type GatewayReconnectPausedInfo } from "../gateway/client.js";
import { resolveGatewayCredentialsWithSecretInputs } from "../gateway/credentials-secret-inputs.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import { loadDeviceAuthTokenReadOnly } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { logInfo } from "../logger.js";
import { VERSION } from "../version.js";
import { configureNodeHost, loadNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { startNodeHostConnection } from "./connection.js";
import {
  createNodeHostGatewayCandidateConnection,
  formatGatewayCandidateUrl,
} from "./gateway-candidate-connection.js";
import {
  resolveNodeHostCloudflareAccess,
  type NodeHostCloudflareAccessConfig,
} from "./gateway-cloudflare-access.js";
import { resolveNodeHostGatewayPlatformIdentity } from "./gateway-platform-identity.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokeInputPayload,
  coerceNodeInvokePayload,
} from "./invoke-payload.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { runStartupMigrations } from "./startup-state-migrations.js";

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: NodeHostCloudflareAccessConfig;
  gatewayCandidates?: NodeHostGatewayConfig[];
  gatewayBootstrapToken?: string;
  preferGatewayBootstrapToken?: boolean;
  /** Stop cleanly after the first authenticated hello (used before service install). */
  stopAfterFirstConnect?: boolean;
  /** Host worker sessions for this process even when durable node config is disabled. */
  forceWorkerRuns?: boolean;
  /** Disposable cloud host: computer control stays on the private environment carrier. */
  ephemeral?: boolean;
  /** Optional WebSocket context path (e.g. "/openclaw-gw"). */
  gatewayContextPath?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
};

async function runM12SpecialistRequest(
  client: { request: (method: string, params: unknown) => Promise<unknown> },
  finish: (exitCode: number) => Promise<void>,
): Promise<void> {
  const requestFile = process.env.OPENCLAW_M12_SPECIALIST_REQUEST_FILE?.trim();
  const resultFile = process.env.OPENCLAW_M12_SPECIALIST_RESULT_FILE?.trim();
  if (!requestFile || !resultFile) {
    return;
  }
  try {
    const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
    let result: unknown;
    let lastError: unknown;
    const { waitTimeoutMs, ...startRequest } = request as Record<string, unknown>;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        // Phase 3 deliberately separates dispatch from completion.  Holding the
        // start RPC open until the model turn finishes lets a slow Web-backed
        // provider outlive the request/connection retry window and can cause the
        // ephemeral node tunnel to be torn down while the native worker is still
        // running.  `m12.specialist.wait` owns the bounded completion wait.
        result = await client.request("m12.specialist.start", startRequest);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (
          !String(error).includes(
            "M12 specialist environment did not become ready with the admitted node binding",
          ) &&
          !String(error).includes("gateway request timeout for m12.specialist.start")
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (lastError !== undefined) {
      throw lastError;
    }
    if (
      waitTimeoutMs !== undefined &&
      typeof result === "object" &&
      result !== null &&
      typeof (result as Record<string, unknown>).runId === "string"
    ) {
      const run = result as Record<string, unknown>;
      const waitRequest = {
        environmentId: run.environmentId,
        leaseId: run.leaseId,
        ownerEpoch: run.ownerEpoch,
        taskId: run.taskId,
        attempt: run.attempt,
        runId: run.runId,
        timeoutMs: waitTimeoutMs,
      };
      result = await client.request("m12.specialist.wait", waitRequest, {
        timeoutMs: waitTimeoutMs + 10_000,
      });
    }
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    await finish(0);
  } catch (error) {
    await fs
      .writeFile(resultFile, JSON.stringify({ ok: false, error: String(error) }, null, 2) + "\n", {
        mode: 0o600,
      })
      .catch(() => undefined);
    await finish(1);
  }
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

const NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES: ReadonlySet<string> = new Set([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
  ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
]);

type NodeHostReconnectPausedDeps = {
  writeLine?: (message: string) => void;
  exit?: (code: number) => void;
};

function shouldExitNodeHostOnReconnectPaused(detailCode: string | null): boolean {
  return detailCode !== null && NODE_HOST_EXIT_ON_RECONNECT_PAUSE_CODES.has(detailCode);
}

function formatNodeHostReconnectPausedMessage(
  info: GatewayReconnectPausedInfo,
  params?: { exiting?: boolean },
): string {
  const detail = info.detailCode ? ` detail=${info.detailCode}` : "";
  const reason = info.reason.trim() || "no close reason";
  const action = params?.exiting ? "exiting for supervisor restart" : "waiting for operator action";
  return `node host gateway reconnect paused after close (${info.code}): ${reason}${detail}; ${action}`;
}

function handleNodeHostReconnectPaused(
  info: GatewayReconnectPausedInfo,
  deps: NodeHostReconnectPausedDeps = {},
): void {
  const shouldExit = shouldExitNodeHostOnReconnectPaused(info.detailCode);
  const writeLine = deps.writeLine ?? writeStderrLine;
  writeLine(formatNodeHostReconnectPausedMessage(info, { exiting: shouldExit }));
  if (!shouldExit) {
    return;
  }
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  exit(1);
}

async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  savedGateway?: NodeHostGatewayConfig;
  gatewayCandidates: readonly NodeHostGatewayConfig[];
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const env = params.env ?? process.env;
  const savedGatewayScope = params.savedGateway
    ? gatewayOriginScope(formatGatewayCandidateUrl(params.savedGateway))
    : undefined;
  if (
    savedGatewayScope &&
    params.gatewayCandidates.every(
      (candidate) => gatewayOriginScope(formatGatewayCandidateUrl(candidate)) === savedGatewayScope,
    ) &&
    loadDeviceAuthTokenReadOnly({ deviceId: params.deviceId, role: "node", env })?.token
  ) {
    // A co-located Gateway's shared password must not displace the paired node
    // credential. GatewayClient rereads the current token when connecting.
    return resolveExplicitGatewayAuth({
      token: env.OPENCLAW_GATEWAY_TOKEN,
      password: env.OPENCLAW_GATEWAY_PASSWORD,
    });
  }
  const mode = params.config.gateway?.mode === "remote" ? "remote" : "local";
  const configForResolution =
    mode === "local" ? buildNodeHostLocalAuthConfig(params.config) : params.config;
  return await resolveGatewayCredentialsWithSecretInputs({
    config: configForResolution,
    env,
    localPrecedence: "env-first",
    remoteTokenPrecedence: "env-first",
    remotePasswordPrecedence: "env-first", // pragma: allowlist secret
  });
}

function buildNodeHostLocalAuthConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.gateway?.remote?.token && !config.gateway?.remote?.password) {
    return config;
  }
  const nextConfig = structuredClone(config);
  copyConfigResolutionFactsExcept(config, nextConfig, [
    "gateway.remote.token",
    "gateway.remote.password",
  ]);
  if (nextConfig.gateway?.remote) {
    // Local node-host must not inherit gateway.remote.* auth material, which can
    // suppress GatewayClient device-token fallback and cause local token mismatches.
    nextConfig.gateway.remote.token = undefined;
    nextConfig.gateway.remote.password = undefined;
  }
  return nextConfig;
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  // Operator-approved startup is a second authorized entry point for Doctor-owned
  // state migrators. Runtime invokes those owners here and never migrates inline.
  await runStartupMigrations({ log: { info: writeStderrLine, warn: writeStderrLine } });
  const cfg = getRuntimeConfig();
  const savedConfig = await loadNodeHostConfig();
  const plannedGateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? cfg.gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
    contextPath: opts.gatewayContextPath,
    cloudflareAccess: opts.gatewayCloudflareAccess,
  };
  const fallbackDisplayName = await getMachineDisplayName();
  const config = await configureNodeHost({
    nodeId: opts.nodeId,
    displayName: opts.displayName,
    fallbackDisplayName,
    gateway: plannedGateway,
    installedAppsSharing: opts.installedAppsSharing,
    commands: opts.commands,
    allCommands: opts.allCommands,
  });
  const nodeId = config.nodeId;
  const displayName = config.displayName ?? fallbackDisplayName;
  const gateway = config.gateway ?? plannedGateway;
  const gatewayCandidates = opts.gatewayCandidates?.length
    ? opts.gatewayCandidates.map((candidate, index) =>
        index === 0 && gateway.cloudflareAccess && !candidate.cloudflareAccess
          ? { ...candidate, cloudflareAccess: gateway.cloudflareAccess }
          : candidate,
      )
    : [gateway];

  const plaintextAccessCandidate = gatewayCandidates.find(
    (candidate) => candidate.cloudflareAccess && candidate.tls !== true,
  );
  if (plaintextAccessCandidate) {
    throw new Error("Cloudflare Access credentials require a TLS Gateway connection");
  }

  const resolvedCloudflareAccess = await Promise.all(
    gatewayCandidates.map(
      async (candidate) =>
        await resolveNodeHostCloudflareAccess({
          value: candidate.cloudflareAccess,
          config: cfg,
          env: process.env,
        }),
    ),
  );
  const cloudflareAccessByCandidate = new Map<NodeHostGatewayConfig, CloudflareAccessCredentials>();
  gatewayCandidates.forEach((candidate, index) => {
    const credentials = resolvedCloudflareAccess[index];
    if (credentials) {
      cloudflareAccessByCandidate.set(candidate, credentials);
    }
  });
  const preparedRuntime = await prepareNodeHostRuntime({
    config: cfg,
    env: process.env,
    enableAgentRuns: true,
    enableWorkerRuns: true,
    forceWorkerRuns: opts.forceWorkerRuns,
    ephemeral: opts.ephemeral,
    installedAppsSharingEnabled: config.installedAppsSharing,
    commands: config.commands,
  });
  logInfo(`node-host: advertised commands: ${preparedRuntime.manifest.commands.join(", ")}`);
  const deviceIdentity = loadOrCreateDeviceIdentity();
  const { token, password } = opts.gatewayBootstrapToken
    ? {}
    : await resolveNodeHostGatewayCredentials({
        config: cfg,
        savedGateway: savedConfig?.gateway,
        gatewayCandidates,
        deviceId: deviceIdentity.deviceId,
        env: process.env,
      });

  let consecutivePermanentGatewayRejections = 0;
  const persistWinningGateway = (winningGateway: NodeHostGatewayConfig) => {
    void configureNodeHost({
      nodeId,
      displayName,
      fallbackDisplayName,
      gateway: winningGateway,
      installedAppsSharing: config.installedAppsSharing,
    }).catch((error: unknown) => {
      writeStderrLine(`node host gateway endpoint persistence failed: ${String(error)}`);
    });
  };

  const client = createNodeHostGatewayCandidateConnection({
    candidates: gatewayCandidates,
    cloudflareAccessByCandidate,
    clientOptions: {
      token: token || undefined,
      bootstrapToken: opts.gatewayBootstrapToken,
      preferBootstrapToken: opts.preferGatewayBootstrapToken,
      password: password || undefined,
      instanceId: nodeId,
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: displayName,
      clientVersion: VERSION,
      ...resolveNodeHostGatewayPlatformIdentity(process.platform),
      mode: GATEWAY_CLIENT_MODES.NODE,
      role: "node",
      scopes: [],
      // Pair the built-in MCP command family up front. Server inventory is
      // restart-scoped availability, not a capability upgrade requiring re-pairing.
      caps: preparedRuntime.manifest.caps,
      commands: preparedRuntime.manifest.commands,
      computerUse: preparedRuntime.manifest.computerUse,
      pathEnv: preparedRuntime.manifest.pathEnv,
      permissions: undefined,
      deviceIdentity,
    },
    onEvent: (evt) => {
      if (evt.event === "node.pair.resolved") {
        if (
          isRecord(evt.payload) &&
          evt.payload.nodeId === deviceIdentity.deviceId &&
          evt.payload.decision === "approved"
        ) {
          activeRuntime.refreshRunnerInventory();
        }
        return;
      }
      if (evt.event === "node.invoke.cancel") {
        const payload = coerceNodeInvokeCancelPayload(evt.payload);
        if (payload) {
          activeRuntime.cancel(payload.invokeId);
        }
        return;
      }
      if (evt.event === "node.invoke.input") {
        const payload = coerceNodeInvokeInputPayload(evt.payload);
        if (payload) {
          activeRuntime.handleInput(payload.invokeId, payload.seq, payload.payloadJSON);
        }
        return;
      }
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (payload) {
        void activeRuntime.invoke(payload);
      }
    },
    onHelloOk: (hello, url, tlsFingerprint, cloudflareAccess) => {
      consecutivePermanentGatewayRejections = 0;
      writeStderrLine(`node host gateway connected: ${url}`);
      if (opts.stopAfterFirstConnect) {
        void finish(0);
        return;
      }
      const specialistOnly = Boolean(
        process.env.OPENCLAW_M12_SPECIALIST_REQUEST_FILE &&
        process.env.OPENCLAW_M12_SPECIALIST_RESULT_FILE,
      );
      activeRuntime.connect({
        url,
        protocol: hello.protocol,
        capabilities: hello.features?.capabilities ?? [],
        ...(tlsFingerprint ? { tlsFingerprint } : {}),
        ...(cloudflareAccess ? { cloudflareAccess } : {}),
      });
      if (specialistOnly) {
        writeStderrLine("m12 specialist request scheduled");
        setTimeout(() => {
          writeStderrLine("m12 specialist request dispatching");
          void runM12SpecialistRequest(client, finish);
        }, 1000);
      }
    },
    onConnectError: (error) => {
      writeStderrLine(`node host gateway connect failed: ${error.message}`);
      const rejection =
        error instanceof GatewayClientRequestError && isRecord(error.details)
          ? error.details
          : undefined;
      if (
        rejection?.reason !== "websocket-upgrade-rejected" ||
        rejection.httpStatus !== 403 ||
        rejection.gatewayErrorType !== "proxy_attribution_required"
      ) {
        consecutivePermanentGatewayRejections = 0;
        return;
      }
      if (++consecutivePermanentGatewayRejections < 3) {
        return;
      }
      const remediation =
        typeof rejection.gatewayErrorMessage === "string"
          ? rejection.gatewayErrorMessage
          : error.message;
      writeStderrLine(
        `node host gateway permanently rejected connection (${rejection.gatewayErrorType}): ${remediation}; exiting`,
      );
      void finish(1);
    },
    onReconnectPaused: (info) => {
      handleNodeHostReconnectPaused(info, {
        exit: (code) => {
          client.stop();
          // Terminal auth/version pauses restart under a supervisor; close MCP
          // subprocesses first so restart loops cannot orphan server processes.
          void activeRuntime.close().finally(() => process.exit(code));
        },
      });
    },
    onClose: (code, reason) => {
      activeRuntime.disconnect();
      writeStderrLine(`node host gateway closed (${code}): ${reason}`);
    },
    onWinningCandidate: persistWinningGateway,
  });
  const activeRuntime = startNodeHostConnection({
    prepared: preparedRuntime,
    client,
    writeStderrLine,
    onManifestChanged: (manifest) => client.updateNodeManifest(manifest),
  });

  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  // A pending Promise alone does not keep Node alive. Pairing pauses can close
  // the last socket, so retain a handle until a signal finishes the foreground host.
  const lifetimeInterval = setInterval(() => {}, 1_000_000);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const stopClientAndMcp = async () => {
    client.stop();
    try {
      await activeRuntime.close();
    } finally {
      clearInterval(lifetimeInterval);
    }
  };
  const finish = async (exitCode: number) => {
    if (stopping) {
      return;
    }
    stopping = true;
    removeSignalHandlers();
    try {
      await stopClientAndMcp();
    } finally {
      process.exitCode = exitCode;
      resolveStopped?.();
    }
  };
  const onSigint = () => void finish(130);
  const onSigterm = () => void finish(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const readinessPromise = startGatewayClientWhenEventLoopReady(client);
  let readiness;
  try {
    readiness = await readinessPromise;
  } catch (error) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw error;
  }
  if (!readiness.ready) {
    if (stopping) {
      await stopped;
      return;
    }
    removeSignalHandlers();
    await stopClientAndMcp();
    throw new Error("node host gateway event loop readiness timeout");
  }
  await stopped;
}
