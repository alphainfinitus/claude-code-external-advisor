# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code skill (`skill/`) that shells out to a second coding-agent CLI to get a second opinion
from a non-Claude model. Two are supported: the Cursor CLI (`cursor-agent`, `--mode ask`) and the
Google Antigravity CLI (`agy`, `--mode plan`). Each job (`review`, `advise`, `consult`) picks its
own provider and model. `README.md` covers the user-facing story (modes, privacy, config keys);
`skill/SKILL.md` is the runtime instruction doc Claude follows when the skill is invoked. Don't
duplicate either here.

## Commands

No build, no lint, no dependencies. The runner is stdlib-only Node (ESM, `.mjs`).

```bash
node --test skill/run.test.mjs                                   # full suite (~6s, 21 tests)
node --test --test-name-pattern "write guard" skill/run.test.mjs # one describe/it by name
node skill/run.mjs doctor                                        # health check: binary, auth, live model list, resolved paths
./install.sh                                                     # copy skill/ to ~/.claude/skills/external-advisor/
```

The tests stub `gh`, `cursor-agent` and `agy` as shell scripts on PATH and point
`EXTERNAL_ADVISOR_HOME` at a temp dir, so they need no network and no account with either vendor.
New tests must follow that pattern (`stubBin` / `runCli` / `writeConfig` helpers). Any test that
runs `doctor` must stub **every** provider binary: doctor probes all of `PROVIDERS`, so an
unstubbed one reaches a real CLI on the developer's machine. Each existing test pins a specific
defect found by running the skill on itself; keep that one-guard-per-test shape.

## Architecture

Three artifacts must stay in sync when behaviour changes:

- `skill/SKILL.md` documents the verbs, flags, JSON envelope fields, and the terminal status-line
  format Claude is told to use. It's what the model reads at runtime, so a flag or envelope key
  that exists in the code but not here is effectively invisible.
- `skill/run.mjs` implements them. Single file, no modules: `main()` dispatches on the verb
  (`review`, `consult`, `advise`, `resume`, `doctor`, `sync-labels`, `models`), builds a packet, and
  calls `invoke()`.
- `skill/prompts/<verb>.md` are loaded by name via `readPrompt(verb)` and prepended to the packet.
  Renaming a verb means renaming its prompt file.

**`invoke()` is the shared core.** Every model-facing verb goes through it: write `packet.md` into
a fresh run directory, fingerprint the tree, spawn the provider with a one-line prompt pointing at
the packet (nothing else goes on the command line), fingerprint again, parse the JSON result, and
prune old runs. Note the `repo` vs `workspace` distinction: `repo` is the durable identity used for
run history and the write guard; `workspace` is what the agent actually reads. For `review --pr`
that's a throwaway worktree under the system temp dir (`preparePr`), fingerprinted separately and
removed on every exit path including failure and SIGINT.

**Read-only is layered, not guaranteed, and the layers differ per provider.** `readOnlyStrength`
records which: cursor's `--mode ask` refuses writes at tool dispatch; agy's `--mode plan` only
instructs the model, does not survive a resume, and so is sent on every call. On top of that sit
the `sandbox` config flag (cursor only; agy's own `--sandbox` restricts nothing relevant) and the
before/after `treeFingerprint` (status list + tracked diff + size/mtime of untracked files). A
fingerprint mismatch marks the run failed even if the model answered. Re-verify what each mode
blocks after a CLI upgrade.

**State lives next to `run.mjs`**: `config.json` and `runs/<repo-slug>/<runId>-<verb>/`, overridable
by `EXTERNAL_ADVISOR_HOME`. Both are gitignored, and that is load-bearing: ignored files are outside
`git status --exclude-standard`, so writing run artifacts cannot trip the skill's own write guard.
`sync-labels` is the only verb that writes config; it must never run concurrently with a run.
`models.<job>` is `"<provider>/<model>"`; there is no global `provider` key, and a config that
still carries one is rejected rather than half-read. `modelLabels` is keyed by provider, then
model id.

**`PROVIDERS` is the extension point.** It is the only place that knows a CLI's flags or output
format. Each entry carries `bin`, `installHint`, `loginHint`, `readOnly` (the flag that makes the
run read-only), `readOnlyStrength` (`"dispatch"` when the CLI refuses the tool call, `"prompt"`
when the model is merely told), `buildArgs`, `listModels` (which doubles as the auth probe), and
`parse`. Two are optional: `verifySession(requested, returned)` and `warnings(run)`. `parse`
returns the normalized `{ok, text, sessionId, usage, error}` or `null`, and `invoke()` reads
nothing else, so adding a CLI (codex, gemini) touches no run, guard or persistence logic.
`buildArgs` must produce a read-only invocation.

**`advise` locates the transcript itself** via `CLAUDE_CODE_SESSION_ID` and
`~/.claude/projects/<repo-path-slug>/<sid>.jsonl`, then distils it (`distillTranscript`). It cannot
tell when it is running inside a subagent, which is why SKILL.md insists on `--context <file>` there.

## Constraints to preserve

- Default and offered models are non-Claude on purpose, on both providers. agy's catalogue
  includes `claude-sonnet-4-6` and `claude-opus-4-6-thinking`, so the lineage rule (avoid `claude-*`
  for `review` and `consult`) applies there too. Never offer `claude-fable-*` (Cursor flags it
  NO ZDR); that note is Cursor-only.
- Nothing but the packet path goes on the provider command line. Diffs, questions, and transcripts
  go into `packet.md`.
- Truncation (diff or transcript over the configured byte cap) is always reported in the packet,
  never silent.
- The skill must work unchanged from `~/.claude/skills/` and from a repo's `.agents/skills/` or
  `.claude/skills/`, so nothing may hardcode a home path.
