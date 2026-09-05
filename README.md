# external-advisor

A Claude Code skill that gets a second opinion from a different model, without leaving Claude Code.

It shells out to the [Cursor CLI](https://cursor.com/docs/cli/overview) or the
[Antigravity CLI](https://antigravity.google/docs/cli) in read-only mode, so GPT-5.x, Grok, Gemini
or Composer can review a diff, critique the work Claude just did, answer a design question, or research something and come back with sources.
Each mode picks its own provider and model. Usage bills against whichever account you use.

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
- One or both of:
  - the [Cursor CLI](https://cursor.com/docs/cli/overview), with a Cursor subscription
  - the [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`), with a Google sign-in
- Node, any recent version. The runner is stdlib only, no dependencies.
- `gh`, only if you want `review --pr`

## Install

```bash
git clone https://github.com/alphainfinitus/claude-code-external-advisor
cd claude-code-external-advisor
./install.sh
```

That copies `skill/` into `~/.claude/skills/external-advisor/`, then runs a health check and
reports what each provider still needs:

```bash
# Cursor
curl https://cursor.com/install -fsS | bash
cursor-agent login

# Antigravity: install from https://antigravity.google/docs/cli, then sign in with
agy
```

To give it to a whole team instead, commit the same directory into your repo's `.agents/skills/`
or `.claude/skills/`, and gitignore its `config.json` and `runs/` so everyone keeps their own
model picks and history.

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

State lives inside the skill directory, next to `run.mjs`: `config.json` and `runs/`. Each
installation keeps its own, so a personal copy and a repo copy do not share configs. Set
`EXTERNAL_ADVISOR_HOME` to override, and run `doctor` to see the resolved path.

If you vendor the skill into a repo, gitignore its state while keeping its files tracked:

```gitignore
<path-to-skill>/config.json
<path-to-skill>/runs/
```

The config file in that directory:

| Key | Meaning |
|---|---|
| `models.review` / `.advise` / `.consult` / `.research` | `"<provider>/<model>"` per mode, e.g. `"agy/gemini-3.1-pro-high"`. Both halves are required; there is no separate provider key. |
| `timeoutSeconds` | Hard kill for a run. Default 900. |
| `keepRuns` | Run folders kept per repository. Default 20. |
| `sandbox` | Boolean, default `true`. Cursor maps it to `--sandbox enabled` / `disabled`. agy ignores it. |
| `maxDiffBytes` / `maxAdviseBytes` | Approximate size caps, measured in JavaScript characters. Truncation is always reported, never silent. |
| `modelLabels` | Display names, keyed by provider then model id. Refreshed by `sync-labels`. |

Ask Claude to "change the external advisor models" to re-run the picker rather than editing this
by hand.

Two notes on choosing models. Avoid `claude-*` for review and consult on either provider, since a
Claude checking Claude's work defeats the purpose; research is exempt, because it judges nothing
Claude wrote. Avoid `claude-fable-*` entirely, which Cursor flags as NO ZDR, meaning prompts are
retained. For research, check `webAccess` in `doctor` before picking: a provider whose web fetch is
allow-listed can digest local files but cannot look things up.

## How it works

Every invocation writes a packet to disk, runs the provider CLI in its read-only mode against that
packet, and parses the JSON result. Nothing is passed on the command line except a pointer to the
packet.

| Provider | CLI | Read-only flag | Strength |
|---|---|---|---|
| `cursor` | `cursor-agent` | `--mode ask` | **dispatch** - the CLI refuses write and shell tool calls |
| `agy` | `agy` | `--mode plan` | **prompt** - the model is told not to write; nothing refuses it |

Neither is a security boundary.

Print mode alone is not read-only at all. Cursor's own help says `-p` "has access to all tools,
including write and shell". Ask mode refuses mutating tool calls at dispatch.

agy's plan mode is a slash-command expansion, so it is an instruction rather than a permission
gate. It blocked writes and shell in every test. It does not survive a resume, so the runner sends
it on every call. agy's own `--sandbox` restricts nothing relevant, so it is not used.

Two further layers back them up: `sandbox` in config (Cursor only), and a content fingerprint of
the working tree taken before and after each run, which fails the run if anything moved.

In this configuration the external model can read files and spawn its own read-only subagents.
Shell, edits and MCP servers are blocked on Cursor.

On agy, plan mode removes nothing from the tool list. Measured on agy 1.1.26: the session still
lists file write, shell, subagents, web search, browser control and MCP tools. Plan mode is only an
instruction to the model. In tests it obeyed. The fingerprint guard is what catches a write. Whether
an agy subagent inherits the plan-mode instruction was not measured.

Web fetching is not blocked outright: the tool is dispatched and rejected per URL. Measured on
Cursor, `cursor.com` succeeds while `example.com`, `github.com`, `docs.anthropic.com` and
`raw.githubusercontent.com` are all rejected, which looks like a vendor allowlist rather than a
guarantee. Do not treat network isolation as part of the safety model.

`review --pr` fetches the PR head into a throwaway git worktree so the reviewer reads the PR's
actual code rather than your current checkout. The worktree and its ref are removed afterwards on
every exit path.

## Privacy

Every mode runs with the repository as the model's workspace by default, so it can read repository
files, and does. `research --scratch` is the exception: it hands over an empty throwaway directory
that is deleted when the run ends. What otherwise differs between modes is the transcript.

`advise` additionally forwards a distilled copy of the session to the provider's model vendor -
Cursor's model providers on `cursor`, Google on `agy` - including any tool output that passed
through it, and keeps a copy on disk. `agy` also keeps a full copy of every conversation under
`~/.gemini/antigravity-cli/`, outside this skill's control. Tell people that before they use it.
`review` and `consult` forward no transcript, only the packet you or the skill composed, so those
are the modes to use when session contents matter.

Packets and raw responses are written to the state directory's `runs/` and kept for the last
`keepRuns` runs per repository. They contain full diffs.

## Limitations

- Ask mode and plan mode are vendor behaviour, not security boundaries. Plan mode is the weaker of
  the two: it is an instruction to the model, not a refusal. Re-check both after a CLI upgrade.
- A write followed by a revert during a run is invisible to the fingerprint.
- The guard also fires if you edit repo files while a run is in progress. Runs take 30 to 150
  seconds.
- Claude Code stores thinking blocks with the text stripped, so `advise` forwards visible messages
  and tool calls but not internal reasoning.
- Called from inside a subagent, `advise` cannot detect that it is a subagent and will forward the
  parent session. Pass `--context <file>` there.
- A research finding is only as good as its quote. Check the quote against the source before
  relaying it, and treat anything in `unverified` as a guess.
- Web reach is a per-provider measurement recorded in `doctor`, not a guarantee. Cursor's URL
  fetch is allow-listed, so web research there is restricted; re-check after a CLI upgrade.

## License

MIT.
