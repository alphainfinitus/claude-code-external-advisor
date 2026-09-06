# setup — first run, and changing models

The procedure `SKILL.md` sends you here for. Follow it in order; don't improvise from memory.

`$SKILL` below means this skill's base directory, the one holding `run.mjs` — the same
convention `SKILL.md` uses. It is reported to you when the skill loads. Never hardcode a path.

Run this before the first use, and whenever the user wants a different model:

```bash
node $SKILL/run.mjs doctor
```

It returns JSON with `stateRoot`, `configPath`, `configExists`, `config`, `configErrors`, and a
`providers` map. Every provider entry has `bin`, `authenticated`, `readOnly`, `readOnlyStrength`,
`webAccess`, `webNote`, `modelCount`, `models`, `modelLabels` and `warnings`. Drive the rest
interactively rather than making the user edit JSON:

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
   then `consult`, then `research`.
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
   - For `research`, show the provider's `webAccess` and `webNote` from `doctor` in the option
     text. `restricted` means that provider's web reach was measured to be limited, so treat web
     lookups there as unreliable; the limit differs per provider, and its `webNote` is the record
     of what was measured. Any provider can still digest a codebase. Nobody can guess that from a
     model id.
   - The lineage rule does not apply to `research`: it is not a judgement of Claude's work, so
     `claude-*` models are a legitimate pick there. `claude-fable-*` stays excluded on every job,
     because that exclusion is about prompt retention, not lineage.
   - Say once, in plain words, how the two read-only guards differ: **Cursor refuses writes at the
     tool level; agy is only told not to write, and the fingerprint guard catches it if it does.**
6. **Tell them what `advise` sends**, before their first use. This is not optional for someone who
   didn't build the tool. `advise` auto-forwards a distilled copy of the whole session - including
   tool output that happened to pass through it, such as ticket contents, log queries or internal
   search results - to the model vendor behind the provider you picked. On `cursor` that is
   Cursor's model providers. On `agy` that is Google, and agy also keeps a full copy of every
   conversation under `~/.gemini/antigravity-cli/`, outside this skill's control. A copy is kept
   under the skill's own `runs/` directory too. It triggers on phrases as ordinary as "am I
   missing something". Say it plainly once. `review`, `consult` and `research` forward no
   transcript, only the packet, so those are the modes for when session contents matter - but note
   every mode gives the model the repository as its workspace by default, so it reads repository
   files in all of them. `research --scratch` is the one exception, and so the most private of the
   four: it hands over an empty throwaway directory instead of the repository. Not nothing, though:
   the model is still handed the run directory, whose path sits under the skill's state directory -
   by default inside the user's home, so it carries their username as well as the repository's
   name - and on `agy` the workspace is only the process working directory, so nothing stops a read
   outside it.
7. Write their picks into the config (`doctor` reports its exact path as `configPath`) as
   `"models": {"review": "<provider>/<model>", ...}`, then run
   `node $SKILL/run.mjs sync-labels`, then one small `review --base HEAD~1` so they see it working
   (a bare `review` on a clean tree has no diff and errors out).
