import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { decodePairingSetupCode } from "../pairing/setup-code.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { WorkerExecutionMode, WorkerProfile } from "../plugins/types.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeEnvState,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import type { WorkerBundleProducer, WorkerNpmArtifact } from "./worker-environments/bundle.js";
import {
  bindDeviceWorkerAvailability,
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  DEVICE_WORKER_PROVIDER_ID,
} from "./worker-environments/device-provider.js";
import type { WorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import type { createNodeBootstrapArtifactProvider } from "./worker-environments/node-bootstrap-artifact.js";
import { createWorkerNodeEnrollmentManager } from "./worker-environments/node-enrollment.js";
import type { NodeWorkerBundleTransferHttpCallback } from "./worker-environments/node-worker-bundle-transfer-http.js";
import { nodeWorkerGatewayNamespace as resolveNodeWorkerGatewayNamespace } from "./worker-environments/node-worker-gateway-namespace.js";
import type { NodeWorkerWorkspaceBindingResolver } from "./worker-environments/node-worker-tunnel.js";
import type { NodeWorkerBundleRetention } from "./worker-environments/node-workspace-retain-coordinator.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerTunnelManager } from "./worker-environments/tunnel.js";
import type { WorkerBootstrapArtifactTransferHttpCallback } from "./worker-environments/worker-bootstrap-artifact-transfer-http.js";
import { listRetainedWorkerBundleHashes } from "./worker-environments/worker-bundle-retention.js";

type WorkerEnvironmentStore = ReturnType<
  typeof import("./worker-environments/store.js").createWorkerEnvironmentStore
>;
type WorkerEnvironmentRecord = ReturnType<WorkerEnvironmentStore["list"]>[number];
type WorkerSessionToolExecutor = ReturnType<
  typeof import("./worker-environments/worker-session-tool-executor.js").createWorkerSessionToolExecutor
>;
type WorkerEnvironmentLogger = {
  child: (name: string) => { warn: (message: string) => void };
};

export type GatewayWorkerEnvironmentStartupState = {
  durableProviderIds: string[];
  listDurableProviderIds: () => string[];
  records: WorkerEnvironmentRecord[];
  store: WorkerEnvironmentStore;
  placementStore: WorkerSessionPlacementStore;
};

export type GatewayWorkerEnvironmentRuntime = {
  workerEnvironmentService?: WorkerEnvironmentService;
  reclaimCloudWorkerNode?: (nodeId: string) => Promise<readonly string[]>;
  workerLiveEvents?: WorkerLiveEventReceiver;
  workerTunnelManager?: WorkerTunnelManager;
  nodeWorkerGatewayNamespace?: string;
  nodeWorkerBundleRetention?: NodeWorkerBundleRetention;
  bindWorkerSessionDispatch?: (dispatch: WorkerPlacementDispatchContract["dispatch"]) => void;
  bindDeviceNodeControl?: (transport: NodeWorkerSupervisorTransport) => void;
  bindWorkerNodeDesktopControl?: (transport: NodeWorkerSupervisorTransport) => void;
  bindNodeWorkspaceBindingResolver?: (resolver: NodeWorkerWorkspaceBindingResolver) => void;
  handleNodeWorkerBundleTransferRequest?: NodeWorkerBundleTransferHttpCallback;
  handleWorkerBootstrapArtifactTransferRequest?: WorkerBootstrapArtifactTransferHttpCallback;
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
};

const loadWorkerEnvironmentRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/runtime.js"),
);
const loadWorkerInferenceRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/inference-runtime.js"),
);
const loadWorkerSessionToolExecutorModule = createLazyRuntimeModule(
  () => import("./worker-environments/worker-session-tool-executor.js"),
);

export async function loadGatewayWorkerEnvironmentStartupState(): Promise<GatewayWorkerEnvironmentStartupState> {
  const [{ createWorkerEnvironmentStore }, { createWorkerSessionPlacementStore }] =
    await Promise.all([
      import("./worker-environments/store.js"),
      import("./worker-environments/placement-store.js"),
    ]);
  const store = createWorkerEnvironmentStore();
  const placementStore = createWorkerSessionPlacementStore();
  const records = store.list();
  const durableProviderIds = uniqueStrings(
    records.flatMap((record) =>
      record.state === "destroyed" || record.state === "failed" || record.state === "orphaned"
        ? []
        : record.providerId === DEVICE_WORKER_PROVIDER_ID
          ? []
          : [record.providerId],
    ),
  );
  const listDurableProviderIds = () =>
    uniqueStrings(
      store
        .listForReconcile()
        .filter((record) => record.providerId !== DEVICE_WORKER_PROVIDER_ID)
        .map((record) => record.providerId),
    );
  return {
    durableProviderIds,
    listDurableProviderIds,
    records,
    store,
    placementStore,
  };
}

