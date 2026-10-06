---
title: "FreeChatClaw fork identity and compatibility"
summary: "What FreeChatClaw inherits from OpenClaw, what it changes, and which compatibility surfaces remain intentionally unchanged."
read_when:
  - You are new to the FreeChatClaw repository
  - You are deciding whether a behavior is upstream or FreeChatClaw-specific
  - You are changing branding, package metadata, or compatibility surfaces
---

# FreeChatClaw identity and OpenClaw compatibility

FreeChatClaw is a maintained fork of OpenClaw. The repository is not the upstream
OpenClaw project, even though substantial source, protocol, package, and CLI
compatibility remains intentionally inherited.

## Inherited foundation

FreeChatClaw currently inherits major OpenClaw foundations including:

- Gateway and WebSocket protocol;
- session and agent runtime infrastructure;
- channel/plugin architecture;
- node/device protocol and pairing;
- configuration and state ownership conventions;
- plugin SDK boundaries;
- existing CLI compatibility where not explicitly changed by FreeChatClaw.

Inherited code should be treated as upstream-derived code, not as proof that an
upstream product policy still applies to FreeChatClaw.

## FreeChatClaw-owned layer

FreeChatClaw-specific architecture currently includes:

- worker placement for native sessions;
- device worker provider behavior;
- native specialist/session orchestration;
- Gateway-owned ChatGPT Web provider boundary;
- isolated live provider proof;
- FreeChatClaw phase acceptance and evidence rules.

The FreeChatClaw docs are the first place to look for these behaviors. The OpenClaw docs
remain useful for inherited subsystems and should be read together with the FreeChatClaw
architecture pages when a change crosses both layers.

## Compatibility policy

The public product name is **FreeChatClaw**. The repository currently keeps the
existing `openclaw` package and command names as a compatibility layer because
changing them affects installers, state directories, plugins, tests, and runtime
protocol assumptions.

This is an implementation compatibility decision, not a statement that FreeChatClaw
is the upstream OpenClaw distribution.

When the public FreeChatClaw identity is finalized, update these surfaces together:

1. package name and executable names;
2. repository/homepage metadata;
3. README and docs site identity;
4. config/state directory names where migration is supported;
5. install/update instructions;
6. generated documentation links and navigation;
7. plugin SDK and manifest terminology where it is user-visible;
8. release and issue-reporting links.

Do not partially rename the product. A public rename is a migration project,
not a search-and-replace operation.

## Attribution

FreeChatClaw should retain appropriate OpenClaw attribution and third-party notices for
inherited code. It must not claim to be governed, released, or maintained by
the upstream OpenClaw Foundation unless that is actually true for this fork.

See `LICENSE` and `THIRD_PARTY_NOTICES.md` for the repository's legal source of
truth.

## Related

- [FreeChatClaw architecture](/architecture)
- [FreeChatClaw development and validation](/development-validation)
