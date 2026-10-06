import fs from "node:fs";
import { expect, it } from "vitest";
import { connectOperator } from "./gateway-operator-client.js";

const gatewayUrl = process.env.OPENCLAW_M12_PHASE4_LIVE_GATEWAY_URL;
const gatewayConfigPath = process.env.OPENCLAW_M12_PHASE4_LIVE_CONFIG;
const profileId = process.env.OPENCLAW_M12_PHASE4_PROFILE_ID ?? "m12-device";
const timeoutMs = 120_000;

it("proves native Phase 4 admission and worker-turn on a real Gateway", async () => {
  if (!gatewayUrl || !gatewayConfigPath) {
    return;
  }

  const gatewayConfig = JSON.parse(fs.readFileSync(gatewayConfigPath, "utf8")) as {
    gateway?: { auth?: { token?: string } };
  };
  const gatewayToken = gatewayConfig.gateway?.auth?.token;
  expect(gatewayToken).toBeTruthy();
  const gateway = await connectOperator({ wsUrl: gatewayUrl, token: gatewayToken });
  const key = `agent:m12-e2e:dashboard:phase4-live-${Date.now()}`;
  try {
    const created = await gateway.request<{
      key: string;
      sessionId: string;
      entry?: { worktree?: { id?: string }; model?: string; agentRuntime?: string };
    }>("sessions.create", {
      key,
      label: `M12 Phase 4 live admission ${Date.now()}`,
      model: "chatgpt-web/chatgpt-free",
      agentRuntime: "openclaw",
      worktree: true,
      worktreeSource: "empty",
    });
    expect(created.key).toBe(key);
    expect(created.sessionId).toBeTruthy();
    expect(created.entry?.worktree?.id).toBeTruthy();

    const dispatched = await gateway.request<{
      ok: boolean;
      sessionId: string;
      placement?: { state?: string; environmentId?: string; deviceId?: string };
    }>("sessions.dispatch", { key, profileId });
    expect(dispatched.ok).toBe(true);
    expect(dispatched.sessionId).toBe(created.sessionId);

    await viWaitFor(async () => {
      const environments = await gateway.request<{
        environments: Array<{
          id: string;
          state?: string;
          status?: string;
          worker?: { profileId?: string; providerId?: string; state?: string };
          workerSlots?: { total?: number; available?: number };
        }>;
      }>("environments.list", {});
      const worker = environments.environments.find(
        (entry) =>
          entry.id.startsWith("worker:") &&
          entry.worker?.profileId === profileId &&
          /active|ready|running|attached/u.test(
            `${entry.status ?? ""} ${entry.state ?? ""} ${entry.worker.state ?? ""}`,
          ),
      );
      expect(worker).toBeTruthy();
      expect(
        `${worker?.status ?? ""} ${worker?.state ?? ""} ${worker?.worker?.state ?? ""}`,
      ).toMatch(/active|ready|running|attached/u);
    }, timeoutMs);

    const sent = await gateway.request<{ runId: string }>("sessions.send", {
      key,
      message: "Reply exactly with M12_PHASE4_OK.",
      idempotencyKey: `m12-phase4-live-${Date.now()}`,
    });
    expect(sent.runId).toBeTruthy();

    await viWaitFor(async () => {
      const history = await gateway.request<{
        messages?: Array<{ role?: string; content?: unknown; stopReason?: string }>;
      }>("chat.history", { sessionKey: key, limit: 30 });
      const text = JSON.stringify(history.messages ?? []);
      expect(text).toContain("M12_PHASE4_OK");
    }, timeoutMs);
  } finally {
    await gateway.request("sessions.reclaim", { key }).catch(() => undefined);
    await gateway.stopAndWait({ timeoutMs: 2_000 });
  }
});

async function viWaitFor(check: () => Promise<void>, timeout: number): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeout) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("timed out");
}
