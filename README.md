# FreeChatClaw — OpenClaw-based native AI gateway

FreeChatClaw is a maintained fork of [OpenClaw](https://github.com/openclaw/openclaw),
focused on native session orchestration, worker placement, device-backed
execution, and strict Gateway-owned provider boundaries. The upstream OpenClaw
architecture remains the foundation; FreeChatClaw-specific behavior is documented in the
[FreeChatClaw architecture guide](docs/architecture.md).

The repository currently retains the upstream `openclaw` package and CLI names as a technical compatibility layer; for
compatibility while the public package and CLI migration is kept separate from compatibility work. See
[FreeChatClaw fork identity](docs/fork-identity.md) before changing
branding, package metadata, or compatibility surfaces.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-banner-light.png">
    <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-banner-dark.png" alt="FreeChatClaw — native AI gateway with ChatGPT Free integration.">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=flat-square&label=ci" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/openclaw"><img src="https://img.shields.io/npm/v/openclaw?style=flat-square&label=compatibility-package" alt="OpenClaw compatibility package version"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/openclaw?style=flat-square" alt="Node.js version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License: MIT"></a>
</p>

FreeChatClaw inherits OpenClaw's self-hosted Gateway, channel, plugin, node, and agent-runtime foundations. FreeChatClaw adds a native worker execution layer where the Gateway remains the control plane and provider credentials remain Gateway-owned. One Gateway can continue to serve the inherited OpenClaw surfaces while FreeChatClaw-specific native sessions use the worker-placement path described in the architecture docs.

FreeChatClaw preserves the inherited OpenClaw trust model while making the native worker boundary explicit: workers execute admitted work, but they do not receive provider credentials or become an alternate provider-selection authority. For the detailed ownership model, see [FreeChatClaw architecture](docs/architecture.md) and [FreeChatClaw provider and inference architecture](docs/provider-inference.md).

[FreeChatClaw architecture](docs/architecture.md) · [Runtime topology](docs/runtime-topology.md) · [Provider/inference](docs/provider-inference.md) · [Development and validation](docs/development-validation.md) · [Fork identity](docs/fork-identity.md) · [Upstream OpenClaw](https://github.com/openclaw/openclaw)

## Install

The current compatibility installer supports macOS, Linux, and Windows. Until
the FreeChatClaw package/CLI migration is released, installation uses the
inherited `openclaw` package and command names.

```bash
# macOS / Linux / WSL2
curl -fsSL https://openclaw.ai/install.sh | bash
```

```powershell
# Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Already manage Node.js? Install the published package instead (Node 24.16+ or 26.1+; Node 26 recommended):

```bash
npm install -g openclaw@latest --allow-scripts=openclaw
```

That command is for npm 12 or npm 11.16+. On npm 11.15 and earlier, omit
`--allow-scripts=openclaw`. See the
[installation guide](install) for the lifecycle script
contract, Docker, Nix, and other deployment paths.

## Quick start

On a fresh install, the installer scripts start onboarding automatically.
Complete the wizard they open. If you installed the package directly with npm,
pnpm, or Bun, run:

```bash
openclaw onboard --install-daemon
```

After onboarding:

```bash
openclaw gateway status
openclaw dashboard
```

Onboarding verifies model access, creates the workspace, and configures the Gateway. The last command opens the Control UI; send a message there to confirm the assistant is working. See the [getting started guide](start/getting-started) for channel setup and troubleshooting.

## How it fits together

- The [Gateway](gateway) is the local control plane for sessions, tools, events, and channel connections.
- The [Control UI](web/control-ui), CLI, and [TUI](web/tui) connect to the Gateway.
- [Channels](channels) bring the assistant to WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, and other messaging services.
- [Companion apps and nodes](platforms) add voice, Canvas, camera, screen, and device-local actions on supported platforms.

OpenClaw works with hosted and local [model providers](concepts/model-providers). Its [tools](tools), [skills](tools/skills), and [plugins](plugins) extend what an assistant can do.

## Security

Treat inbound messages as untrusted input. DM-capable channels pair unknown senders by default; approve a pairing request with `openclaw pairing approve <channel> <code>`.

Tools run on the host for the main session unless you configure sandboxing. Read the [security guide](gateway/security), [exposure runbook](gateway/security/exposure-runbook), and [sandboxing guide](gateway/sandboxing) before connecting other users or exposing the Gateway remotely.

## Documentation

| Goal                             | Start here                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configure models and auth        | [Models](concepts/models) · [Model providers](concepts/model-providers)                                                                                          |
| Connect a messaging service      | [Channels](channels)                                                                                                                                             |
| Add tools, skills, and plugins   | [Tools](tools) · [Skills](tools/skills) · [Plugins](plugins) · [ClawHub](https://clawhub.ai)                                                                     |
| Run apps and device nodes        | [Platforms](platforms) · [Nodes](nodes)                                                                                                                          |
| Use the CLI and chat commands    | [CLI reference](cli) · [Slash commands](tools/slash-commands)                                                                                                    |
| Configure or operate the Gateway | [Configuration](gateway/configuration) · [Architecture](concepts/architecture) · [Updating](install/updating) · [Release channels](install/development-channels) |

## Development

The repository is a pnpm workspace. Plain `npm install` at the repository root is not supported.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm ui:build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and the [source setup guide](start/setup) for the development loop.

## Project identity

FreeChatClaw is maintained independently as a fork of OpenClaw. It retains OpenClaw
attribution for inherited code and follows the repository's license and
third-party notices. It is not an upstream OpenClaw Foundation distribution.

The public FreeChatClaw package, repository, and release identity will be finalized as a
single migration. Until then, `openclaw` package/CLI compatibility is retained.

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for maintainers and contribution guidelines; AI-assisted PRs are welcome.

Use the repository's issue and security channels for FreeChatClaw-specific work. When a
behavior belongs to the inherited OpenClaw foundation, consult the upstream
documentation and source history before changing it. New FreeChatClaw capabilities
should normally extend an existing owner or plugin contract rather than create
a parallel runtime path.

FreeChatClaw-specific community, release, and support information will be published
here as the fork identity is finalized. Upstream OpenClaw history and attribution
remain available from the upstream repository.

## License

[MIT](LICENSE). FreeChatClaw retains the required attribution for inherited OpenClaw and
other third-party code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
