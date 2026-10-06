# FreeChatClaw Phase 3 — Native specialist session implementation + acceptance plan

## Scope

Implement the frozen FreeChatClaw Phase 3 path on OpenClaw 2026.9.5 and the adapter:

GitHub Actions admission -> ephemeral node -> node-scoped specialist RPC -> native OpenClaw session/run -> exact admitted-node placement -> native result -> durable adapter reconciliation.

Phase 3 does not change the Phase 1/2 admission contract or provider boundary.

## Execution discipline

This plan is evidence-gated. A later test cannot compensate for a failed earlier
gate, and a successful historical run is not accepted unless its source/build
provenance matches the current tree.

Rules for this implementation pass:

1. Work only in the isolated OpenClaw repository unless a source file is explicitly
   part of the Phase 3 implementation.
2. Never `git add`, `git commit`, `git reset`, or rewrite unrelated existing changes.
3. Never restart, modify, or use production Gateway `127.0.0.1:9010` or adapter
   `127.0.0.1:8318` as an execution target.
4. Never create worker proof from the adapter, runner shim, Gateway, or test harness.
5. Never replace a native worker execution with local `exec`, `sessions_spawn`, or a
   fabricated session/run identity.
6. Every acceptance claim must point to current-tree evidence captured after the
   current build.

## Frozen invariants

- Runner connects only with the Gateway-issued ephemeral node credential.
- Node profile remains `roles=['node']`, `scopes=[]`, `purpose='cloud-worker'`.
- Runner never receives `operator.admin` or provider credentials.
- No `OPENAI_API_KEY`.
- No `sessions_spawn` for specialist dispatch.
- No local/fake session identity.
- Native OpenClaw `sessionId` and `runId` are the authoritative runtime identity.
- Dispatch uses the exact admitted `deviceId`; no auto-device selection.
- Every request binds `taskId + attempt + environmentId + leaseId + ownerEpoch + role + inputCommit`.
- Stale environment/node/lease/epoch is fail-closed.
- Duplicate `taskId + attempt` is idempotent; conflicting binding is rejected.
- Production Gateway/adapter are not restarted by Phase 3 verification.

## RPC contract

Hidden Gateway methods:

- `m12.specialist.start`
- `m12.specialist.wait`

Both require client role `node`, exact node identity, and reject any `operator.*` scope.

### start request

- `environmentId`
- `admissionIdempotencyKey`
- `leaseId`
- `ownerEpoch`
- `taskId`
- `attempt`
- `role`
- `inputCommit`
- `prompt`
- optional `agentId`
- optional `waitTimeoutMs`

### start response

- task binding fields
- `nodeId`
- `sessionKey`
- native `sessionId`
- native `runId`
- native placement evidence
- optional native wait result

### wait request

- `environmentId`
- `leaseId`
- `ownerEpoch`
- `taskId`
- `attempt`
- `runId`
- optional `timeoutMs`

## Native lifecycle

1. Validate node and environment binding.
2. Resolve deterministic session key `agent:m12-{taskId}:specialist:{attempt}`.
3. Create/adopt native session through an internal service boundary that preserves Gateway authorization rules.
4. Dispatch session to the exact admitted node.
5. Send task through native session messaging with deterministic idempotency key.
6. Require real native `sessionId` and `runId`.
7. Wait using native run lifecycle APIs.
8. Return terminal/native evidence without fabricating local IDs.

The specialist method must not grant the node client operator authorization merely to reuse public session handlers. If existing handlers cannot safely serve this internal path, extract/reuse their internal service primitives.

## Durable adapter reconciliation

Adapter maps native evidence to its existing durable task/session tables:

- `tasks.openclaw_session_key`
- `tasks.openclaw_run_id`
- `agent_sessions`
- `attempts`
- task/result/artifact/event records

Reconciliation is idempotent and keyed by exact task/attempt/native runtime identity. Existing task runtime ownership must reject a session belonging to another task.

Terminal native result becomes durable task completion evidence only after task/lease binding is revalidated.

## Failure and recovery semantics

Reject:

- non-node client
- operator scopes on node
- unknown environment
- wrong node
- wrong lease
- wrong owner epoch
- stale/destroyed environment
- conflicting task binding
- missing native session/run identity

Recover:

- duplicate start returns the existing native runtime for the same exact binding.
- runner reconnect uses `m12.specialist.wait` with the persisted native `runId`.
- adapter restart reconciles persisted runtime identity through existing recovery mechanisms.
- lease expiry/node fencing prevents new work and causes reconciliation to stop treating the runtime as current.

## Test gates

### Evidence gates

The implementation is considered Phase 3 complete only when all applicable gates
below are green in one coherent evidence set:

