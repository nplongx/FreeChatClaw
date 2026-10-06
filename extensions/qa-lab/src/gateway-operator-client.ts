import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.ts";

export type GatewayOperatorHandle = {
  wsUrl: string;
  token: string;
  runtimeEnv?: Record<string, string | undefined>;
};

export async function connectOperator(gateway: GatewayOperatorHandle): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (client: GatewayClient, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "M12 Phase 4 live operator",
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: 20_000,
      onHelloOk: () => finish(client),
      onConnectError: (error) => finish(client, error),
      onClose: (code, reason) => finish(client, new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(client, new Error("Gateway operator connection timed out")),
      20_000,
    );
    timeout.unref();
    client.start();
  });
}
