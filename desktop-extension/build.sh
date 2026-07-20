#!/usr/bin/env bash
# Build charter.mcpb (Claude Desktop extension). The MCP proxy is the SAME
# canonical file the Claude Code plugin uses — staged in at build time, never
# duplicated in git. A .mcpb is just a zip with manifest.json at the root.
# Runs on Claude Desktop's bundled Node — the adopter needs no Python/Node install.
set -euo pipefail
cd "$(dirname "$0")"

PROXY=../plugin/proxy/charter_mcp.js
OUT="$PWD/charter.mcpb"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/server"
cp manifest.json "$STAGE/"
cp "$PROXY" "$STAGE/server/charter_mcp.js"

node -e "JSON.parse(require('fs').readFileSync('$STAGE/manifest.json','utf8'))"  # manifest is valid JSON
node "$STAGE/server/charter_mcp.js" --selftest                                # proxy passes its own check

rm -f "$OUT"
( cd "$STAGE" && zip -qr -X "$OUT" manifest.json server )
echo "built $OUT"
unzip -l "$OUT"
