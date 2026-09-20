# external-advisor

A Claude Code plugin that gets a second opinion from a different model, without leaving Claude Code.

It shells out to the [Cursor CLI](https://cursor.com/docs/cli/overview), the
[Antigravity CLI](https://antigravity.google/docs/cli) or the
[Codex CLI](https://github.com/openai/codex) in read-only mode, so GPT-5.x, Grok, Gemini or
Composer can review a diff, critique the work Claude just did, answer a design question, or
research something and come back with sources. Each mode picks its own provider and model. Usage
bills against whichever account you use.

## Why

Claude reviewing Claude's code shares Claude's blind spots. A model from a different lineage,
which never saw the reasoning that produced the code, has no reason to find that reasoning
convincing.

## What it does

| Mode | What it does | What it sees |
|---|---|---|
| `advise` | Critiques the work your agent just did | The session transcript, distilled and forwarded automatically |
| `review` | Fresh-eyes review of a diff, branch, or GitHub PR | The diff and the repository, deliberately not your reasoning |
| `consult` | Answers a written question | The briefing you compose, plus the repository it can read |
| `research` | Looks something up and returns findings with sources and verbatim quotes | The question, plus either the repository or an empty throwaway directory with `--scratch` |

## Requirements

- [Claude Code](https://claude.com/claude-code)
- At least one of:
  - the [Cursor CLI](https://cursor.com/docs/cli/overview), with a Cursor subscription
  - the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`), with a Google sign-in
  - the [Codex CLI](https://github.com/openai/codex) (`codex`), with an OpenAI/ChatGPT sign-in
- Node, any recent version. The runner is stdlib only, no dependencies.
- `gh`, only if you want `review --pr`

## Install

First remove any copy installed the old way, as a skill:

```bash
rm -rf ~/.claude/skills/external-advisor
```

Skip that and the plugin installs but never runs. Claude Code drops a plugin's skill when a skill
of the same name already sits under `~/.claude/skills/`, so the old copy keeps winning: you go on
running the old code against the old state, and nothing anywhere tells you so.

Then, in Claude Code:

```
/plugin marketplace add alphainfinitus/claude-code-external-advisor
/plugin install external-advisor@alphainfinitus
```

Next, install at least one provider CLI and sign in:

```bash
# Cursor
curl https://cursor.com/install -fsS | bash
cursor-agent login

# Antigravity: install from https://antigravity.google/docs/cli, then sign in with
agy

# Codex
brew install codex          # or: npm install -g @openai/codex
codex login
```

To give it to a whole team, add the marketplace and install the plugin at project scope. These are
shell commands: `--scope` is a CLI flag, and the `/plugin` slash command asks you to pick a scope
interactively instead.

```bash
claude plugin marketplace add alphainfinitus/claude-code-external-advisor --scope project
claude plugin install external-advisor@alphainfinitus --scope project
```

Both write into the repository's `.claude/settings.json` — the marketplace under
`extraKnownMarketplaces`, the plugin under `enabledPlugins` — so they travel with the repo. A
teammate who clones it picks up the marketplace automatically once they trust the folder, but runs
the plugin install once themselves: Claude Code does not auto-install code from an external
repository on their behalf.

## Quick start

In Claude Code, first time only:

```
set up the external advisor
```

That runs a health check, asks you to pick a model for each of the four modes, and writes the
config.

Then just ask for what you want. The skill picks the mode from the shape of the request:

```
review PR 1234 with the external advisor
sanity-check my approach, use external-advisor
what would GPT say about this design?
review this diff using grok
research what changed in the Antigravity CLI this month
```

Naming a model in the request overrides the configured one for that run.

## Configuration

State lives in the plugin's own data directory, outside any repository:

```
~/.claude/plugins/data/external-advisor-alphainfinitus/
```

It holds `config.json` and `runs/`. It survives plugin updates, and is removed when you uninstall
unless you pass `--keep-data`.

State used to live in the install directory itself, `~/.claude/skills/external-advisor/`. If you
have one there, copy its `config.json` into the directory above to keep your model picks. The run
history can stay behind.

Because it sits outside every repository, run artifacts do not appear in a project's `git status`
or trip the write guard. (The exception is running `run.mjs` straight from a checkout of this repo
with no `EXTERNAL_ADVISOR_HOME` set — it then writes beside itself, which is why `/config.json`
and `/runs/` are gitignored here.)

Set `EXTERNAL_ADVISOR_HOME` to override the location. Run `doctor` to see the resolved path,
reported as `stateRoot`.

The config file in that directory:

| Key | Meaning |
|---|---|
| `models.review` / `.advise` / `.consult` / `.research` | `"<provider>/<model>"` per mode, e.g. `"agy/gemini-3.1-pro-high"`. Both halves are required; there is no separate provider key. On `codex` the model half usually ends in a reasoning-effort suffix, e.g. `"codex/gpt-5.6-terra:xhigh"`; a model that offers no efforts is listed bare, and runs at codex's default effort. |
| `timeoutSeconds` | Hard kill for a run. Default 900. |
| `keepRuns` | Run folders kept per repository. Default 20. |
| `sandbox` | Boolean, default `true`. Cursor maps it to `--sandbox enabled` / `disabled`. agy and codex ignore it. |
| `maxDiffBytes` / `maxAdviseBytes` | Approximate size caps, measured in JavaScript characters. Truncation is always reported, never silent. |
| `modelLabels` | Display names, keyed by provider then model id. Refreshed by `sync-labels`. |

Ask Claude to "change the external advisor models" to re-run the picker rather than editing this
by hand.

Two notes on choosing models. Avoid `claude-*` for review and consult on any provider, since a
Claude checking Claude's work defeats the purpose; research is exempt, because it judges nothing
Claude wrote. Avoid `claude-fable-*` entirely, which Cursor flags as NO ZDR, meaning prompts are
retained. For research, check `webAccess` in `doctor` before picking: `restricted` means that
provider's web reach was measured to be limited, so web lookups there are unreliable. What the
limit actually is differs per provider and is recorded in its `webNote`. Digesting local files
still works either way.

## How it works

Every invocation writes a packet to disk, runs the provider CLI in its read-only mode against that
packet, and parses the JSON result. Nothing is passed on the command line except a pointer to the
packet.

| Provider | CLI | Read-only flag | Strength |
|---|---|---|---|
| `cursor` | `cursor-agent` | `--mode ask` | **dispatch** - the CLI refuses write and shell tool calls |
| `agy` | `agy` | `--mode plan` | **prompt** - the model is told not to write; nothing refuses it |
| `codex` | `codex` | `-s read-only` | **dispatch** - each write route tried was blocked: the patch tool by the CLI, a shell write by the OS sandbox |

None of the three is a security boundary. Codex's guard is the strongest, Cursor's next, agy's the
weakest.

Print mode alone is not read-only at all. Cursor's own help says `-p` "has access to all tools,
including write and shell". Ask mode refuses mutating tool calls at dispatch.

agy's plan mode is a slash-command expansion, so it is an instruction rather than a permission
gate, and it has been seen not to hold. It does not survive a resume, so the runner sends it on
every call. agy's own `--sandbox` restricts nothing relevant, so it is not used.

Two further layers back them up: `sandbox` in config (Cursor only), and a content fingerprint of
the working tree taken before and after each run, which fails the run if anything moved.

In this configuration the external model can read files, and on Cursor and agy it can spawn its
own read-only subagents. Whether codex spawns subagents was not measured. Shell, edits and MCP
servers are blocked on Cursor.

On agy, plan mode removes nothing from the tool list. Measured on agy 1.1.26: the session still
lists file write, shell, subagents, web search, browser control and MCP tools. Plan mode is only an
instruction to the model, and the model does not always follow it. On 2026-09-05, on agy 1.1.27, a
read-only review run wrote a 6795-byte `AGENTS.md` into the repository root that nobody had asked
for. That is one observed instance, not a rate. The fingerprint guard caught it and failed the run.
It is the only thing that does. Whether an agy subagent inherits the plan-mode instruction was not
measured.

Codex's `-s read-only` is the strongest of the three. Two different write routes were tried, and
each was stopped by a different layer. Measured on codex-cli 0.153.4 on 2026-09-06, in a throwaway
repo: the patch tool was rejected by the tool router - the part of the CLI that decides which tool
calls are allowed to run - and a shell `echo hi > FILE` was refused by the OS sandbox. No file was
created either time. No single write was seen blocked by both layers. Read-only also survives a
resume there, though the runner re-sends it on every call anyway. Codex ignores the `sandbox`
config key, because `-s read-only` is already its sandbox.

Web fetching is not blocked outright: the tool is dispatched and rejected per URL. Measured on
Cursor, `cursor.com` succeeds while `example.com`, `github.com`, `docs.anthropic.com` and
`raw.githubusercontent.com` are all rejected, which looks like a vendor allowlist rather than a
guarantee. Do not treat network isolation as part of the safety model.

Codex's web reach is `full`: its built-in web tool did both a search and a fetch of `example.com`
under `-s read-only`. Whether a plain shell `curl` has network there was not measured.

`review --pr` fetches the PR head into a throwaway git worktree so the reviewer reads the PR's
actual code rather than your current checkout. The worktree and its ref are removed afterwards on
every exit path.

## Privacy

Every mode runs with the repository as the model's workspace by default, so it can read repository
files, and does. `research --scratch` is the exception: it hands over an empty throwaway directory
that is deleted when the run ends. What otherwise differs between modes is the transcript.

`advise` additionally forwards a distilled copy of the session to the provider's model vendor -
Cursor's model providers on `cursor`, Google on `agy`, OpenAI on `codex` - including any tool
output that passed through it, and keeps a copy on disk. `agy` also keeps a full copy of every
conversation under `~/.gemini/antigravity-cli/`, and `codex` keeps a full copy of every session
under `~/.codex/sessions/`. Both are outside this skill's control. Tell people that before they
use it.
`review`, `consult` and `research` forward no transcript, only the packet you or the skill
composed, so those are the modes to use when session contents matter. `research --scratch` is the
most private of the four: no transcript, and not even the repository. Not nothing, though. The
model is still handed the run directory, a path under the skill's state directory - which by
default sits in your home directory, so it carries your username as well as this repository's
name. On `agy` and `codex` the workspace is only the process working directory, so nothing stops a
read outside it; codex was measured reading files under `~/.codex` and `~/.agents`.

On `codex` the skill passes `--ignore-user-config`, so your own codex MCP servers do not spawn
during an advisor run. That was measured, not assumed: without the flag one of them threw an auth
error, and with the flag that error was gone. It is not a full seal - codex still reads global
skills under `~/.agents` and `~/.codex/plugins`.

Packets and raw responses are written to the state directory's `runs/` and kept for the last
`keepRuns` runs per repository. They contain full diffs.

## Limitations

- Read-only mode is vendor behaviour on all three CLIs, not a security boundary. Codex's is the
  strongest: both write routes tried were blocked, the patch tool by the tool router and a shell
  write by the OS sandbox. Cursor's is next (the CLI refuses the call), and agy's plan mode the
  weakest: an instruction to the model, not a refusal. Re-check all three after a CLI upgrade.
- A write followed by a revert during a run is invisible to the fingerprint.
- The guard also fires if you edit repo files while a run is in progress. Runs take 30 to 150
  seconds.
- Claude Code stores thinking blocks with the text stripped, so `advise` forwards visible messages
  and tool calls but not internal reasoning.
- Called from inside a subagent, `advise` cannot detect that it is a subagent and will forward the
  parent session. Pass `--context <file>` there.
- A research finding is only as good as its quote. Check the quote against the source before
  relaying it, and treat anything in `unverified` as a guess.
- Web reach is a per-provider measurement recorded in `doctor`, not a guarantee. A `restricted`
  rating means that provider's reach was measured to be limited, and its `webNote` says how;
  Cursor's is an allow-list on URL fetch. Re-check after a CLI upgrade.

## Developing

```bash
claude --plugin-dir .      # load this checkout as a plugin, no install
node --test run.test.mjs   # the 72-test suite
claude plugin validate . --strict
```

Run `/reload-plugins` after editing to pick changes up without restarting.

Work from `--plugin-dir`, not from a local-path install. A local-path install copies the working
tree into the plugin cache verbatim, gitignored files included, so private notes and scratch
directories are swept along with the code. `--plugin-dir` reads the directory in place and copies
nothing. Installing from the GitHub source clones instead, so it is unaffected.

A `--plugin-dir` checkout gets its own data directory (`external-advisor-inline`), separate from
an installed copy. Your development runs and your real config do not share state.

## License

MIT.