export async function createGatewayWorkerEnvironmentRuntime(params: {
  getPluginRegistry: () => PluginRegistry;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  getPortalRuntime: () => Pick<GatewayRequestContext, "portalService" | "broadcast"> | undefined;
  resolveGatewayContext: GatewayContextResolver;
  desktopSessionRegistry: DesktopSessionRegistry;
  nodeDesktopStreamBroker?: NodeDesktopStreamBroker;
  startup: GatewayWorkerEnvironmentStartupState;
  log: WorkerEnvironmentLogger;
}): Promise<GatewayWorkerEnvironmentRuntime> {
  const deviceRuntime = createDeviceWorkerRuntime({ getPairedDevice });
  const [
    { createWorkerEnvironmentService },
    { createWorkerLiveEventReceiver },
    { createWorkerSessionPlacementGate },
    { createWorkerTranscriptCommitter },
    { createWorkerTunnelManager },
    { createNodeWorkerTunnelManager },
    { createNodeWorkerPreparedWorkspaceTransport },
    { createGatewayNodeWorkerBundleInstaller },
    { createNodeWorkerBundleTransferService },
    { createNodeWorkerBundleTransferHttpCallback },
    { createNodeWorkspaceTransferService },
    { createNodeWorkspaceTransferHttpCallback },
    { createWorkerNodeDesktopCarrier },
    { createWorkerNodePortalCarrier },
    { createWorkerComputerService },
    { resolveWorkerProvider },
    { maintainConfiguredWorkerProviders },
    { createWorkerBootstrapArtifactTransferService },
    { createWorkerBootstrapArtifactTransferHttpCallback },
  ] = await Promise.all([
    import("./worker-environments/service.js"),
    import("./worker-environments/live-events.js"),
    import("./worker-environments/placement-worker-gate.js"),
    import("./worker-environments/transcript-commit.js"),
    import("./worker-environments/tunnel.js"),
    import("./worker-environments/node-worker-tunnel.js"),
    import("./worker-environments/node-worker-prepared-workspace-transport.js"),
    import("./worker-environments/node-worker-bundle-installer.js"),
    import("./worker-environments/node-worker-bundle-transfer-service.js"),
    import("./worker-environments/node-worker-bundle-transfer-http.js"),
    import("./worker-environments/node-workspace-transfer-service.js"),
    import("./worker-environments/node-workspace-transfer-http.js"),
    import("./worker-environments/node-desktop-carrier.js"),
    import("./worker-environments/portal-node-carrier.js"),
    import("./worker-environments/computer-transport.js"),
    import("../plugins/worker-provider-registry.js"),
    import("../plugins/worker-provider-maintenance.js"),
    import("./worker-environments/worker-bootstrap-artifact-transfer-service.js"),
    import("./worker-environments/worker-bootstrap-artifact-transfer-http.js"),
  ]);
  // The Gateway state-directory lock proves that executors from the previous
  // process are gone. Resolve their ambiguous effects before placement
  // reconciliation attempts to release the owning worker claims.
  params.startup.placementStore.recoverWorkerSessionToolOperationsAfterRestart();
  // A crashed gateway can leak local turn claims; drop them before workers re-admit turns.
  params.startup.placementStore.clearLocalTurnClaimsAfterRestart();
  const placementGate = createWorkerSessionPlacementGate(params.startup.placementStore, {
    // Claims loaded before this Gateway acquired the state lock remain usable only by
    // workspace recovery. Worker authority is minted from claims created in this lifecycle.
    rejectExistingWorkerClaims: true,
  });
  const workerEnvironmentLog = params.log.child("worker-environments");
  const listRetainedBundleHashes = () =>
    listRetainedWorkerBundleHashes({
      environments: params.startup.store.list(),
      placements: params.startup.placementStore.list(),
    });
  let workerBundleProducer: WorkerBundleProducer | undefined;
  let workerNpmArtifact: Promise<WorkerNpmArtifact> | undefined;
  const prepareInstallation = async (install: "bundle" | "npm") => {
    const [workerRuntime, { WORKER_PROTOCOL_FEATURES }] = await Promise.all([
      loadWorkerEnvironmentRuntimeModule(),
      import("../../packages/gateway-protocol/src/schema/worker-admission.js"),
    ]);
    const producer = (workerBundleProducer ??= workerRuntime.createWorkerBundleProducer({
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
      cacheOwnership: "exclusive",
      onCacheCleanupError: (error) => {
        workerEnvironmentLog.warn(`Worker bundle cache cleanup failed: ${String(error)}`);
      },
    }));
    const bundle = await producer.prepare();
    await producer.prune(listRetainedBundleHashes);
    if (install === "bundle") {
      return bundle;
    }
    workerNpmArtifact ??= workerRuntime
      .resolveWorkerNpmInstallationArtifact({ bundle })
      .catch((error: unknown) => {
        workerNpmArtifact = undefined;
        throw error;
      });
    return await workerNpmArtifact;
  };
  const startupBindings = params.startup.records.flatMap((record) =>
    record.state === "attached" && record.attachedSessionIds.length === 1
      ? [
          {
            environmentId: record.environmentId,
            runEpoch: record.ownerEpoch,
            sessionId: record.attachedSessionIds[0]!,
          },
        ]
      : [],
  );
  const workerLiveEvents = createWorkerLiveEventReceiver({
    getConfig: getRuntimeConfig,
    startupBindings,
    startupOwners: new Map(
      startupBindings.map((binding) => [binding.environmentId, binding.runEpoch] as const),
    ),
  });
  const workerTunnelManager = createWorkerTunnelManager({
    desktopSessionRegistry: params.desktopSessionRegistry,
  });
  const notifyPortalChange = () => {
    const runtime = params.getPortalRuntime();
    const service = runtime?.portalService;
    if (!service) {
      return;
    }
    runtime.broadcast(
      "portal.changed",
      {
        portals: service.list().map(({ tokenQuery: _tokenQuery, url: _url, ...portal }) => portal),
      },
      { dropIfSlow: true },
    );
  };
  const workerNodeDesktopStreamBroker = params.nodeDesktopStreamBroker;
  const workerNodePortalCarrier = createWorkerNodePortalCarrier({ store: params.startup.store });
  const workerNodeDesktopCarrier = workerNodeDesktopStreamBroker
    ? createWorkerNodeDesktopCarrier({
        store: params.startup.store,
        desktopRegistry: params.desktopSessionRegistry,
      })
    : undefined;
  const nodeWorkerBundleTransfer = createNodeWorkerBundleTransferService();
  const nodeBootstrapTransfer = createWorkerBootstrapArtifactTransferService();
  const bootstrapProducers = new Map<
    WorkerExecutionMode,
    {
      registry: ReturnType<typeof params.getPluginRegistry>;
      metadata: ReturnType<typeof getGatewayPluginMetadataSnapshot>;
      producer: ReturnType<typeof createNodeBootstrapArtifactProvider>;
    }
  >();
  const retiringBootstrapProducers = new Set<Promise<void>>();
  const retireBootstrapProducer = (
    producer: ReturnType<typeof createNodeBootstrapArtifactProvider>,
  ) => {
    const retirement = producer
      .close()
      .catch((error: unknown) => {
        workerEnvironmentLog.warn(`Cloud node artifact cleanup failed: ${String(error)}`);
      })
      .finally(() => retiringBootstrapProducers.delete(retirement));
    retiringBootstrapProducers.add(retirement);
  };
  const nodeWorkspaceTransfer = createNodeWorkspaceTransferService({
    getOwner: (environmentId) => params.startup.store.getTransferOwner(environmentId),
  });
  await nodeWorkspaceTransfer.initialize();
  // Permanent credential revocation fences every in-flight workspace transfer for the
  // owner immediately. Rotation-style revocations (device reconcile re-mints) do not
  // notify, so routine reconcile never tears down healthy transfer contexts.
  params.startup.store.onCredentialRevoked((environmentId) => {
    nodeWorkspaceTransfer.fenceEnvironment(environmentId);
  });
  const gatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
  const nodeWorkerGatewayNamespace = resolveNodeWorkerGatewayNamespace(gatewayDeviceId);
  const nodeWorkerTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId,
    getEnvironment: (environmentId) => params.startup.store.get(environmentId),
    listEnvironments: () => params.startup.store.list(),
    getTransport: () => deviceRuntime.getNodeTransport(),
    launchNodeWorker: async (request) => await deviceRuntime.launchNodeWorker(request),
    validateWorkerTurn: (binding) => placementGate.validateWorkerTurn(binding),
    workspaceTransfer: nodeWorkspaceTransfer,
  });
  const isEnvironmentOwnedNode = (nodeId: string) =>
    params.startup.store.hasNodeEnrollmentOwner(nodeId);
  const nodeWorkerBundleInstaller = createGatewayNodeWorkerBundleInstaller({
    gatewayNamespace: nodeWorkerGatewayNamespace,
    getTransport: () => deviceRuntime.getNodeTransport(),
    transfer: nodeWorkerBundleTransfer,
  });
  const prepareNodeArtifact = async (profileSnapshot: WorkerProfile, signal?: AbortSignal) => {
    const mode = profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn";
    let registry = params.getPluginRegistry();
    let metadata = getGatewayPluginMetadataSnapshot() ?? params.pluginMetadataSnapshot;
    let generation = bootstrapProducers.get(mode);
    if (!generation || generation.registry !== registry || generation.metadata !== metadata) {
      const [{ createNodeBootstrapArtifactProvider }, { resolveNodeBootstrapPlugins }] =
        await Promise.all([
          import("./worker-environments/node-bootstrap-artifact.js"),
          import("./worker-environments/node-bootstrap-plugins.js"),
        ]);
      signal?.throwIfAborted();
      registry = params.getPluginRegistry();
      metadata = getGatewayPluginMetadataSnapshot() ?? metadata;
      generation = bootstrapProducers.get(mode);
      if (!generation || generation.registry !== registry || generation.metadata !== metadata) {
        const packageRoot = resolveOpenClawPackageRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
        const runningBuildId = resolveRuntimeServiceBuildId();
        if (!packageRoot || !runningBuildId || (mode === "remote-exec" && !metadata)) {
          throw new Error("Cloud node bootstrap diagnostic");
        }
        const producer = createNodeBootstrapArtifactProvider({
          packageRoot,
          runningBuildId,
          plugins:
            mode === "remote-exec"
              ? resolveNodeBootstrapPlugins({
                  registry,
                  metadata: metadata!,
                  executionMode: mode,
                })
              : [],
        });
        // Reload owns a new inventory; active enrollments pin their old artifact until closure.
        if (generation) {
          retireBootstrapProducer(generation.producer);
        }
        generation = { registry, metadata, producer };
        bootstrapProducers.set(mode, generation);
      }
    }
    const artifact = await generation.producer.prepare(signal);
    return {
      artifact,
      assertCurrent: () => {
        if (
          bootstrapProducers.get(mode) !== generation ||
          params.getPluginRegistry() !== generation.registry ||
          getGatewayPluginMetadataSnapshot() !== generation.metadata
        ) {
          throw new Error("Worker preparation artifact generation changed");
        }
      },
    };
  };
  const nodeWorkerBundleRetention: NodeWorkerBundleRetention = {
    isEnvironmentOwnedNode,
    currentBuild: async () => {
      const artifact = await prepareInstallation("bundle");
      if (artifact.install !== "bundle") {
        throw new Error("Node worker retention requires a bundle artifact");
      }
      return artifact;
    },
  };
  const cloudWorkerCapabilities = new Map<
    string,
    {
      record: WorkerEnvironmentRecord;
      setupCode: string;
      target: string;
      leaseId?: string;
      expiresAtMs?: number;
    }
  >();
  const nodeEnrollment = createWorkerNodeEnrollmentManager({
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    getLocalTlsFingerprint: () => params.resolveGatewayContext()?.gatewayTlsFingerprint,
    resolveAvailability: deviceRuntime.resolveAvailability,
    transfer: nodeBootstrapTransfer,
    prepareArtifact: async (record, signal) =>
      (await prepareNodeArtifact(record.profileSnapshot, signal)).artifact,
    onBootstrapCapability: (record, enrollment) => {
      if (!("setupCode" in enrollment) || enrollment.mode !== "connect") {
        return;
      }
      const key = `${record.environmentId}:${record.nodeSetupId ?? ""}`;
      const payload = decodePairingSetupCode(enrollment.setupCode);
      const previous = cloudWorkerCapabilities.get(key);
      cloudWorkerCapabilities.set(key, {
        record,
        setupCode: enrollment.setupCode,
        target: payload.url,
        ...(previous?.record.environmentId === record.environmentId && previous.leaseId
          ? { leaseId: previous.leaseId }
          : {}),
        ...(previous?.record.environmentId === record.environmentId && previous.expiresAtMs
          ? { expiresAtMs: previous.expiresAtMs }
          : {}),
      });
    },
  });
  let executeSessionTool: WorkerSessionToolExecutor = async () => {
    throw new Error("Worker session tools are unavailable");
  };
  let dispatchChild: WorkerPlacementDispatchContract["dispatch"] = async () => {
    throw new Error("Worker session dispatch is unavailable");
  };
  const computers = createWorkerComputerService({
    store: params.startup.store,
    placements: params.startup.placementStore,
    resolveGatewayContext: params.resolveGatewayContext,
    getNodeTransport: () => deviceRuntime.getNodeTransport(),
    warn: (message) => workerEnvironmentLog.warn(message),
  });
  const preparedWorkspaces = createNodeWorkerPreparedWorkspaceTransport({
    store: params.startup.store,
    placementStore: params.startup.placementStore,
    getNodeTransport: () => deviceRuntime.getNodeTransport(),
    gatewayNamespace: nodeWorkerGatewayNamespace,
  });
  const workerEnvironmentServiceBase = createWorkerEnvironmentService({
    projectNamespace: nodeWorkerGatewayNamespace,
    prepareComputer: computers.prepare,
    executeComputer: computers.execute,
    closeComputers: computers.close,
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    maintainProviders: (signal) =>
      maintainConfiguredWorkerProviders({
        getRegistry: params.getPluginRegistry,
        getConfig: getRuntimeConfig,
        signal,
        warn: (message) => workerEnvironmentLog.warn(message),
      }),
    // Plugin reload replaces the registry object; resolve against the live binding.
    resolveProvider: (providerId) =>
      providerId === DEVICE_WORKER_PROVIDER_ID
        ? deviceRuntime.provider
        : resolveWorkerProvider(params.getPluginRegistry(), providerId),
    prepareInstallation,
    ensureNodeWorkerBundle: nodeWorkerBundleInstaller,
    prepareNodeBootstrap: nodeEnrollment.prepare,
    getCloudWorkerBootstrapCapability: (environmentId) => {
      const record = params.startup.store.get(environmentId);
      if (!record || !record.nodeSetupId) {
        return undefined;
      }
      const key = `${environmentId}:${record.nodeSetupId}`;
      const capability = cloudWorkerCapabilities.get(key);
      if (
        !capability ||
        capability.record.nodeSetupId !== record.nodeSetupId ||
        capability.record.environmentId !== record.environmentId
      ) {
        return undefined;
      }
      if (
        record.destroyRequestedAtMs !== null ||
        ["destroying", "destroyed", "failed", "orphaned"].includes(record.state)
      ) {
        cloudWorkerCapabilities.delete(key);
        return undefined;
      }
      if (capability.expiresAtMs !== undefined && capability.expiresAtMs <= Date.now()) {
        cloudWorkerCapabilities.delete(key);
        return undefined;
      }
      return {
        setupCode: capability.setupCode,
        nodeSetupId: record.nodeSetupId,
        ownerEpoch: record.ownerEpoch,
        leaseId: capability.leaseId,
        expiresAtMs: capability.expiresAtMs,
        target: capability.target,
      };
    },
    bindCloudWorkerBootstrapCapability: ({ environmentId, leaseId, expiresAtMs }) => {
      const record = params.startup.store.get(environmentId);
      if (!record || !record.nodeSetupId) {
        throw new Error("Cloud worker admission environment lease is unavailable");
      }
      if (record.destroyRequestedAtMs !== null) {
        throw new Error("Cloud worker admission environment is being destroyed");
      }
      if (!leaseId || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 15 * 60_000) {
        throw new Error("Cloud worker admission lease binding is invalid");
      }
      const key = `${environmentId}:${record.nodeSetupId}`;
      const capability = cloudWorkerCapabilities.get(key);
      if (!capability) {
        throw new Error("Cloud worker admission capability is no longer current");
      }
      capability.leaseId = leaseId;
      capability.expiresAtMs = expiresAtMs;
    },
    prepareNodeArtifacts: async (profileSnapshot, signal) => {
      const pin = new AbortController();
      try {
        const preparedBootstrap = await prepareNodeArtifact(
          profileSnapshot,
          signal ? AbortSignal.any([signal, pin.signal]) : pin.signal,
        );
        signal?.throwIfAborted();
        const bootstrap = preparedBootstrap.artifact;
        preparedBootstrap.assertCurrent();
        const bundle = await racePromiseWithAbortSignal(prepareInstallation("bundle"), signal);
        signal?.throwIfAborted();
        preparedBootstrap.assertCurrent();
        if (bundle.install !== "bundle") {
          throw new Error("Worker preparation requires a bundle artifact");
        }
        return {
          artifacts: {
            nodeBootstrapSha256: bootstrap.tarballSha256,
            enabledPluginIds: [...bootstrap.enabledPluginIds],
            workerBundleHash: bundle.bundleHash,
            workerArchiveSha256: bundle.tarballSha256,
            openclawVersion: bundle.openclawVersion,
            protocolFeatures: [...bundle.protocolFeatures],
          },
          assertCurrent: preparedBootstrap.assertCurrent,
        };
      } finally {
        pin.abort();
      }
    },
    ...preparedWorkspaces,
    prepareNodeEnrollment: nodeEnrollment.begin,
    prepareNodeRuntime: nodeEnrollment.prepareRuntime,
    closeNodeRuntime: nodeEnrollment.closeRuntime,
    closeNodeEnrollment: nodeEnrollment.close,
    retireNodeEnrollment: nodeEnrollment.retire,
    stopNodeEnrollmentWaits: nodeEnrollment.stop,
    closeNodeBootstrapArtifacts: async () => {
      await Promise.all([
        ...[...bootstrapProducers.values()].map(({ producer }) => producer.close()),
        ...retiringBootstrapProducers,
      ]);
      bootstrapProducers.clear();
    },
    tunnelManager: workerTunnelManager,
    nodeTunnelManager: nodeWorkerTunnelManager,
    nodeDesktopCarrier: workerNodeDesktopCarrier,
    nodePortalCarrier: workerNodePortalCarrier,
    closeWorkerPortals: async (environmentId, ownerEpoch) => {
      const service = params.getPortalRuntime()?.portalService;
      if (!service) {
        return;
      }
      await service.closeWorkerPortals(environmentId, ownerEpoch);
      notifyPortalChange();
    },
    stopNodeWorkerBundleTransfers: () => nodeWorkerBundleTransfer.closeAll(),
    applyTranscriptCommit: createWorkerTranscriptCommitter({
      getConfig: getRuntimeConfig,
    }).commit,
    executeInference: async (inferenceParams) => {
      const workerInferenceRuntime = await loadWorkerInferenceRuntimeModule();
      return await workerInferenceRuntime.executeWorkerInference(inferenceParams);
    },
    placementStore: placementGate,
    executeSessionTool: (request) => executeSessionTool(request),
    liveEvents: workerLiveEvents,
    resolveSshIdentity: async ({ provider, leaseId, profile, keyRef }) => {
      const workerRuntime = await loadWorkerEnvironmentRuntimeModule();
      return await workerRuntime.resolveWorkerSshIdentity({
        provider,
        leaseId,
        profile,
        keyRef,
        resolveGeneric: async (genericKeyRef) => ({
          kind: "material",
          contents: await workerRuntime.resolveSecretRefString(genericKeyRef, {
            config: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? getRuntimeConfig(),
            env: getActiveSecretsRuntimeEnvState(),
          }),
        }),
      });
    },
    bootstrapWorker: async ({
      operationId,
      sshEndpoint,
      installation,
      resolveIdentity,
      signal,
      assertCurrent,
    }) => {
      const workerRuntime = await loadWorkerEnvironmentRuntimeModule();
      return await workerRuntime.bootstrapWorker(
        {
          operationId,
          ssh: sshEndpoint,
          artifact: installation,
          pinnedHostKey: sshEndpoint.hostKey,
        },
        { signal, resolveIdentity, assertCurrent },
      );
    },
    logger: workerEnvironmentLog,
  });
  const workerEnvironmentService = workerEnvironmentServiceBase;
  bindDeviceWorkerAvailability(workerEnvironmentService, deviceRuntime.resolveAvailability);
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    const environmentIds = params.startup.store
      .listForReconcile()
      .filter((record) => {
        const settings = record.profileSnapshot.settings;
        const profileDeviceId = isRecord(settings) ? settings.device : undefined;
        return (
          record.providerId === DEVICE_WORKER_PROVIDER_ID &&
          typeof profileDeviceId === "string" &&
          profileDeviceId.trim() === deviceId
        );
      })
      .map((record) => record.environmentId);
    for (const environmentId of environmentIds) {
      params.startup.store.revokeEnvironmentCredential(environmentId);
    }
    await Promise.all(
      environmentIds.map(async (environmentId) => {
        await workerEnvironmentService.reconcileEnvironment(environmentId).catch(() => {
          workerEnvironmentLog.warn(
            `Device worker reconcile failed (${deviceId}, ${environmentId}); periodic cleanup will retry`,
          );
        });
      }),
    );
    return environmentIds;
  });
  const reclaimCloudWorkerNode = async (nodeId: string): Promise<readonly string[]> => {
    const environmentIds = params.startup.store
      .listForReconcile()
      .filter(
        (record) =>
          record.providerId === DEVICE_WORKER_PROVIDER_ID &&
          record.nodeSetupId !== null &&
          record.nodeDeviceId === nodeId &&
          record.destroyRequestedAtMs === null &&
          !["destroyed", "failed", "orphaned"].includes(record.state),
      )
      .map((record) => record.environmentId);
    await Promise.all(
      [...environmentIds].map(async (environmentId) => {
        await workerEnvironmentService.requestDestroy(environmentId).catch((error) => {
          workerEnvironmentLog.warn(
            `Cloud worker node reclaim failed (${nodeId}, ${environmentId}): ${String(error)}`,
          );
        });
      }),
    );
    return [...environmentIds];
  };
  let workerSessionToolExecutor: Promise<WorkerSessionToolExecutor> | undefined;
  executeSessionTool = async (request) => {
    const executor = await (workerSessionToolExecutor ??=
      loadWorkerSessionToolExecutorModule().then(({ createWorkerSessionToolExecutor }) =>
        createWorkerSessionToolExecutor({
          resolveGatewayContext: params.resolveGatewayContext,
          placements: params.startup.placementStore,
          environments: workerEnvironmentService,
          dispatchChild: (...args) => dispatchChild(...args),
          portals: {
            getService: () => params.getPortalRuntime()?.portalService,
            carrier: workerNodePortalCarrier,
            onChanged: notifyPortalChange,
          },
        }),
      ));
    return await executor(request);
  };
  const bindWorkerNodeDesktopControl =
    workerNodeDesktopCarrier && workerNodeDesktopStreamBroker
      ? (transport: NodeWorkerSupervisorTransport) =>
          workerNodeDesktopCarrier.bindRuntime({
            transport,
            streamBroker: workerNodeDesktopStreamBroker,
          })
      : undefined;
  return {
    workerEnvironmentService,
    reclaimCloudWorkerNode,
    workerLiveEvents,
    workerTunnelManager,
    nodeWorkerGatewayNamespace,
    nodeWorkerBundleRetention,
    bindWorkerSessionDispatch: (dispatch) => {
      dispatchChild = dispatch;
    },
    bindDeviceNodeControl: (transport) => {
      deviceRuntime.bindNodeTransport(transport);
      if (workerNodeDesktopStreamBroker) {
        workerNodePortalCarrier.bindRuntime({
          transport,
          streamBroker: workerNodeDesktopStreamBroker,
        });
      }
    },
    ...(bindWorkerNodeDesktopControl ? { bindWorkerNodeDesktopControl } : {}),
    bindNodeWorkspaceBindingResolver: (resolver) =>
      nodeWorkerTunnelManager.bindWorkspaceBindingResolver(resolver),
    handleNodeWorkerBundleTransferRequest:
      createNodeWorkerBundleTransferHttpCallback(nodeWorkerBundleTransfer),
    handleWorkerBootstrapArtifactTransferRequest:
      createWorkerBootstrapArtifactTransferHttpCallback(nodeBootstrapTransfer),
    handleNodeWorkspaceTransferRequest:
      createNodeWorkspaceTransferHttpCallback(nodeWorkspaceTransfer),
  };
}
