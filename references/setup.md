# setup — first run, and changing models

The procedure `SKILL.md` sends you here for. Follow it in order; don't improvise from memory.

Commands below need two real paths filled in:

`EXTERNAL_ADVISOR_HOME="<state dir>" node "<plugin dir>/run.mjs" <verb>`

**Take both from `SKILL.md`'s "Where the runner lives" section, which you have already read.**
They are not filled in here. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` and
`${CLAUDE_PLUGIN_DATA}` into skill text, but this file reaches you through the Read tool, which
returns it byte for byte — measured, not assumed. A placeholder written here would arrive
literally and expand to an empty string.

Keep the double quotes: either path can contain a space.

Run this before the first use, and whenever the user wants a different model:

```bash
EXTERNAL_ADVISOR_HOME="<state dir>" node "<plugin dir>/run.mjs" doctor
```

It returns JSON with `stateRoot`, `configPath`, `configExists`, `config`, `configErrors`, and a
`providers` map. Every provider entry has `bin`, `authenticated`, `readOnly`, `readOnlyStrength`,
`webAccess`, `webNote`, `modelCount`, `models`, `modelLabels` and `warnings`. Drive the rest
interactively rather than making the user edit JSON:

1. **Read `configErrors` first.** A non-empty list means the config on disk is stale or wrong.
   Each string says what to fix. Rewrite the config from the picks below rather than patching it.
2. **Binary missing** — the provider entry carries `installHint`. Cursor's hint is a single curl
   command, so offer to run it. Codex's hint holds two commands: a `brew` one, and an `npm`
   alternative in brackets — offer the first only, since the whole string fails as a command.
   Antigravity's hint is a docs page, not a command at all, so the user installs it themselves.
3. **Not authenticated** — the entry carries `thenRun`. Every login opens a browser, so they have
   to be the user's to run. Tell them to type `! cursor-agent login`, `! agy`, or `! codex login`
   in the session. The `!` prefix runs a shell command there.
4. **Show every `warnings` string verbatim.** Do not paraphrase. `agy` warns when its global
   `toolPermission` setting is `always-proceed`, which means it auto-approves tool calls in
   headless runs, leaving plan mode as the only guard.
   When the setting cannot be read at all the warning is
   `could not read agy toolPermission; check ~/.gemini/antigravity-cli/settings.json`.
   Treat that as unknown, not as safe.
5. **Pick a provider and a model, per job.** Ask through the question UI: `review`, then `advise`,
   then `consult`, then `research`.
   - **Look for picks from the old skill install first.** Before this plugin, the tool was a skill
     that kept `config.json` next to its own files, where this plugin never reads it. Look for one
     in `~/.claude/skills/external-advisor/`, and in `.agents/skills/external-advisor/` or
     `.claude/skills/external-advisor/` under the repository root (in a git worktree, check the
     main checkout's copies too). The old shape has a top-level `provider` key and bare model ids.
     Convert it:
     - each `models.<job>` with no `/` becomes `"<provider>/<id>"`, taking the old `provider`
       value, or `cursor` when the file has none;
     - `sandbox: "enabled"` becomes `true` and `"disabled"` becomes `false`; a boolean stays;
     - `timeoutSeconds`, `keepRuns`, `maxDiffBytes` and `maxAdviseBytes` copy over unchanged;
     - `provider`, `modelLabels` and any other key are dropped. Step 7's `sync-labels` rebuilds
       the labels.

     Keep a converted pick only when its provider is installed and signed in, and the model is
     still in that provider's live `models` list from `doctor`. Offer the kept picks in one
     question, as the recommended option, naming each one. Ask the jobs that are left the usual
     way below: `research` always, since the old skill had no such job, plus any job whose pick
     was not kept or that the user wants to change. If two old configs disagree, show both and
     let the user choose.
   - If more than one provider is installed and authenticated, ask **which provider first**, then
     the model. If only one is, go straight to the model.
   - 200+ model ids is not a menu. Offer 3-4 curated options per job.
   - **Recommend the newest model at its highest effort tier.** Newest means the highest
     version number in the live list. Ignore tier names: a 3.8 Flash beats a 3.1 Pro, and Sol
     5.6 beats Codex 5.3. A name like "Pro" or "Codex" says nothing about quality.
   - **On `codex` the offered ids usually end in `:<effort>`**, like `gpt-5.6-terra:xhigh`. That
     suffix is the reasoning effort, and `doctor` lists one entry per model-and-effort pair. A
     model that offers no efforts is listed bare, with no suffix; that id is fine as-is and runs
     at codex's default effort. The rule above then means picking the highest effort the live list
     shows for that model. The tiers are not the same on every model: as of 2026-09-06
     `gpt-5.6-terra` listed an `ultra` tier the others did not. Read the live list, not this
     sentence.
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
   - For `research`, show the provider's `webAccess` and `webNote` from `doctor` in the option
     text. `restricted` means that provider's web reach was measured to be limited, so treat web
     lookups there as unreliable; the limit differs per provider, and its `webNote` is the record
     of what was measured. Any provider can still digest a codebase. Nobody can guess that from a
     model id.
   - The lineage rule does not apply to `research`: it is not a judgement of Claude's work, so
     `claude-*` models are a legitimate pick there. `claude-fable-*` stays excluded on every job,
     because that exclusion is about prompt retention, not lineage.
   - Say once, in plain words, how the three read-only guards differ: **codex is the strongest —
     two write routes were tried and each was blocked, the patch tool by the CLI and a shell write
     by the operating-system sandbox; Cursor refuses a write at the tool level; agy is only told
     not to write, and the fingerprint guard catches it if it does.**
6. **Tell them what `advise` sends**, before their first use. This is not optional for someone who
   didn't build the tool. `advise` auto-forwards a distilled copy of the whole session - including
   tool output that happened to pass through it, such as ticket contents, log queries or internal
   search results - to the model vendor behind the provider you picked. On `cursor` that is
   Cursor's model providers. On `agy` that is Google, and agy also keeps a full copy of every
   conversation under `~/.gemini/antigravity-cli/`, outside this plugin's control. On `codex` that
   is OpenAI, and codex likewise keeps a full copy of every session under `~/.codex/sessions/`.
   The runner also passes `--ignore-user-config` there, so the user's own codex MCP servers do not
   spawn during a run; that is not a full seal, because global skills under `~/.agents` and
   `~/.codex/plugins` are still read.
   A copy is kept under the plugin's own `runs/` directory too. It triggers on phrases as ordinary
   as "am I missing something". Say it plainly once. `review`, `consult` and `research` forward no
   transcript, only the packet, so those are the modes for when session contents matter - but note
   every mode gives the model the repository as its workspace by default, so it reads repository
   files in all of them. `research --scratch` is the one exception, and so the most private of the
   four: it hands over an empty throwaway directory instead of the repository. Not nothing, though:
   the model is still handed the run directory, whose path sits under the plugin's state
   directory, inside the user's home, so it carries their username as well as the repository's
   name - and on `agy` and `codex` the workspace is only the process working directory, so nothing
   stops a read outside it.
7. Write their picks into the config (`doctor` reports its exact path as `configPath`) as
   `"models": {"review": "<provider>/<model>", ...}`, then run
   `EXTERNAL_ADVISOR_HOME="<state dir>" node "<plugin dir>/run.mjs" sync-labels`,
   then one small `review --base HEAD~1` so they see it working
   (a bare `review` on a clean tree has no diff and errors out).
   If step 5 found an old config, offer to delete the old `config.json` and `runs/` now that the
   new config is written, and ask before deleting anything. If that folder still holds a
   `SKILL.md`, the old skill is still installed there. A same-named skill under `~/.claude/skills/`
   stops this plugin's skill from loading, so recommend removing it. Inside a repository that is a
   change to tracked files, so tell the user rather than deleting it.
