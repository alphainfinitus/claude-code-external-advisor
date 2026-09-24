---
name: external-advisor
description: Get a second opinion from a different AI model (GPT-5.x, Grok, Gemini, Composer) through the Cursor, Antigravity or OpenAI Codex CLI, without leaving Claude Code. Use whenever the user asks for an external review, a second opinion, a sanity check from another model, "what would GPT/Gemini/Codex/Cursor say", "am I missing something", "check my approach", wants a PR or diff or design judged by something that isn't Claude, or is stuck on a decision where independent judgement helps - and whenever they name it directly ("use the external-advisor", "/external-advisor"). Also use when the user wants something looked up or researched - library docs, API changes, comparing tools, "what's the current best way to", "find out about", or digesting a large codebase or doc set. Four modes - advise (critique the work THIS agent just did), review (a diff or PR), consult (a question), research (the web or a large file set, sourced). Read this before running cursor-agent, agy or codex by hand.
---

# External advisor

Runs a **different model** over your work and brings its answer back here. The point is lineage
diversity: Claude reviewing Claude's code shares Claude's blind spots, and a model that never saw
the reasoning has no reason to find it convincing.

Three provider CLIs are supported. Each job picks one, in config.

| Provider | CLI | Needs | Read-only flag | How strong that guard is |
|---|---|---|---|---|
| `cursor` | `cursor-agent` | a Cursor account | `--mode ask` | **dispatch** - the CLI refuses write and shell tool calls |
| `agy` | `agy` (Google Antigravity) | a Google sign-in | `--mode plan` | **prompt** - the model is *told* not to write; nothing refuses it |
| `codex` | `codex` (OpenAI Codex) | an OpenAI/ChatGPT sign-in | `-s read-only` | **dispatch** - each write route tried was blocked: the patch tool by the CLI, a shell write by the OS sandbox |

Only one of the three has to be installed. Whatever is missing simply cannot be picked.

"Dispatch" means the tool call is rejected by the CLI itself. "Prompt" means it is only an
instruction to the model. Strongest guard first: `codex`, then `cursor`, then `agy`. None of the
three is a security boundary.

On agy, plan mode leaves the full tool list in place: file write, shell, subagents, web search,
browser control and MCP tools all stay listed (measured on agy 1.1.26). Only the instruction and
the fingerprint guard stand between the model and a write, and the instruction has been seen to
fail: on 2026-09-05, on agy 1.1.27, a read-only review run wrote an `AGENTS.md` into the repository
root that nobody had asked for. One observed instance, not a rate. The fingerprint guard caught it
and failed the run. Cursor and agy can both spawn their own subagents; on agy, whether a subagent
inherits plan mode was not measured.

On codex two write routes were tried when measured (codex-cli 0.153.4, 2026-09-06), and each was
blocked by a different layer: the patch tool was refused by the CLI, and a shell redirect into a
new file failed at the OS sandbox. No file appeared either time. No single write was seen blocked
by both layers. Whether codex spawns its own subagents was not measured.

Two further layers back them up:

- `sandbox` in config, which maps to Cursor's `--sandbox`. agy and codex ignore it.
- A content fingerprint of the working tree taken before and after every run. If anything moved,
  the run is marked failed even when the model answered.

Re-check what each read-only mode blocks after a CLI upgrade.

## setup — first run, and changing models

Read `references/setup.md`, next to this file, and follow its seven steps in order. Do that
whenever the user asks to set the advisor up or change a model, whenever a run fails with an
`error` ending in `run setup`, whenever `doctor` returns a non-empty `configErrors`, and whenever
you are about to write `config.json` at all — by hand or through `sync-labels`. When a failed run
sent you here, rerun the user's original request once setup is done, in place of step 7's test
review. It covers the health check, installing and signing in, carrying picks over from the old
skill install, choosing a provider and model per job, and what `advise` sends to the vendor. The
rules for reading `doctor` output are there too: `configErrors` first, every warning relayed
verbatim, and an unreadable `toolPermission` treated as unknown rather than safe. Do not improvise
setup from memory, and do not skip a step because it looks like a formality — the question order
and the verbatim warnings are the point.

