#!/usr/bin/env bash
# Installs the external-advisor skill into ~/.claude/skills/.
# Per-user state (model picks, run history) lives inside the installed skill directory, next to run.mjs.
# Reinstalling copies the skill files over the old ones and deletes only what this repo no longer
# ships. config.json and runs/ are skipped on both sides - never copied out of the checkout, never
# overwritten, moved or removed in the install - so they are untouched at every point.
# Pass --yes to reinstall without the prompt, which is the only way to run this without a terminal.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skill"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/external-advisor"

usage() {
  echo "Usage: ./install.sh [-y|--yes]"
  echo
  echo "  -y, --yes    Reinstall without asking. Required when there is no terminal to ask on."
  echo
  echo "Your model picks (config.json) and run history (runs/) are kept either way."
}

assume_yes=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) assume_yes=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

if [ -d "$DEST" ] && [ "$assume_yes" -eq 0 ]; then
  # Without a terminal `read` either blocks forever or fails on EOF, which set -e turns into a
  # silent exit 1. Say what to do instead.
  if [ ! -t 0 ]; then
    echo "A skill already exists at $DEST, and there is no terminal to ask on." >&2
    echo "Re-run with --yes to replace the skill files. Your model picks and run history are kept." >&2
    exit 1
  fi
  echo "A skill already exists at $DEST"
  echo "Your model picks (config.json) and run history (runs/) are kept."
  read -r -p "Replace the rest of it? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

mkdir -p "$DEST"

# A development checkout has run the skill on itself, so it has its own config.json and runs/ sitting
# next to run.mjs - that is why .gitignore names them. Pruning them from the source walk keeps a
# developer's model picks and run history out of everyone else's install.
while IFS= read -r -d '' rel; do
  cp -R "$SRC/$rel" "$DEST/"
done < <(cd "$SRC" && find . -mindepth 1 -maxdepth 1 \( -path ./runs -o -path ./config.json \) -prune -o -print0)

# The old `rm -rf "$DEST"` took config.json and runs/ with it. Copying over the top keeps them, so
# the leftovers a clean copy used to handle - a prompt or helper this repo no longer ships - have to
# go by hand. Everything the user owns is pruned from the walk and so is never a deletion candidate.
# Collect the whole list first: deleting during the walk pulls directories out from under `find`,
# which then aborts with an fts_read error and leaves the entries it had not reached behind.
stale=()
while IFS= read -r -d '' rel; do
  [ -e "$SRC/$rel" ] || stale[${#stale[@]}]="$rel"
done < <(cd "$DEST" && find . -mindepth 1 \( -path ./runs -o -path ./config.json \) -prune -o -print0)
if [ ${#stale[@]} -gt 0 ]; then
  for rel in "${stale[@]}"; do
    rm -rf "$DEST/$rel"
  done
fi

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
        // A config so broken that doctor could not build a report prints only {ok,error}.
        if (r.error && !r.providers) {
          console.log("doctor: " + r.error);
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
echo "You need at least one provider. Install any of them:"
echo "  Cursor:      curl https://cursor.com/install -fsS | bash   then  cursor-agent login"
echo "  Antigravity: https://antigravity.google/docs/cli           then  agy"
echo "  Codex:       brew install codex                            then  codex login"
echo "               (or: npm install -g @openai/codex)"

echo
echo 'Then, in Claude Code: "set up the external advisor"'
