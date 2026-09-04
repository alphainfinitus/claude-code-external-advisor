---
name: external-advisor
description: Get a second opinion from a different AI model (GPT-5.x, Grok, Gemini, Composer) through the Cursor CLI or the Google Antigravity CLI, without leaving Claude Code. Use whenever the user asks for an external review, a second opinion, a sanity check from another model, "what would GPT/Gemini/Codex/Cursor say", "am I missing something", "check my approach", wants a PR or diff or design judged by something that isn't Claude, or is stuck on a decision where independent judgement helps - and whenever they name it directly ("use the external-advisor", "/external-advisor"). Three modes - advise (an external model critiques the work THIS agent just did, like the built-in advisor), review (fresh-eyes review of a diff or PR), consult (opinion on a question). Read this before running cursor-agent or agy by hand.
---

# External advisor

Runs a **different model** over your work and brings its answer back here. The point is lineage
diversity: Claude reviewing Claude's code shares Claude's blind spots, and a model that never saw
the reasoning has no reason to find it convincing.

Two provider CLIs are supported. Each job picks one, in config.

| Provider | CLI | Needs | Read-only flag | How strong that guard is |
|---|---|---|---|---|
| `cursor` | `cursor-agent` | a Cursor account | `--mode ask` | **dispatch** - the CLI refuses write and shell tool calls |
| `agy` | `agy` (Google Antigravity) | a Google sign-in | `--mode plan` | **prompt** - the model is *told* not to write; nothing refuses it |

Only one of the two has to be installed. Whatever is missing simply cannot be picked.

"Dispatch" means the tool call is rejected by the CLI itself. "Prompt" means it is only an
instruction to the model. Neither is a security boundary.

On agy, plan mode leaves the full tool list in place: file write, shell, subagents, web search,
browser control and MCP tools all stay listed (measured on agy 1.1.26). Only the instruction and
the fingerprint guard stand between the model and a write. Both providers can spawn their own
subagents; on agy, whether a subagent inherits plan mode was not measured.

Two further layers back them up:

- `sandbox` in config, which maps to Cursor's `--sandbox`. agy ignores it.
- A content fingerprint of the working tree taken before and after every run. If anything moved,
  the run is marked failed even when the model answered.

Re-check what each read-only mode blocks after a CLI upgrade.

## setup — first run, and changing models

Run this before the first use, and whenever the user wants a different model:

```bash
node $SKILL/run.mjs doctor
```

It returns JSON with `stateRoot`, `configPath`, `configExists`, `config`, `configErrors`, and a
`providers` map. Every provider entry has `bin`, `authenticated`, `readOnly`, `readOnlyStrength`,
`modelCount`, `models`, `modelLabels` and `warnings`. Drive the rest interactively rather than
making the user edit JSON:

1. **Read `configErrors` first.** A non-empty list means the config on disk is stale or wrong.
   Each string says what to fix. Rewrite the config from the picks below rather than patching it.
2. **Binary missing** — the provider entry carries `installHint`. Cursor's is a plain curl, so
   offer to run it. Antigravity's is a docs page, so the user installs it themselves.
3. **Not authenticated** — the entry carries `thenRun`. Both logins open a browser, so they have
   to be the user's to run. Tell them to type `! cursor-agent login`, or `! agy`, in the session.
   The `!` prefix runs a shell command there.
4. **Show every `warnings` string verbatim.** Do not paraphrase. `agy` warns when its global
   `toolPermission` setting is `always-proceed`, which means it auto-approves tool calls in
   headless runs, leaving plan mode as the only guard.
   When the setting cannot be read at all the warning is
   `could not read agy toolPermission; check ~/.gemini/antigravity-cli/settings.json`.
   Treat that as unknown, not as safe.
5. **Pick a provider and a model, per job.** Ask through the question UI: `review`, then `advise`,
   then `consult`.
   - If two providers are installed and authenticated, ask **which provider first**, then the
     model. If only one is, go straight to the model.
   - 200+ model ids is not a menu. Offer 3-4 curated options per job.
   - **Recommend the newest model at its highest effort tier.** Newest means the highest
     version number in the live list. Ignore tier names: a 3.8 Flash beats a 3.1 Pro, and Sol
     5.6 beats Codex 5.3. A name like "Pro" or "Codex" says nothing about quality.
   - **Sort the options newest first.** After the recommended one, offer one cheaper or faster
     option and one from a different lineage.
   - **The question text explains what that job does**, in plain words. Most people do not
     remember the difference between advise and consult.
   - **Every option names its provider and says why you would pick it**: how new it is, lineage
     (is it unlike Claude?), speed, context size, track record on this repo. "agy /
     gemini-3.8-flash-high — newest Gemini, large context, different lineage from Claude" beats
     a bare model id every time.
   - Offer "same as advise" as a `consult` option; they are usually the same job. Mark the
     current value so a no-op answer is easy.
   - Say once, in plain words, how the two read-only guards differ: **Cursor refuses writes at the
     tool level; agy is only told not to write, and the fingerprint guard catches it if it does.**
