# external-advisor

A Claude Code plugin that gets a second opinion from a non-Claude model, such as GPT, Gemini, Grok or Composer.
It works through the [Cursor](https://cursor.com/docs/cli/overview), [Antigravity](https://antigravity.google/docs/cli) or [Codex](https://github.com/openai/codex) CLI.

**Why:** Claude reviewing Claude's work shares Claude's blind spots.
A different model never saw Claude's reasoning, so it has no reason to be convinced by it.

<!-- demo video: URL goes here -->

## What it does

Four modes. Claude picks one from how you ask.

| Mode | What you get | What the other model sees |
|---|---|---|
| `advise` | A critique of the work Claude just did | Your current session |
| `review` | A fresh-eyes review of a diff, branch or GitHub PR | The diff and the repo, not your chat |
| `consult` | An answer to a question | Your question, plus the repo |
| `research` | Findings with sources and exact quotes | The web, or files in the repo |

Each mode can use its own provider and model.

## Install

You need:

- [Claude Code](https://claude.com/claude-code)
- Node, any recent version
- One provider CLI, signed in:
  - [Cursor CLI](https://cursor.com/docs/cli/overview), with a Cursor subscription
  - [Antigravity CLI](https://antigravity.google/docs/cli) (`agy`), with a Google sign-in
  - [Codex CLI](https://github.com/openai/codex) (`codex`), with an OpenAI or ChatGPT sign-in
- `gh` (the GitHub CLI), only for reviewing PRs

Then:

1. Add the plugin. In Claude Code, run:

   ```
   /plugin marketplace add alphainfinitus/claude-code-external-advisor
   /plugin install external-advisor@alphainfinitus
   ```

2. Install a provider CLI and sign in. One is enough.

   ```bash
   # Cursor
   curl https://cursor.com/install -fsS | bash
   cursor-agent login

   # Antigravity: install from https://antigravity.google/docs/cli, then run this to sign in
   agy

   # Codex
   brew install codex          # or: npm install -g @openai/codex
   codex login
   ```

3. In Claude Code, say:

   ```
   set up the external advisor
   ```

   It checks your install, asks you to pick a model for each mode, and saves your choices.

## Use it

Ask in plain words. Claude picks the mode.

```
review PR 1234 with the external advisor
sanity-check my approach, use external-advisor
what would GPT say about this design?
review this diff using grok
research what changed in the Antigravity CLI this month
```

- Name a model in your request to use it for that one run.
- Say `change the external advisor models` to change the defaults.

## Limits

- The other model runs in its CLI's read-only mode. That is the vendor's own guard, not a security boundary.
- The plugin checks your repo before and after each run. If any file changed, the run fails, even if you made the change.
- Runs take 30 to 150 seconds.
- Usage bills your own Cursor, Google or OpenAI account.

## License

MIT.