Never guess at model IDs — they rot fast, and `doctor` is the live list per provider. Steer away
from `claude-*` for `review` and `consult` on **any** provider: a Claude reviewing Claude's work
defeats the purpose. agy's catalogue includes `claude-sonnet-4-6` and `claude-opus-4-6-thinking`,
so that rule applies there too. On 2026-09-06 codex's live list carried no `claude-*` model, so the
rule had nothing to bite on there — one snapshot, not a promise, so read `doctor` rather than this
line. It stops at `research`, which judges nothing Claude wrote. Never offer `claude-fable-*`,
which Cursor flags **NO ZDR**, meaning prompts are retained. That NO ZDR note is Cursor-specific.

On `codex` a model id carries its reasoning effort as a suffix: `codex/gpt-5.6-terra:xhigh`. The
part after the last colon is the effort. The valid values are `low`, `medium`, `high`, `xhigh`,
`max` and `ultra`, and not every model offers every one, so take the combinations `doctor` lists
rather than composing your own. A *bare slug* is a codex model id with no `:<effort>` on the end.
`doctor` lists one only for a model that offers no efforts at all, so a bare slug in the config was
almost always typed by hand rather than copied from `doctor`. Codex runs a bare slug at its own
default effort.

## Where the runner lives

Commands below use two placeholders:

- `${CLAUDE_PLUGIN_ROOT}` — where this plugin is installed, holding `run.mjs`
- `${CLAUDE_PLUGIN_DATA}` — this plugin's own state directory

Claude Code replaces both with real absolute paths before you read this file. Use them exactly as
written, **double quotes included**: a path may contain a space, and an unquoted command would
split on it and fail.

State — `config.json` and `runs/` — lives under `${CLAUDE_PLUGIN_DATA}`, outside any repository.
Run artifacts therefore never reach `git status --exclude-standard` and cannot trip the write
guard. `doctor` reports the resolved path as `stateRoot`.

Transient PR worktrees go to the system temp directory rather than the repo: a full checkout inside
the working tree is still picked up by file watchers, linters and test globs even when gitignored.

## How this shows up in the user's terminal

The user sees the `description` you set on the Bash call, so it is the only status line
available - set it on **every** external-advisor invocation, in exactly this shape:

```
<Verb> via External Advisor using <model label>
```

- `advise`   → `Advising via External Advisor using GPT-5.6 Sol 1M High`
- `review`   → `Reviewing via External Advisor using Codex 5.3 High`
- `consult`  → `Consulting via External Advisor using GPT-5.6 Sol 1M High`
- `research` → `Researching via External Advisor using Gemini 3.8 Flash High`
- `resume`   → `Following up via External Advisor using GPT-5.6 Sol 1M High`

Model labels live in `modelLabels` in the config, keyed by **provider first, then model id**. Read
`modelLabels[provider][model]` rather than inventing a name, and fall back to `provider/model` if
the label isn't there. Every run's JSON envelope carries `provider` and `model`, so you can look
the label up after the fact. If a model you're about to use has no label, run
`EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" sync-labels` - it caches display names for every model that is configured or
has been used before, and drops ids a provider has retired. Never write all 200+ into the config;
that turns it into 34KB nobody can read.

`sync-labels` also returns a `skipped` array.
It names the providers it could not refresh.
Their labels are left as they were.

After a run that used `--model` with something not already in the table, run `sync-labels` once
the run has finished. That keeps the table current without anyone having to think about it, and
the next mention of that model gets a real name instead of a raw id.

