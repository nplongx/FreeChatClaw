---
title: "FreeChatClaw development and validation"
summary: "Development workflow, evidence rules, isolated environments, and validation gates for the FreeChatClaw fork."
read_when:
  - Making a non-trivial FreeChatClaw runtime change
  - Running focused or live validation
  - Reviewing whether an E2E result is trustworthy
---

# FreeChatClaw development and validation

FreeChatClaw inherits OpenClaw's development conventions but adds a stronger rule for
native worker/provider changes: prove the real ownership path instead of making
an isolated helper pass.

## Before editing

1. Read the nearest `AGENTS.md`.
2. Inspect `git status -sb` and preserve unrelated work.
3. Read the complete affected owner, callers, tests, and relevant docs.
4. Use CodeGraph for relationship questions when available.
5. Reproduce through the real entry point when feasible.

## Validation levels

### Unit/contract

Use focused tests for pure boundaries, schemas, serialization, and ownership
rules.

### Integration

Exercise the Gateway request path with isolated state. Verify that the
registered entry point reaches the owner under test.

### Live native E2E

Use the real sequence:

```text
client
  -> sessions.create
  -> sessions.dispatch
  -> worker placement
  -> paired node worker
  -> native worker-turn
  -> Gateway provider resolution
  -> isolated provider /v1
  -> native result
```

Do not replace any of those stages with a proof writer, direct internal
function, or local response synthesizer.

## Isolated environment rules

Live tests use isolated:

- Gateway state;
- provider endpoint;
- ports;
- worktree roots;
- temporary directories;
- admission identities;
- node process ownership.

Never restart or repurpose an existing production Gateway or provider merely to
make a test pass.

## Evidence quality

Evidence is trustworthy only when it belongs to the same current-tree build and
the same live execution.

Capture enough identity to correlate the run:

- build identity;
- session/run IDs;
- environment/node/lease IDs;
- model/provider/API;
- provider endpoint attribution;
- terminal/native result;
- negative credential checks;
- cleanup outcome.

Historical rows, stale builds, or a worker selected by list position are not
acceptable substitutes.

## Phase 4 example

The Phase 4 acceptance contract proves:

- `chatgpt-web/chatgpt-free` is the selected model;
- Gateway resolves the isolated provider endpoint;
- the credential is Gateway-owned;
- worker/node payloads remain credential-free;
- the real native worker path reaches the provider;
- invalid ChatGPT Web auth/route fails closed;
- production endpoints remain untouched.

The detailed acceptance plan remains in
[`FreeChatClaw-phase4-plan.md`](/FreeChatClaw-phase4-plan).

## Build discipline

When runtime source changes can affect the running Gateway, build the current
tree before live testing and verify the resulting build metadata. A passing
source test against one tree does not prove that a separately running `dist`
tree contains the fix.

## Review checklist

- Does one existing owner still own the responsibility?
- Did the change introduce a second state writer or transport path?
- Does a native session remain native?
- Does provider auth remain Gateway-owned?
- Are node identity and worker identity still distinct?
- Is live evidence current and correlated?
- Are production endpoints and unrelated files untouched?
- Is cleanup deterministic?

## Related

- [FreeChatClaw architecture](/architecture)
- [FreeChatClaw runtime topology](/runtime-topology)
- [FreeChatClaw provider and inference architecture](/provider-inference)
- [FreeChatClaw fork identity and compatibility](/fork-identity)
