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
else
  # doctor exits 1 when a configured provider is missing or signed out, so guard against set -e.
  out="$(node "$DEST/run.mjs" doctor 2>/dev/null || true)"
  echo
  if [ -z "$out" ]; then
    echo "Health check produced no output. Run: node $DEST/run.mjs doctor"
  else
    printf '%s' "$out" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        let r;
        try {
          r = JSON.parse(s);
        } catch {
          console.log("Health check output was not JSON. Run the doctor command by hand.");
          return;
        }
        for (const [name, p] of Object.entries(r.providers || {})) {
          if (!p.bin) console.log(name + ": not installed. Install: " + p.installHint);
          else if (!p.authenticated) console.log(name + ": installed, not signed in. Run: " + p.thenRun);
          else console.log(name + ": ready (" + p.modelCount + " models, read-only via " + p.readOnly + ").");
          for (const w of p.warnings || []) console.log(name + ": warning: " + w);
        }
        for (const e of r.configErrors || []) console.log("config: " + e);
      });
    '
  fi
fi

echo
echo "You need at least one provider. Install either or both:"
echo "  Cursor:      curl https://cursor.com/install -fsS | bash   then  cursor-agent login"
echo "  Antigravity: https://antigravity.google/docs/cli           then  agy"

echo
echo 'Then, in Claude Code: "set up the external advisor"'