`sync-labels` writes the config, so run it between runs, never during one - concurrent runs
writing a shared config is the same class of bug that made runs overwrite each other's packets. Runs take 30-150s, so this line is on
screen for a while; it's what tells the user which model is thinking and in what capacity.

When the run comes back, say in one line what happened before you act on it - e.g. "GPT-5.6 Sol
found 2 issues, verifying both" or "Codex says ship, no findings". The user should never have to
guess whether the external model agreed with you.

## Which mode

Pick from the shape of the request and say in one line which you picked; the user overrides by
naming a verb. Don't ask them to choose - that defeats the point of it being seamless.

| The user says | Mode | Why |
|---|---|---|
| "review PR 1234", "look at this diff", "is this design sound" | `review` / `consult` | They want judgement on the *code or question*. Your context is deliberately absent - that's the independence they're paying for. |
| "sanity-check my approach", "am I missing something", "what did I get wrong" | `advise` | They want judgement on *what you just did*. Your context is the whole input. |
| "look this up", "what's the current best way to X", "read these docs and tell me", "compare these libraries" | `research` | They want *facts with sources*, not judgement. |

When the user asks to review a PR **and** names external-advisor, do both — it's strictly better
than either alone:

1. Start `review --pr <n>` **in the background first**.
2. Do your own review while it runs (30–150s of free parallelism).
3. Read its findings only **after** your own pass is done. Reading first anchors you to its
   conclusions and destroys the independence that makes reconciling worthwhile.
4. Reconcile: found by both → high confidence. Only theirs → verify before relaying. Only
   yours → keep.

## advise — an external model critiques your work

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" advise \
  --question "what have I got wrong here?"
```

This is the built-in `advisor` shape, with a different model. It finds this session's transcript
by itself and distils it — human turns, your visible prose, and tool calls reduced to name plus
truncated argument and result — so you write no briefing at all. `--question` is optional;
without it you get a general assessment.

**Say what it sends, before the user's first `advise`.** It forwards a distilled copy of the
whole session - including tool output that merely passed through it, such as ticket contents,
log queries or internal search results - to the vendor behind the configured provider. On `agy`
that is Google, which also keeps its own copy under `~/.gemini/antigravity-cli/`, outside this
plugin's control. On `codex` that is OpenAI, which keeps its own copy of every session under
`~/.codex/sessions/`, also outside this plugin's control. There the runner passes
`--ignore-user-config`, so the user's own codex MCP servers do not spawn during a run. That is not
a full seal: global skills under `~/.agents` and `~/.codex/plugins` are still read. `review`,
`consult` and `research` forward no transcript, so those are the modes for when session contents
matter. Step 6 of `references/setup.md` is the full version.

It differs from the built-in `advisor` in one way worth knowing: Claude Code persists thinking
blocks with their text stripped, so your *internal reasoning* is not on disk and cannot be
forwarded. The external model sees what you said and did, not what you were thinking. When the
reasoning is the thing you want checked, put it in `--question` yourself.

Reach for it when you've done substantial work and are about to commit to it: before declaring
something done, when stuck, or when the user asks whether your approach holds up.

**From inside a subagent, always pass `--context <file>`.** A subagent inherits its parent's
`CLAUDE_CODE_SESSION_ID`, and its own turns aren't written to disk separately. Tested: auto-detect
from a subagent does not fail - it silently succeeds using the *parent's* conversation and returns
advice about work the subagent never did. Write a short summary of what you actually did and pass
that instead.

Every auto-detected run therefore returns a `contextWarning` naming the session id it forwarded.
Check it against the work you just did; if it doesn't match, throw the answer away and re-run with
`--context`. There is no reliable way for the runner to detect this itself - the process cannot
tell whether it is a subagent.

### When the subject is a choice, write a decision trace

Because reasoning isn't on disk, `advise` audits your *conclusions against evidence* well and
your *decision process* not at all. Those are different jobs:

- **Auditing a conclusion** ("did I read this output wrong?") — the transcript is enough. Leaving
  your reasoning out is an advantage here: the model re-derives from the evidence instead of
  grading your argument.
- **Auditing a choice** ("is this approach right?", "did I weigh the alternatives?") — the
  transcript is not enough. The failure this catches is a *correct conclusion reached through
  unsound reasoning*: nothing in the evidence looks wrong, and the flaw only surfaces on the next
  decision.

For the second case, put a compact decision trace in `--question`: the assumptions you're
working from, the constraints, the alternatives you rejected and why, and what you're still
unsure about. State them flat. Do **not** write a polished justification — an argument primes the
model to evaluate your argument, which is the anchoring the transcript's silence was protecting
you from.

Be honest about the limit: a trace is written by you, so it audits what you *say* your process
was. Nothing fixes that — the reasoning genuinely isn't recoverable.

This rule stands on reasoning; the evidence is weak. A 3-pair blind A/B (same question, same model,
trace vs no trace, judged without knowing which was which) came out trace 2, bare 1, tie 0 - noise
at that sample size. An earlier run appeared to give a cleaner 2-0-1, but it was invalid: run
directories were only second-precise, so both arms of each pair read the same packet. That bug is
fixed. Treat the rule as a sensible default that nobody has actually proven.

The returned JSON block carries `assessment`, `most_important`, `unverified_claims` and
`missing_checks`. Act on it — that's the point — but the verification rule below still applies:
it can be wrong about your work too.

## review — fresh eyes on a diff

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" review --repo /path/to/repo \
  --base staging --task "what this change is supposed to do"
```