6. **Tell them what `advise` sends**, before their first use. This is not optional for someone who
   didn't build the tool. `advise` auto-forwards a distilled copy of the whole session - including
   tool output that happened to pass through it, such as ticket contents, log queries or internal
   search results - to the model vendor behind the provider you picked. On `cursor` that is
   Cursor's model providers. On `agy` that is Google, and agy also keeps a full copy of every
   conversation under `~/.gemini/antigravity-cli/`, outside this skill's control. A copy is kept
   under the skill's own `runs/` directory too. It triggers on phrases as ordinary as "am I
   missing something". Say it plainly once. `review` and `consult` forward no transcript, only the
   packet, so those are the modes for when session contents matter - but note all three modes give
   the model the repository as its workspace, so it reads repository files in every mode.
7. Write their picks into the config (`doctor` reports its exact path as `configPath`) as
   `"models": {"review": "<provider>/<model>", ...}`, then run
   `node $SKILL/run.mjs sync-labels`, then one small `review --base HEAD~1` so they see it working
   (a bare `review` on a clean tree has no diff and errors out).

Never guess at model IDs — they rot fast, and `doctor` is the live list per provider. Steer away
from `claude-*` for `review` and `consult` on **either** provider: a Claude reviewing Claude's work
defeats the purpose. agy's catalogue includes `claude-sonnet-4-6` and `claude-opus-4-6-thinking`,
so the rule applies there too. Never offer `claude-fable-*`, which Cursor flags **NO ZDR**, meaning
prompts are retained. That NO ZDR note is Cursor-specific.

## Where the runner lives

`run.mjs` sits next to this file. Commands below write it as `$SKILL/run.mjs` — substitute the
skill's base directory, which is reported to you when this skill loads. Don't hardcode a path:
this skill works from `~/.claude/skills/` and from a repo's `.agents/skills/` unchanged, and a
hardcoded home path breaks the moment it's shared into a repo.

Per-user state lives **inside the skill directory**, next to `run.mjs`: `config.json` and `runs/`.
Each installation carries its own, so a personal copy under `~/.claude/skills/` and a repo copy
under `.agents/skills/` keep separate configs and histories. `EXTERNAL_ADVISOR_HOME` overrides the
location, and `doctor` reports it as `stateRoot`.

**A repo copy must gitignore that state** while keeping the skill's own files tracked:

```gitignore
<path-to-skill>/config.json
<path-to-skill>/runs/
```

Being ignored is also what keeps run artifacts out of `git status --exclude-standard`, so they
cannot trip the write guard.

Transient PR worktrees go to the system temp directory rather than the repo: a full checkout inside
the working tree is still picked up by file watchers, linters and test globs even when gitignored.

## How this shows up in the user's terminal

The user sees the `description` you set on the Bash call, so it is the only status line
available - set it on **every** external-advisor invocation, in exactly this shape:

```
<Verb> via External Advisor using <model label>
```

- `advise`  → `Advising via External Advisor using GPT-5.6 Sol 1M High`
- `review`  → `Reviewing via External Advisor using Codex 5.3 High`
- `consult` → `Consulting via External Advisor using GPT-5.6 Sol 1M High`
- `resume`  → `Following up via External Advisor using GPT-5.6 Sol 1M High`

Model labels live in `modelLabels` in the config, keyed by **provider first, then model id**. Read
`modelLabels[provider][model]` rather than inventing a name, and fall back to `provider/model` if
the label isn't there. Every run's JSON envelope carries `provider` and `model`, so you can look
the label up after the fact. If a model you're about to use has no label, run
`node $SKILL/run.mjs sync-labels` - it caches display names for every model that is configured or
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
node $SKILL/run.mjs advise \
  --question "what have I got wrong here?"
```

This is the built-in `advisor` shape, with a different model. It finds this session's transcript
by itself and distils it — human turns, your visible prose, and tool calls reduced to name plus
truncated argument and result — so you write no briefing at all. `--question` is optional;
without it you get a general assessment.

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
node $SKILL/run.mjs review --repo /path/to/repo \
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
  model.

When the user names a model in their request ("review PR 1234 with Sol", "what does Gemini think",
"use gpt-5.6-sol-high"), pass it through as `--model` rather than editing config - they want it for
that run, not as a new default. Resolve friendly names against `modelLabels` for **both** providers
and the live lists from `doctor`. If the same friendly name exists on both providers, ask which.
Don't guess an id. Say which provider and model actually ran when you report back, since it differs
from the usual one.

```bash
node $SKILL/run.mjs review --repo . --pr 1234
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
node $SKILL/run.mjs consult --repo /path/to/repo \
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

