# external-advisor

A Claude Code skill that gets a second opinion from a different model, without leaving Claude Code.

It shells out to the [Cursor CLI](https://cursor.com/docs/cli/overview) in read-only mode, so
GPT-5.x, Grok, Gemini or Composer can review a diff, critique the work Claude just did, or answer
a design question. Usage bills against your existing Cursor subscription.

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

## Requirements

- [Claude Code](https://claude.com/claude-code)
- A Cursor subscription and the Cursor CLI
- Node, any recent version. The runner is stdlib only, no dependencies.
- `gh`, only if you want `review --pr`

## Install

```bash
git clone https://github.com/alphainfinitus/claude-code-external-advisor
cd claude-code-external-advisor
./install.sh
```

That copies `skill/` into `~/.claude/skills/external-advisor/`. If the Cursor CLI is missing it
prints the two commands to install and log in:

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent login
```

To give it to a whole team instead, commit the same directory into your repo's `.agents/skills/`
or `.claude/skills/`, and gitignore its `config.json` and `runs/` so everyone keeps their own
model picks and history.

## Quick start

In Claude Code, first time only:

```
set up the external advisor
```

That runs a health check, asks you to pick a model for each of the three modes, and writes the
config.

Then just ask for what you want. The skill picks the mode from the shape of the request:

```
review PR 1234 with the external advisor
sanity-check my approach, use external-advisor
what would GPT say about this design?
review this diff using grok
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
| `models.review` / `.advise` / `.consult` | Model per mode. All three default to a large-context reasoning model. A code-specialised model is a reasonable alternative for `review` if you prefer speed over depth. |
| `timeoutSeconds` | Hard kill for a run. Default 900. |
| `keepRuns` | Run folders kept per repository. Default 20. |
| `sandbox` | `enabled` or `disabled`. |
| `maxDiffBytes` / `maxAdviseBytes` | Approximate size caps, measured in JavaScript characters. Truncation is always reported, never silent. |
| `modelLabels` | Display names, refreshed by `sync-labels`. |

Ask Claude to "change the external advisor models" to re-run the picker rather than editing this
by hand.

Two notes on choosing models. Avoid `claude-*` for review and consult, since a Claude checking
Claude's work defeats the purpose. Avoid `claude-fable-*` entirely, which Cursor flags as NO ZDR,
meaning prompts are retained.

## How it works

Every invocation writes a packet to disk, runs `cursor-agent -p --mode ask` against it, and parses
the JSON result. Nothing is passed on the command line except a pointer to the packet.

`--mode ask` is the read-only guarantee. Print mode alone is not: Cursor's own help says `-p` "has
access to all tools, including write and shell". Ask mode refuses mutating tool calls at dispatch.
Two further layers back it up: `--sandbox enabled`, and a content fingerprint of the working tree
taken before and after each run, which fails the run if anything moved.

In this configuration the external model can read files and spawn its own read-only subagents.
Shell, edits and MCP servers are blocked.

Web fetching is not blocked outright: the tool is dispatched and rejected per URL. Measured,
`cursor.com` succeeds while `example.com`, `github.com`, `docs.anthropic.com` and
`raw.githubusercontent.com` are all rejected, which looks like a vendor allowlist rather than a
guarantee. Do not treat network isolation as part of the safety model.

`review --pr` fetches the PR head into a throwaway git worktree so the reviewer reads the PR's
actual code rather than your current checkout. The worktree and its ref are removed afterwards on
every exit path.

## Privacy

All three modes run with the repository as the model's workspace, so it can read repository files
in any mode, and does. What differs is the transcript.

`advise` additionally forwards a distilled copy of the session to Cursor's model providers,
including any tool output that passed through it, and keeps a copy on disk. Tell people that
before they use it. `review` and `consult` forward no transcript, only the packet you or the
skill composed, so those are the modes to use when session contents matter.

Packets and raw responses are written to the state directory's `runs/` and kept for the last
`keepRuns` runs per repository. They contain full diffs.

## Limitations

- Ask mode is vendor behaviour, not a security boundary. Re-check it after a Cursor CLI upgrade.
- A write followed by a revert during a run is invisible to the fingerprint.
- The guard also fires if you edit repo files while a run is in progress. Runs take 30 to 150
  seconds.
- Claude Code stores thinking blocks with the text stripped, so `advise` forwards visible messages
  and tool calls but not internal reasoning.
- Called from inside a subagent, `advise` cannot detect that it is a subagent and will forward the
  parent session. Pass `--context <file>` there.

## License

MIT.