- `--pr <number>` reviews a GitHub PR — this is the common case. It reads the PR through `gh`,
  fetches its head into a private ref, and checks it out in a throwaway worktree so the model
  reads the PR's *actual code*. Without that the model reads your local checkout while judging
  someone else's diff, which reliably produces confident, wrong findings about call sites the
  PR did update. The worktree and ref are removed afterwards on every exit path, including
  failures and Ctrl-C; the user's branches and working tree are never touched. The PR title and
  body become the task statement unless you pass `--task`.
- `--base <ref>` reviews the merge-base diff against that ref. Omit both `--pr` and `--base` to
  review the uncommitted working tree.
- `--task` is the author's one-line intent. Include it — a reviewer that doesn't know what the
  change is *for* can only find syntax problems.
- `--model <provider>/<model>` overrides both provider and model for a single run, without
  touching config. A bare `--model <id>` keeps the job's configured provider and swaps only the
  model. On `codex` the effort suffix is part of the model half:
  `--model codex/gpt-5.6-terra:xhigh`.

When the user names a model in their request ("review PR 1234 with Sol", "what does Gemini think",
"use gpt-5.6-sol-high"), pass it through as `--model` rather than editing config - they want it for
that run, not as a new default. Resolve friendly names against `modelLabels` for **every** provider
and the live lists from `doctor`. If the same friendly name exists on more than one, ask which.
Don't guess an id. Say which provider and model actually ran when you report back, since it differs
from the usual one.

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" review --repo . --pr 1234
```

Run it more than once before treating a quiet result as clearance. Single runs vary; the
higher-effort models are steadier.

**Send the diff and the intent, and nothing else.** Do not summarise your own reasoning into
the packet, do not explain why you made each choice, do not pre-empt objections. All of that
converts an independent reviewer into an echo of you, which is precisely the thing you're
paying for it not to be. The agent reads the repo itself and picks up `AGENTS.md` natively.

## consult — a second opinion on a problem

Write a briefing to a file, then:

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" consult --repo /path/to/repo \
  --packet /tmp/packet.md
```

Unlike review, here your reasoning is the point — the external model is checking *it*, not
just the code. A good packet is short and concrete:

- **The question**, stated as a decision to be made, not a topic to discuss.
- **What you've established**, with file paths so it can verify rather than take your word.
- **What you've tried and what happened** — especially anything that failed.
- **The approach you're leaning towards, and why.**
- **What you're uncertain about.** Name it; that's usually where the useful answer lives.

