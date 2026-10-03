import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";

/** Crabbox executes script-stdin with the target's native shell. */
export function wrapCrabboxNodeScript(
  script: string,
  target: CrabboxOperatingSystem = "linux",
  delimiter = "CRABBOX_NODE_SCRIPT",
): string {
  if (target !== "windows/normal") {
    return `set -eu
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME/.local/openclaw-node/bin/node" /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi
if [ -z "$NODE" ]; then echo 'Cloud worker requires Node.js on PATH or $HOME/.local/openclaw-node/bin/node' >&2; exit 127; fi
"$NODE" <<'${delimiter}'
${script}
${delimiter}`;
  }
  return `$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) { throw 'Cloud worker requires Node.js on PATH; update the Crabbox Windows bootstrap image and reprovision the worker' }
$scriptPath = Join-Path $env:TEMP ('openclaw-' + [Guid]::NewGuid().ToString('N') + '.cjs')
try {
  $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString("base64")}'))
  [IO.File]::WriteAllText($scriptPath, $source, [Text.UTF8Encoding]::new($false))
  & $node.Source $scriptPath
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}
exit $code`;
}
