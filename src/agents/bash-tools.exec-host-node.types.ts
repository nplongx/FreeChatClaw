/**
 * Node-host exec command parameter contracts.
 * Centralizes the full host/runtime boundary so node exec callers and handlers
 * cannot drift on approval, routing, env, or timeout fields.
 */
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "./bash-tools.exec-types.js";

/** Full parameter bundle for Node-hosted exec command execution. */
export type ExecuteNodeHostCommandParams = {
  command: string;
  toolCallId?: string;
  workdir: string | undefined;
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  requestedNode?: string;
  boundNode?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionStore?: string;
  bashElevated?: ExecElevatedDefaults;
  approvalReviewerDeviceId?: string;
  nonInteractiveApproval?: boolean;
  approvalFollowupMode?: "agent" | "direct";
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  trigger?: string;
  agentId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  bypassHostApprovalFloors?: boolean;
  autoReview?: boolean;
  autoReviewer?: ExecAutoReviewer;
  signal?: AbortSignal;
  strictInlineEval?: boolean;
  commandHighlighting?: boolean;
  timeoutSec?: number;
  defaultTimeoutSec: number;
  approvalRunningNoticeMs: number;
  warnings: string[];
  foregroundWarnings?: string[];
  processContinuationAvailable?: boolean;
  notifySessionKey?: string;
  notifyOnExit?: boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
  runId?: string;
  workerWorkspaceExec?: ExecToolDefaults["workerWorkspaceExec"];
};