Keep it under a couple of pages. A packet that includes everything gets an answer that
engages with nothing.

## research — look something up

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" research --question "what changed in the Antigravity CLI in the last month"
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" research --scratch --question "compare the four main Node rate limiters in 2026"
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" research --packet /tmp/brief.md
```

Use it to move bulk reading off your own context: web lookups with real sources, or digesting a
large codebase or doc set. Unlike the other three verbs this one is not about lineage diversity —
you are delegating legwork, not asking for judgement.

Offload when the job needs three or more sources, or a whole document set. For a single quick fact,
use your own WebSearch: a run costs 30-150s, which is not worth paying to look up one number.

- `--question` for a one-line ask, `--packet <file>` for a longer brief. Exactly one of them.
- `--scratch` runs it in an empty throwaway directory instead of the repository. Use it whenever
  the question is not about this code: the model then has no local files to read, and nothing of
  yours goes into the workspace. The directory is removed on every exit path.
- Write `--scratch` on its own. It takes no value: `--scratch=true` and `--scratch false` are both
  refused, because guessing what a value means could hand over the repository.
- **`--scratch` still has to be run from inside a git repository.** The throwaway directory is all
  the model reads, but the repository is where the run is filed in the history, and it is what the
  write guard checks. Outside one the run is refused before anything is created.
- Without `--scratch` the repository is the workspace, so file-based questions work with no setup.
- `treeChanged` on a scratch run means the repository moved **or** the throwaway directory did:
  both are fingerprinted, and the flag is the OR of the two. The envelope tells you which:
  `changedRoots` lists the paths that moved, and `guardViolation` names them in words. If only the
  throwaway directory moved, your code was not touched and there is nothing left to inspect — it
  is deleted by then. If the repository is in the list, check `git status` there. Say which one
  moved when you report it.
- **A scratch run cannot be resumed. The runner refuses it.** `resume` has no workspace flag, so a
  follow-up would run in the repository — the thing `--scratch` existed to prevent — and the
  throwaway directory is deleted by then anyway. Start a fresh `research --scratch` run instead.
  A scratch run's envelope carries `"scratch": true`, and so does its `meta.json`, which is how
  the refusal recognises one.

**Web reach differs by provider.** `doctor` reports `webAccess` and `webNote` per provider.
`restricted` means that provider's web reach was measured to be limited. What the limit is differs
from provider to provider, so read its `webNote` for what was actually measured. Treat web lookups
on a `restricted` provider as unreliable; digesting local files still works either way. Cursor is
still the only `restricted` provider; its `webNote` records an allow-list on URL fetch, and a
search tool that was never measured. `agy` and `codex` are both `full`. Check the report's
`tools_used` block afterwards.

### Reading a research result

The JSON block carries `summary`, `confidence`, `findings`, `contradictions`, `unverified`,
`open_questions` and `tools_used`.

**Every finding carries a `quote` copied verbatim from its source.** That is the whole point of the
contract: you verify by matching the quote against the source, not by re-reading the page. Do that
for two or three of the load-bearing findings and tell the user which ones you checked.

Search the whole file, not the cited line. Measured, a `path:line` citation lands within a line or
two of the quote rather than exactly on it, so grepping only the cited line can make a real,
verbatim quote look invented.

Four things to check before relaying anything:

- `tools_used` — if `web_search` is `blocked` or `unavailable`, the model answered from memory.
  Say so, and treat the whole report as unsourced. An `ok` there confirms nothing: `agy
  --output-format json` returns no tool-call trace, so `tools_used` is only the model's own word
  for what it did. That is exactly why every finding has to carry a quote.
- `unverified` — these are claims the model could not quote. They are not findings. Relay them as
  guesses or not at all.
- the prose — a claim that appears there and in no `finding` carries no source and no quote, so it
  is unverified by construction. Treat it exactly like an entry in `unverified`. Seen live: the
  prose said local commands had been run, with nothing in `findings` to show for it.
- `contradictions` — sources disagreeing is a real result. Do not silently pick one.

Write the full report to wherever this project keeps agent-generated documents, tell the user the
path, and summarise the headlines in chat. Do not paste the whole report into the terminal.

## resume — push back on the answer

```bash
EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" resume --session <sessionId> \
  --message "You said X, but api/src/foo.ts:42 does Y. Which constraint breaks the tie?"