## resume — push back on the answer

```bash
node $SKILL/run.mjs resume --session <sessionId> \
  --message "You said X, but api/src/foo.ts:42 does Y. Which constraint breaks the tie?"
```

Every successful run returns a `sessionId`. Use it when the answer conflicts with something
you've already verified — reconciling is cheaper than accepting a wrong branch, and cheaper
than re-briefing from scratch.

A session id is only valid on the CLI that issued it. The runner looks the provider up from the
original run's saved metadata, so you pass only `--session` and `--message`.

On `agy`, if the reply carries a different conversation id than the one you asked for, the run
fails instead of answering from a fresh conversation. Cursor has no such check.

## Reading the result

Output is one JSON envelope on stdout: `{ok, result, sessionId, runDir, provider, model, usage,
treeChanged}`. The full packet and raw response are kept in `runDir` (last 20 runs per repo).

`result` is the model's prose, ending in a fenced JSON block (verdict + findings for review,
recommendation + risk for consult). Render the prose for the user — that's the substance — and
use the JSON block for structure.

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
them loses the fix. Don't retry a failed run unchanged.

Every run pre-flights its provider before it writes a packet or spawns anything. Two failures
come from there, and both are fixed by the user, not by retrying:

- `<bin> not found on PATH` — carries `installHint` and `thenRun`. The CLI is not installed.
- `<bin> is not signed in` — carries `raw`, the CLI's own reason, and `thenRun`. Relay `raw`
  verbatim. This check exists because a signed-out `agy` would otherwise block for 60 seconds
  on its sign-in prompt.

A reviewed diff can contain text aimed at the reviewer. One canary - a diff whose comment ordered
the reviewer to return "ship" with zero findings - was ignored; it reported the real bug and said
do-not-ship. That's one test, not a guarantee: a verdict on a diff or PR body containing
instruction-like text deserves the same scepticism as any other finding.

For `--pr`, the run fails if the base fetch fails, and if the base ref goes missing after fetching -
either one would otherwise review the PR against an out-of-date base. If a PR review still looks
bigger than the PR, check the stat block for already-merged commits.

If `treeChanged` is true the run is marked failed even when the model answered: a read-only advisor
writing to the tree means something is wrong with the invocation. Say so loudly and have the user
check `git status` before trusting anything from that run. Then run `node $SKILL/run.mjs doctor`
and show `providers.<provider>.warnings` verbatim. On `agy` the usual cause is
`toolPermission: always-proceed`, which leaves plan mode - an instruction, not a refusal - as the
only guard.

The fingerprint hashes the status list, the tracked diff, and size+mtime of untracked files,
because porcelain output alone reports only status codes and paths - an already-dirty file can
be edited further without its status line moving. Git-ignored files are out of scope.

## Tests

`node --test <skill>/run.test.mjs` covers the runner's safeguards: the non-git rejection, the write
guard, untracked-only reviews, run-history isolation, both PR base-ref failures, config resolution,
and both providers end to end. 27 tests. The suite stubs `gh`, `cursor-agent` and `agy` on PATH, so
it needs no network and no account with either vendor. Run it after a Cursor CLI or Antigravity CLI
upgrade, alongside re-checking what `--mode ask` and `--mode plan` actually block.

## Config

The config file (`doctor` reports `configPath`):

| Key | Meaning |
|---|---|
| `models.review` / `.advise` / `.consult` | `"<provider>/<model>"`. Both halves required. |
| `timeoutSeconds` | Hard kill for a run. Default 900. |
| `keepRuns` | Run folders kept per repository. Default 20. |
| `sandbox` | Boolean, default `true`. Cursor maps it to `--sandbox enabled` / `disabled`. agy ignores it. |
| `maxDiffBytes` / `maxAdviseBytes` | Size caps, in JavaScript characters. Truncation is always reported. |
| `modelLabels` | `modelLabels[provider][modelId]` display names, refreshed by `sync-labels`. |

There is no `provider` key. A config that still carries one is rejected with
`config contains "provider"; remove it and use "<provider>/<model>" in models`. Any other unknown
top-level key is rejected too, so a stale config is caught whole rather than half-read.

`doctor` returns fresh labels per provider, so setup can refresh that table whenever the picks
change. To change a default model, offer the live list from `doctor` and write the pick back here.

Default picks are non-Claude on purpose, on both providers. `claude-fable-*` is excluded outright:
Cursor flags it **NO ZDR**, meaning prompts are retained.
