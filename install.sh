#!/usr/bin/env bash
# Bltz MCP installer. Safe to run more than once.
set -e
command -v node >/dev/null 2>&1 || { echo "✗ Needs Node 18+. brew install node"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || { echo "✗ Node $(node -v) is too old. Needs 18+."; exit 1; }

mkdir -p "$HOME/.config/bltz"
curl -fsSL https://raw.githubusercontent.com/xotw/bltz-mcp/main/mcp-server.js \
  -o "$HOME/.config/bltz/mcp-server.js"
echo "✓ Installed to ~/.config/bltz/mcp-server.js"

if command -v codex >/dev/null 2>&1; then
  codex mcp add bltz -- node "$HOME/.config/bltz/mcp-server.js" >/dev/null 2>&1 \
    && echo "✓ Registered with Codex." || echo "• Codex: already registered."
fi
if command -v claude >/dev/null 2>&1; then
  claude mcp add --scope user bltz -- node "$HOME/.config/bltz/mcp-server.js" >/dev/null 2>&1 \
    && echo "✓ Registered with Claude Code." || echo "• Claude Code: already registered."
fi

echo ""
echo "Now sign in:"
echo "    node ~/.config/bltz/mcp-server.js login you@yourcompany.com"
echo "Then restart your agent."
