# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code skill (`skill/`) that shells out to a second coding-agent CLI to get a second opinion
from a non-Claude model. Three are supported: the Cursor CLI (`cursor-agent`, `--mode ask`), the
Google Antigravity CLI (`agy`, `--mode plan`) and the OpenAI Codex CLI (`codex`, `-s read-only`).
Each job (`review`, `advise`, `consult`, `research`) picks its own provider and model.
`README.md` covers the user-facing story (modes, privacy, config keys);
`skill/SKILL.md` is the runtime instruction doc Claude follows when the skill is invoked. Don't
duplicate either here.

## Commands

No build, no lint, no dependencies. The runner is stdlib-only Node (ESM, `.mjs`).

```bash
node --test skill/run.test.mjs                                   # full suite (~25s, 65 tests)
node --test --test-name-pattern "write guard" skill/run.test.mjs # one describe/it by name
node skill/run.mjs doctor                                        # health check: binary, auth, live model list, resolved paths
./install.sh                                                     # copy skill/ to ~/.claude/skills/external-advisor/
```

The tests stub `gh`, `cursor-agent`, `agy` and `codex` as shell scripts on PATH and point
`EXTERNAL_ADVISOR_HOME` at a temp dir, so they need no network and no account with any vendor.
New tests must follow that pattern (`stubBin` / `runCli` / `writeConfig` helpers). Any test that
runs `doctor` must stub **every** provider binary — all three of `cursor-agent`, `agy` and `codex`
today: doctor probes all of `PROVIDERS`, so an unstubbed one reaches a real CLI on the developer's
machine. Each existing test pins a specific defect found by running the skill on itself; keep that
one-guard-per-test shape.

## Architecture

Four artifacts must stay in sync when behaviour changes:

- `skill/SKILL.md` documents the verbs, flags, JSON envelope fields, and the terminal status-line
  format Claude is told to use. It's what the model reads at runtime, so a flag or envelope key
  that exists in the code but not here is effectively invisible.
- `skill/run.mjs` implements them. Single file, no modules: `main()` dispatches on the verb
  (`review`, `consult`, `advise`, `research`, `resume`, `doctor`, `sync-labels`, `models`), builds a
  packet, and calls `invoke()`.
- `skill/prompts/<verb>.md` are loaded by name via `readPrompt(verb)` and prepended to the packet.
  Renaming a verb means renaming its prompt file.
- `skill/references/*.md` hold procedure too long to keep resident. `setup.md` is the seven-step
  first-run and model-change flow, moved out because it runs once but was loading on every run.
  Nothing in the code reads these: unlike `prompts/`, they arrive only if the model follows the
  pointer in SKILL.md, so anything that must hold on every run stays in SKILL.md itself. That is
  why the lineage rule and the `claude-fable-*` exclusion sit next to the pointer rather than
  inside `setup.md`, and why `advise`'s privacy note is stated in SKILL.md and not just linked.

**`invoke()` is the shared core.** Every model-facing verb goes through it: write `packet.md` into
a fresh run directory, fingerprint the tree, spawn the provider with a one-line prompt pointing at
the packet (nothing else goes on the command line), fingerprint again, parse the JSON result, and
prune old runs. Note the `repo` vs `workspace` distinction: `repo` is the durable identity used for
run history and the write guard; `workspace` is what the agent actually reads. For `review --pr`
that's a throwaway worktree under the system temp dir (`preparePr`), fingerprinted separately and
removed on every exit path including failure and SIGINT.

**Read-only is layered, not guaranteed, and the layers differ per provider.** `readOnlyStrength`
records which:

- cursor's `--mode ask` refuses writes at tool dispatch.
- agy's `--mode plan` only instructs the model. It does not survive a resume, so it is sent on
  every call.
- codex's `-s read-only` is the strongest. Two write routes were tried and each was blocked by a
  different layer: the patch tool at the tool router, a shell redirect at the OS sandbox
  (Seatbelt). Measured on codex-cli 0.153.4 on 2026-09-06. No single write was seen blocked by
  both.

Codex's resume path is the one mechanic worth knowing: `codex exec resume` accepts no `-s`, so the
sandbox rides on `-c sandbox_mode="read-only"` there. That is re-sent even though the guard was
measured to survive a resume on its own.

On top of all that sit the `sandbox` config flag (cursor only; agy's `--sandbox` restricts nothing
relevant, and codex needs no config flag because `-s read-only` is already its sandbox) and the
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
when the model is merely told), `buildArgs`, `listModels` (which doubles as the auth probe unless
the entry defines `auth`), and
`parse`, plus `webAccess` (`full` or `restricted`) and `webNote`, the measured web reach that only
`doctorReport` surfaces, for `references/setup.md` step 5 to read when a model is picked. No run path
checks them, so a one-off `research --model cursor/<id>` gets no `restricted` warning anywhere.
Four are optional:

- `validateModel(model)` — an error string for a model id this CLI cannot run, or null. Checked by
  `configErrors()` and again by `invoke()` before the run directory exists.
- `auth(run)` — `{ok, raw}` from a cheap sign-in probe, for a CLI whose `listModels` is expensive.
  `invoke()` prefers it; a provider without one is probed with `listModels`.
- `verifySession(requested, returned)`
- `warnings(run)`

`parse` returns the normalized `{ok, text, sessionId, usage, error}` or `null`,
and `invoke()` reads nothing else, so adding a CLI (gemini, say) touches no run, guard or
persistence logic. `buildArgs` must produce a read-only invocation. codex was added exactly that
way: its whole diff is one `PROVIDERS` entry plus two optional hooks. The `:<effort>` suffix a
codex model id may carry is parsed by `splitCodexEffort()`, the one helper behind both codex's
`validateModel` and its `buildArgs` — `splitModel()` still passes a colon straight through, and
`configErrors()` reaches the suffix only through `validateModel`.

**`advise` locates the transcript itself** via `CLAUDE_CODE_SESSION_ID` and
`~/.claude/projects/<repo-path-slug>/<sid>.jsonl`, then distils it (`distillTranscript`). It cannot
tell when it is running inside a subagent, which is why SKILL.md insists on `--context <file>` there.

## Constraints to preserve

- Default and offered models are non-Claude on purpose, on all three providers. agy's catalogue
  includes `claude-sonnet-4-6` and `claude-opus-4-6-thinking`, so the lineage rule (avoid `claude-*`
  for `review` and `consult`) applies there too. codex's catalogue carried no `claude-*` model when
  it was checked on 2026-09-06, so the rule had nothing to bite on there; that is one snapshot, not
  a guarantee. Never offer `claude-fable-*` (Cursor flags it NO ZDR); that note is Cursor-only.
- Nothing but the packet path goes on the provider command line. Diffs, questions, and transcripts
  go into `packet.md`.
- Truncation (diff or transcript over the configured byte cap) is always reported in the packet,
  never silent.
- The skill must work unchanged from `~/.claude/skills/` and from a repo's `.agents/skills/` or
  `.claude/skills/`, so nothing may hardcode a home path.
- The lineage rule (avoid `claude-*`) stops at `research`, which judges nothing Claude wrote. The
  `claude-fable-*` exclusion does not stop there: it is about prompt retention, not lineage.
- `webAccess` and `webNote` on a `PROVIDERS` entry are measurements, not policy. `research` runs on
  whatever provider its job names; a `restricted` rating narrows what it can do, never whether it
  runs. Re-measure after a CLI upgrade.
- `research --scratch` builds its workspace under the system temp dir, `git init` plus one empty
  commit so the fingerprint guard has a HEAD to compare against, and removes it on every exit path
  including signals. Never put it inside the repo.