| Gate                           | Required evidence                                                      | Failure condition                                        |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| G1 source integrity            | `git diff --check`; relevant diff reviewed                             | whitespace/error or unexplained FreeChatClaw edit        |
| G2 build provenance            | isolated build exits with explicit `BUILD_EXIT=0`                      | build exit missing/non-zero                              |
| G3 admission                   | fresh GitHub-bound admission, environment, lease, owner epoch          | reused/expired/cross-task admission                      |
| G4 node bootstrap              | ephemeral node connects with `role=node`, `scopes=[]`                  | operator scope/provider credential or wrong node         |
| G5 placement                   | environment/node/lease/epoch/device all match                          | auto-device or mismatched binding                        |
| G6 native session              | real native `sessionId` from OpenClaw                                  | fabricated/local ID                                      |
| G7 native run                  | real native `runId` from OpenClaw                                      | fabricated/local ID                                      |
| G8 native tool call            | transcript shows native assistant `toolCall` for `exec`                | shim/test creates proof or no native tool call           |
| G9 native system execution     | worker's native `system.run` actually executes the admitted command    | adapter/runner creates output or fake execution          |
| G10 worker proof               | proof file is created by the worker execution in its managed workspace | proof created outside worker execution                   |
| G11 terminal result            | native run reaches terminal result tied to same session/run            | detached or locally synthesized result                   |
| G12 provenance boundary        | runner/result contains no provider credential; no Platform API         | `OPENAI_API_KEY`, OpenAI Platform, or credential leakage |
| G13 focused tests              | FreeChatClaw unit/specialist/acceptance tests pass after latest patch  | stale pre-patch test result                              |
| G14 TypeScript                 | explicit `TSC_EXIT=0` if claimed                                       | timeout/non-zero/unverified                              |
| G15 forbidden/production audit | adapter forbidden files unchanged; production ports only inspected     | forbidden edit or production restart/change              |

### Patch order

1. Freeze the existing working tree: record `git status --short` and do not touch
   unrelated modifications.
2. Patch protocol/placement and Gateway binding logic first.
3. Patch native session/run dispatch and node runner orchestration.
4. Patch only the native provider compatibility seam required to expose the real
   `exec` tool call; it must never execute the command itself or create proof.
5. Patch worker workspace permissions/identity handling.
6. Remove temporary diagnostics before validation.
7. Build once from the resulting tree and capture the exit code explicitly.
8. Run focused tests from that exact tree.
9. Run one fresh isolated E2E with unique task/admission/state identifiers.
10. Inspect native transcript and filesystem provenance before accepting proof.
11. Audit forbidden adapter files, production listeners, and final diff.

### E2E evidence capture

The E2E evidence bundle must contain, at minimum:

- admission request/result and exact task/lease/owner epoch;
- node identity and node connection role/scopes;
- environment identity and admitted node binding;
- native `sessionId`, `runId`, session key, and placement fields;
- native transcript showing the `exec` tool call and subsequent tool result;
- native `system.run` execution evidence;
- worker-created proof path, owner/mode, and file contents;
- terminal native result;
- isolated Gateway state path and build artifact used for the run;
- final forbidden-file and production-listener audit.

The proof file itself is not sufficient. Its provenance must be demonstrated by
the native transcript and by showing that adapter/runner code contains no proof
writer for the acceptance artifact.

### Stop conditions

Stop and report a blocker instead of weakening the contract when any of these
occurs: stale lease, wrong node, missing native session/run identity, missing
native `exec`, `Tool exec not found`, provider credential leakage, proof written
outside the worker execution, build/test failure, or unexplained production impact.

### Unit/focused

- request validation
- node-only authorization
- no operator scope
- exact environment/node/lease/epoch binding
- stale environment rejection
- duplicate idempotency
- conflicting task rejection
- native session/run identity required
- explicit `deviceId`
- no `sessions_spawn`
- compatibility wrapper does not execute commands or create proof
- native `exec` remains in the session tool surface when the effective tool set
  would otherwise omit it

### Real isolated E2E

Use isolated Gateway state/build only.

Prove:

1. fresh Phase 1 admission
2. ephemeral runner connection
3. `m12.specialist.start`
4. actual native `sessionId`
5. actual native `runId`
6. placement node equals admitted node
7. native result
8. adapter durable reconciliation
9. duplicate start does not create a second runtime
10. runner result contains no operator/provider credential
11. native transcript proves worker-side command execution
12. worker-created proof has filesystem provenance inside the managed workspace
13. source/build artifact used by the E2E matches the audited current tree

Then verify runner disconnect/reclaim remains intact.

## Non-goals

- Phase 4 provider proof
- Phase 5 full crash/isolation matrix
- Phase 6 ten-role production-shaped E2E
- Phase 7 FreeChatClaw acceptance
- production restart
- OpenAI Platform API integration
- provider credential delivery to runner
- `--session-host` on ephemeral runner