```

Every successful run returns a `sessionId`. Use it when the answer conflicts with something
you've already verified — reconciling is cheaper than accepting a wrong branch, and cheaper
than re-briefing from scratch.

A session id is only valid on the CLI that issued it. The runner looks the provider up from the
original run's saved metadata, so you pass only `--session` and `--message`.

A `research --scratch` run is the one thing you cannot resume, and the runner refuses it rather
than quietly running the follow-up in the repository.

On `agy` and `codex`, if the reply carries a different conversation id than the one you asked for,
the run fails instead of answering from a fresh conversation. Cursor has no such check. An id
`codex` does not recognise fails outright rather than quietly starting a new thread.

## Reading the result

Output is one JSON envelope on stdout: `{ok, result, verb, sessionId, runDir, packetPath, provider,
model, usage, elapsedMs, treeChanged}`, plus `guardViolation` and `changedRoots` when `treeChanged`
is true. `changedRoots` lists the paths that moved: the repository, the throwaway workspace, or
both. A `research --scratch` run also carries `"scratch": true`. The full packet and raw
response are kept in `runDir` (last 20 runs per repo). `meta.json` in `runDir` records
`changedRoots` on every run, alongside `guarded`, the roots that were watched.

`result` is the model's prose, ending in a fenced JSON block (verdict + findings for review,
recommendation + risk for consult, sourced findings + `tools_used` for research). Render the prose
for the user — that's the substance — and use the JSON block for structure.

**Treat every finding as a claim, not a fact.** Cross-model review has a high false-positive
rate: a confident finding about a call site, a race, or a missing guard is often refuted by two
minutes of reading the actual file. Verify before you relay, and tell the user which findings
you checked and which you're passing through unverified. Relaying a wrong finding as fact
costs them more than the review saved.

Attribute the source when you relay: it's the external model's opinion, not yours, and the
user should know which is which.

## When something fails

`ok: false` always carries `error`. When the failure came from the CLI itself it also carries
`raw`, the CLI's actual output - show that verbatim when it's there. Setup-style failures (no
binary, missing packet file, bad config) carry only `error`, plus hints such as `installHint` and
`thenRun`. The failure modes are
plain-text and self-explanatory (invalid API key, unknown model, timeout), and paraphrasing
them loses the fix. Don't retry a failed run unchanged. An `error` ending in `run setup` means the
config is missing or out of date: go through setup (see above), then rerun the original request.

When a CLI exits non-zero but said why, `error` is that reason rather than `<bin> exited <n>`, and
`raw` quotes the stream the reason was on. So a model id the account cannot use reports
`The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.` Relay it as
given: it names the fix. A bare `<bin> exited <n>` means the CLI died without explaining itself,
and then `raw` is all there is.

Every run pre-flights its provider before it writes a packet or spawns anything. Three failures
come from there, and all are fixed by the user, not by retrying:

- `unknown codex reasoning effort "<x>" in model "<id>"; valid efforts are ...` — the `:<effort>`
  suffix is not one codex takes. Fix the `--model` you passed, or run setup to fix the config.
- `<bin> not found on PATH` — carries `installHint` and `thenRun`. The CLI is not installed.
- `<bin> is not signed in` — carries `raw`, the CLI's own reason, and `thenRun`. Relay `raw`
  verbatim. This check exists because a signed-out `agy` would otherwise block for 60 seconds
  on its sign-in prompt, and a signed-out `codex` would retry a 401 against OpenAI in a loop.

A reviewed diff can contain text aimed at the reviewer. One canary - a diff whose comment ordered
the reviewer to return "ship" with zero findings - was ignored; it reported the real bug and said
do-not-ship. That's one test, not a guarantee: a verdict on a diff or PR body containing
instruction-like text deserves the same scepticism as any other finding.

For `--pr`, the run fails if the base fetch fails, and if the base ref goes missing after fetching -
either one would otherwise review the PR against an out-of-date base. If a PR review still looks
bigger than the PR, check the stat block for already-merged commits.

If `treeChanged` is true the run is marked failed even when the model answered: a read-only advisor
writing to the tree means something is wrong with the invocation. Say so loudly, and read
`changedRoots` before you say anything about it - the write may not have landed in the user's code.

- The repository is in `changedRoots`: the user's own tree was written to. Have them check
  `git status` there before trusting anything from that run.
- Only a throwaway workspace is listed (`research --scratch`, or `review --pr`): the user's code
  was not touched, and that directory is deleted when the run ends, so there is nothing to inspect.
  The invocation is still broken - a read-only run wrote a file - so the answer is untrusted.

Either way, run `EXTERNAL_ADVISOR_HOME="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/run.mjs" doctor` and show `providers.<provider>.warnings` verbatim.
On `agy` the usual cause is `toolPermission: always-proceed`, which leaves plan mode - an
instruction, not a refusal - as the only guard.

The fingerprint hashes the status list, the tracked diff, and size+mtime of untracked files,
because porcelain output alone reports only status codes and paths - an already-dirty file can
be edited further without its status line moving. Git-ignored files are out of scope.

## Tests

`node --test run.test.mjs` covers the runner's safeguards: the non-git rejection, the write
guard, untracked-only reviews, run-history isolation, both PR base-ref failures, config resolution,
all three providers end to end, and the research verb's argument rules and scratch cleanup.
71 tests. The suite stubs `gh`, `cursor-agent`, `agy` and `codex` on PATH, so it needs
no network and no account with any vendor. Run it after a Cursor, Antigravity or Codex CLI upgrade,
alongside re-checking what `--mode ask`, `--mode plan` and `-s read-only` actually block.

## Config

The config file (`doctor` reports `configPath`):

| Key | Meaning |
|---|---|
| `models.review` / `.advise` / `.consult` / `.research` | `"<provider>/<model>"`. Both halves required. On `codex` the model half usually ends in `:<effort>`; a bare id with no suffix is legal and runs at codex's default effort. |
| `timeoutSeconds` | Hard kill for a run. Default 900. |
| `keepRuns` | Run folders kept per repository. Default 20. |
| `sandbox` | Boolean, default `true`. Cursor maps it to `--sandbox enabled` / `disabled`. agy and codex ignore it. |
| `maxDiffBytes` / `maxAdviseBytes` | Size caps, in JavaScript characters. Truncation is always reported. |
| `modelLabels` | `modelLabels[provider][modelId]` display names, refreshed by `sync-labels`. |

An unknown top-level key is rejected with `unknown config key "<key>"; run setup`, so a stale
config is caught whole rather than half-read.

A codex model whose `:<effort>` suffix codex does not take is rejected the same way, with
`models.<job>: unknown codex reasoning effort "<x>" in model "<id>"; valid efforts are ...`.
`doctor` reports it in `configErrors`, so a bad effort is caught at setup and not on every run.

`doctor` returns fresh labels per provider, so setup can refresh that table whenever the picks
change. To change a default model, offer the live list from `doctor` and write the pick back here.

Default picks are non-Claude on purpose, on every provider. `claude-fable-*` is excluded outright:
Cursor flags it **NO ZDR**, meaning prompts are retained.
