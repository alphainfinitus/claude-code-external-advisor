#!/usr/bin/env bash
# Installs the external-advisor skill into ~/.claude/skills/.
# Per-user state (model picks, run history) lives inside the installed skill directory, next to run.mjs.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skill"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/external-advisor"

if [ -d "$DEST" ]; then
  echo "A skill already exists at $DEST"
  read -r -p "Overwrite it? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
  rm -rf "$DEST"
fi

mkdir -p "$(dirname "$DEST")"
cp -R "$SRC" "$DEST"
chmod +x "$DEST/run.mjs"
echo "Installed to $DEST"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node is not on PATH. Install Node, then re-run this script."
elif command -v cursor-agent >/dev/null 2>&1; then
  # Report doctor's own diagnosis rather than assuming every failure is an auth problem.
  if out=$(node "$DEST/run.mjs" doctor 2>&1); then
    echo "Cursor CLI found and authenticated."
  else
    echo "Cursor CLI found, but the health check failed:"
    echo "$out" | sed 's/^/  /'
  fi
else
  echo
  echo "Cursor CLI not installed. Next:"
  echo "  curl https://cursor.com/install -fsS | bash"
  echo "  cursor-agent login"
fi

echo
echo 'Then, in Claude Code: "set up the external advisor"'
