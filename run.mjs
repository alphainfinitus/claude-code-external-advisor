#!/usr/bin/env node
/**
 * external-advisor runner.
 *
 * Invokes an external CLI coding agent in its read-only mode and returns a normalized JSON
 * envelope on stdout. Provider-specific argv lives in PROVIDERS so another
 * CLI (gemini, say) can be added without touching run/guard/persistence logic.
 *
 * Usage:
 *   node run.mjs review  [--repo P] [--pr N] [--base REF] [--task STR] [--model M] [--timeout S]
 *   node run.mjs consult  --packet FILE [--repo P] [--model M] [--timeout S]
 *   node run.mjs research --question STR | --packet FILE [--repo P] [--scratch] [--model M] [--timeout S]
 *   node run.mjs advise   [--question STR] [--context FILE] [--repo P] [--model M] [--timeout S]
 *   node run.mjs resume   --session ID --message STR [--repo P] [--model M]
 *   node run.mjs sync-labels
 *   node run.mjs doctor
 *   node run.mjs models  [--provider P]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

// State lives in the plugin's own data directory, handed to us as EXTERNAL_ADVISOR_HOME by
// SKILL.md and references/setup.md, which read it from ${CLAUDE_PLUGIN_DATA}. That directory sits
// outside any repository, so run artifacts never reach `git status --exclude-standard` and cannot
// trip our own write guard. CLAUDE_PLUGIN_DATA is NOT readable here - Claude Code substitutes it
// into skill text, it does not export it - so do not add an env fallback for it. Measured: a Bash
// subprocess sees it unset even when that plugin's own skill triggered the call.
let ROOT;
let RUNS;
let CONFIG_PATH;

function resolveRoots() {
  const given = process.env.EXTERNAL_ADVISOR_HOME;
  // Set but empty is a typo, not a request for the default. SKILL.md passes the data directory
  // through bash, and bash expands an unsubstituted ${CLAUDE_PLUGIN_DATA} to "". Falling back
  // then would write config.json and runs/ into the plugin's install directory, which is
  // version-scoped and replaced wholesale on the next update, so the model picks would vanish
  // with no sign that anything went wrong. Unset is a different case and still falls back: that
  // is what lets `node run.mjs` work from a checkout.
  if (given !== undefined && given.trim() === '') {
    fail(
      'EXTERNAL_ADVISOR_HOME is set but empty. Set it to the plugin data directory, or unset it to use the directory run.mjs lives in.',
    );
  }
  // A relative value resolves beneath the process working directory, so the same command run from
  // two places silently uses two different states and `doctor` reports a stateRoot that cannot be
  // resolved on its own. Calling resolve() here would keep that cwd-dependence and only hide it
  // behind an absolute-looking path, so an ambiguous value is refused instead.
  if (given !== undefined && !isAbsolute(given)) {
    fail(
      `EXTERNAL_ADVISOR_HOME must be an absolute path; got "${given}". A relative path would resolve against whatever directory you happen to run from.`,
    );
  }
  ROOT = given || SKILL_DIR;
  RUNS = join(ROOT, 'runs');
  CONFIG_PATH = join(ROOT, 'config.json');
  // Run directories are created with `recursive: true`, but `sync-labels` writes config.json with
  // a bare writeFileSync. On a plugin data directory that has never been written to, that is an
  // ENOENT before anything prints. Cheaper to guarantee the directory than to special-case it.
  // A failure here is swallowed on purpose: this runs before verb dispatch, so throwing took
  // doctor - the verb whose job is to explain a broken setup - down with the setup it was asked
  // about. The verbs that really need to write still fail, from the write itself.
  try {
    mkdirSync(ROOT, { recursive: true });
  } catch {
    // Reported later by whatever tries to write, with the path it was actually writing.
  }
}

const DEFAULT_CONFIG = {
  timeoutSeconds: 900,
  keepRuns: 20,
  sandbox: true,
  maxDiffBytes: 400000,
  maxAdviseBytes: 160000,
};

/**
 * The reasoning tiers codex offered on 2026-09-06, as a snapshot. `doctor` reads the live
 * catalogue, so if codex adds a tier, doctor will offer it and this will refuse it - loudly,
 * which is the safe direction. Extend this list when that happens.
 */
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * Splits a codex model id into `{id, effort, error}`. A codex model half may carry a trailing
 * `:<effort>`, e.g. gpt-5.6-terra:xhigh, because codex takes the reasoning level as a config
 * override rather than a flag. Split on the LAST colon so a slug containing one keeps it.
 *
 * An unrecognised suffix comes back as `error` rather than being sent: an unknown value does not
 * fail codex, it warns and answers on a fallback model, which reads as a confident answer from a
 * model nobody picked.
 *
 * One helper, two callers - codex's `validateModel` and its `buildArgs` - so the parsing rule
 * lives in one place. `validateModel` is what runs first; `buildArgs` is defence in depth.
 */
function splitCodexEffort(model) {
  const raw = model || '';
  const cut = raw.lastIndexOf(':');
  // `> 0`, not `>= 0`: an id that is nothing but a suffix (":xhigh") skips the split and reaches
  // codex whole as -m, which fails closed on an error item. `>= 0` would strip it to an empty id,
  // drop -m, and silently answer on codex's own default model.
  if (cut <= 0) return { id: raw, effort: '', error: null };
  const suffix = raw.slice(cut + 1);
  if (!CODEX_EFFORTS.includes(suffix)) {
    return {
      id: raw,
      effort: '',
      error: `unknown codex reasoning effort "${suffix}" in model "${raw}"; valid efforts are ${CODEX_EFFORTS.join(', ')}`,
    };
  }
  return { id: raw.slice(0, cut), effort: suffix, error: null };
}

/**
 * The human sentence inside a codex error. `turn.failed` and the top-level `error` event carry the
 * API's own JSON response as a STRING, so the readable part - "The 'gpt-6-astra' model is not
 * supported when using Codex with a ChatGPT account." - sits two levels in. Reported raw it is a
 * wall of escaped JSON nobody reads. Anything that does not unwrap is passed through unchanged.
 */
function codexErrorText(message) {
  const raw = String(message == null ? '' : message).trim();
  if (!raw) return 'codex reported an error with no message';
  try {
    const o = JSON.parse(raw);
    const inner = o && o.error && o.error.message;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
    if (typeof o === 'string' && o.trim()) return o.trim();
  } catch {
    // Not JSON. That is the common case and the string is already the message.
  }
  return raw;
}

/**
 * Provider adapters. This table is the only place that knows a CLI's flags or output format.
 * `buildArgs` must produce a read-only invocation, and it returns the FULL argv including the
 * prompt, because the CLIs disagree about where the prompt goes. `readOnlyStrength` says how
 * strong that guard is: "dispatch" means the CLI refuses the tool call, "prompt" means the model
 * is only told not to write. `webAccess` says how much of the web that CLI reached when it was
 * last tried: "full" means both web search and URL fetch worked, "restricted" means at least one
 * of them is limited or was never proven, and `webNote` carries the detail with the date. Both are
 * measurements of what the CLI did, not vendor policy, so re-measure after a CLI upgrade. They are
 * declared per CLI and never inferred, because `research` runs on whichever provider its job is
 * configured with and setup has to say what that CLI can reach before someone picks it.
 * `parse` returns the normalized {ok, text, sessionId, usage, error}, so nothing downstream knows
 * which CLI ran.
 * Four hooks are optional. `validateModel(model)` returns a user-facing error string, or null,
 * for a model id this CLI cannot run; it is checked before any run directory exists.
 * `auth(run)` returns {ok, raw} for CLIs that can answer "signed in?" more cheaply than
 * listModels; a provider without one uses listModels as its probe.
 * `verifySession(requested, returned)` and `warnings(run)` are the other two.
 */
const PROVIDERS = {
  cursor: {
    bin: 'cursor-agent',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    loginHint: 'cursor-agent login  (opens a browser; the user must run this themselves)',
    readOnly: '--mode ask',
    readOnlyStrength: 'dispatch',
    webAccess: 'restricted',
    webNote:
      'URL fetch is dispatched then rejected per URL: cursor.com succeeded while example.com, github.com, docs.anthropic.com and raw.githubusercontent.com were all rejected, which looks like a vendor allow-list. Whether a web search tool exists at all was never measured.',
    // `--mode ask` is verified to refuse writes; `-p` alone still carries write and shell tools.
    // `--trust` is required or headless runs block on the workspace-trust prompt.
    buildArgs({ model, workspace, addDir, sandbox, resume, prompt }) {
      const a = ['-p', '--mode', 'ask', '--trust', '--output-format', 'json'];
      if (workspace) a.push('--workspace', workspace);
      a.push('--sandbox', sandbox ? 'enabled' : 'disabled');
      if (model) a.push('--model', model);
      if (addDir) a.push('--add-dir', addDir);
      if (resume) a.push('--resume', resume);
      // cursor-agent takes the prompt as the last positional argument.
      if (prompt) a.push(prompt);
      return a;
    },
    // Also the auth probe: not logged in exits non-zero. Lines read `id - Label (current)`.
    async listModels(run) {
      const res = await run(['--list-models']);
      if (res.code !== 0) return { ok: false, models: [], raw: (res.stderr || res.stdout).trim() };
      const models = res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes(' - '))
        .map((l) => [
          l.split(' - ')[0],
          l
            .split(' - ')
            .slice(1)
            .join(' - ')
            .replace(/\s*\(current\)$/, ''),
        ]);
      return { ok: true, models, raw: res.stdout };
    },
    // Success emits one JSON object with type "result". Auth and model failures exit 1 with
    // plain text, so a parse failure is a real failure and the raw text is the only signal.
    parse(stdout) {
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (o && o.type === 'result') {
          return {
            ok: !o.is_error,
            text: o.result,
            sessionId: o.session_id || null,
            usage: o.usage || null,
            error: o.is_error ? String(o.result || 'agent reported an error') : null,
          };
        }
      }
      return null;
    },
  },
  agy: {
    bin: 'agy',
    installHint: 'https://antigravity.google/docs/cli  (install the Antigravity CLI from its docs page)',
    loginHint: 'agy  (run it with no arguments; it opens the sign-in flow, so the user must run this themselves)',
    readOnly: '--mode plan',
    // Plan mode is a slash-command expansion, so it instructs the model rather than refusing a
    // tool call. It also does not survive a resume, which is why it is sent on every call.
    readOnlyStrength: 'prompt',
    webAccess: 'full',
    webNote:
      'search_web and read_url_content are both present and work in plan mode, re-measured on agy 1.1.27 on 2026-09-05. A chrome-devtools MCP browser was listed alongside them on agy 1.1.26 on 2026-09-04 and has not been re-measured since.',
    buildArgs({ model, addDir, timeoutSeconds, resume, prompt }) {
      // `-p` consumes the next token as the prompt, so the prompt must ride on `-p=` and come
      // first. Putting it last, after the other flags, exits 2 with "--mode" read as the prompt.
      // Workspace is the child process cwd; agy has no workspace flag. --print-timeout must come
      // from our timeout or agy's own 5-minute timer fires first. Plan mode does not persist
      // across a resume, so it is sent on every call, including this one.
      const a = [`-p=${prompt || ''}`, '--mode', 'plan', '--output-format', 'json'];
      if (model) a.push('--model', model);
      a.push('--print-timeout', `${timeoutSeconds}s`);
      if (addDir) a.push('--add-dir', addDir);
      // --continue picks the globally most recent conversation and is unsafe for a runner.
      if (resume) a.push('--conversation', resume);
      return a;
    },
    // `agy models` prints `id<TAB>label` per line. Not signed in: exit 1, empty stdout, the
    // reason on stderr. `-p` must not be used as an auth probe: it blocks on an OAuth prompt.
    async listModels(run) {
      const res = await run(['models']);
      if (res.code !== 0) return { ok: false, models: [], raw: (res.stderr || res.stdout).trim() };
      const models = res.stdout
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim())
        .map((l) => {
          const i = l.indexOf('\t');
          return i < 0 ? [l.trim(), l.trim()] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        });
      return { ok: true, models, raw: res.stdout };
    },
    // Stdout is exactly one JSON line. Failures set status "ERROR" and an `error` string.
    parse(stdout) {
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (!o || typeof o !== 'object' || !('status' in o)) continue;
        return {
          ok: o.status === 'SUCCESS',
          text: o.response,
          sessionId: o.conversation_id || null,
          usage: o.usage || null,
          error: o.error || null,
        };
      }
      return null;
    },
    // An unknown --conversation id prints a warning on stderr and silently starts a NEW
    // conversation with exit 0, so the returned id is the only reliable signal.
    verifySession(requested, returned) {
      return returned === requested;
    },
    // The global toolPermission setting decides whether headless runs auto-approve tools.
    // Readable without an agent turn via the /config slash command. The caller must only run
    // this once listModels reported signed in: on a signed-out agy, `-p` blocks for 60 seconds
    // on the sign-in prompt.
    async warnings(run) {
      // Never return nothing on failure: a silent null is indistinguishable from "the setting is
      // safe", so the first agy release that moves the setting would delete this warning.
      const unreadable = 'could not read agy toolPermission; check ~/.gemini/antigravity-cli/settings.json';
      const res = await run(['-p=/config', '--output-format', 'json']);
      if (res.code !== 0) return unreadable;
      try {
        const lines = res.stdout.trim().split('\n').filter(Boolean);
        // The setting is nested at command.data.config, not command.data.
        const data = JSON.parse(lines[lines.length - 1]).command.data.config;
        if (!data) return unreadable;
        if (data.toolPermission === 'always-proceed') {
          return 'toolPermission is "always-proceed": agy will auto-approve tool calls in headless runs; plan mode is the only guard';
        }
      } catch {
        return unreadable;
      }
      return null;
    },
  },
  codex: {
    bin: 'codex',
    installHint: 'brew install codex   (or: npm install -g @openai/codex)',
    loginHint: 'codex login  (opens a browser; the user must run this themselves)',
    readOnly: '-s read-only',
    // Stronger than cursor's, which only refuses at tool dispatch: on codex-cli 0.153.4, measured
    // 2026-09-06, `-s read-only` is an OS sandbox AND a tool-router refusal. apply_patch came back
    // "patch rejected: writing is blocked by read-only sandbox" and a shell `echo hi > FILE` came
    // back "operation not permitted" from Seatbelt. Neither route created a file. The enum has no
    // value above "dispatch", so that is what this records.
    readOnlyStrength: 'dispatch',
    webAccess: 'full',
    webNote:
      'The native web__run tool is on by default and did both a web search and a fetch of https://example.com under -s read-only, measured on codex-cli 0.153.4 on 2026-09-06. Whether a plain shell curl has network under read-only was not measured.',
    // Refuses a bad reasoning suffix before invoke() writes anything. buildArgs checks it again,
    // but that runs after the packet is on disk.
    validateModel(model) {
      return splitCodexEffort(model).error;
    },
    buildArgs({ model, workspace, resume, prompt }) {
      // Defence in depth: validateModel already refused this, at a point where nothing had been
      // written yet. Reaching fail() here means a caller skipped the pre-flight check.
      const { id, effort, error } = splitCodexEffort(model);
      if (error) fail(error);
      // codex parses a `-c` value as TOML, so the inner double quotes are the string delimiters
      // it strips, not data. Node spawns no shell to add them, so they have to sit inside the
      // single argv element. A future override wanting a number or a bool must go unquoted.
      const reasoning = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
      // `exec resume` rejects -s, -C and --add-dir, so the sandbox has to ride on -c there. The
      // flags below are ones it does take - --json, --all, --ignore-user-config and
      // --skip-git-repo-check every time, and -m only when the caller named a model, because a
      // plain resume keeps the session's own. Read `codex exec resume --help` before deleting one.
      // Verified from that --help and empirically on codex-cli 0.153.4, 2026-09-06.
      // Read-only does survive a resume on its own (verified on 0.153.4); this re-sends it anyway.
      // --all is what finds a thread started from a different cwd, and `review --pr` deletes its
      // worktree, so a later resume never runs from the directory the thread began in.
      // --ignore-user-config stops the user's own MCP servers from spawning; it is not accepted by
      // `login status` or `debug models`. --skip-git-repo-check is belt and braces: every
      // workspace here is already a repository - invoke() refuses to run outside one, preparePr()
      // checks out a worktree, `research --scratch` does git init plus one empty commit - but a
      // linked worktree carries `.git` as a FILE rather than a directory, and whether codex's repo
      // check accepts that was never measured.
      const a = resume
        ? ['exec', 'resume', resume, '--all', '--json', '--ignore-user-config', '-c', 'sandbox_mode="read-only"']
        : ['exec', '--json', '-s', 'read-only', '--ignore-user-config'];
      a.push('--skip-git-repo-check');
      // Workspace is codex's cwd anyway; -C states it so a later change of spawn cwd cannot move
      // the run. addDir is deliberately ignored: on codex --add-dir means "additionally WRITABLE",
      // the opposite of what cursor and agy use it for, and it is not needed either, because codex
      // reads outside its cwd freely. The `sandbox` config flag is ignored too, the way agy ignores it.
      if (!resume && workspace) a.push('-C', workspace);
      if (id) a.push('-m', id);
      a.push(...reasoning);
      // codex exec takes the prompt as the last positional argument.
      if (prompt) a.push(prompt);
      return a;
    },
    // `login status` exits 0 signed in, 1 signed out. About a second, no model turn, no catalogue
    // request - which is why codex defines this hook at all: a run only needs the yes/no, and
    // listModels would fetch a quarter of a megabyte to answer it. It matters that the run asks:
    // a signed-out `codex exec` retries 401 against wss://api.openai.com in a loop instead of
    // exiting. Does not accept --ignore-user-config.
    async auth(run) {
      const res = await run(['login', 'status']);
      return { ok: res.code === 0, raw: (res.stdout || res.stderr).trim() };
    },
    // Two calls, because `debug models` cannot be the auth probe: signed out it still exits 0 and
    // returns a different bundled catalogue, so it would report a list of models nobody can run.
    // The probe is the same `auth` hook a run uses, not a second copy of it. `doctor` and the
    // `models` verb call listModels directly and rely on it probing. Neither subcommand accepts
    // --ignore-user-config.
    async listModels(run) {
      const signedIn = await this.auth(run);
      if (!signedIn.ok) return { ok: false, models: [], raw: signedIn.raw };
      const res = await run(['debug', 'models']);
      if (res.code !== 0) return { ok: false, models: [], raw: (res.stdout || res.stderr).trim() };
      let doc;
      try {
        doc = JSON.parse(res.stdout);
      } catch {
        return { ok: false, models: [], raw: res.stdout.trim() };
      }
      const models = [];
      for (const m of (doc && doc.models) || []) {
        if (!m || !m.slug || m.visibility === 'hide') continue;
        const label = m.display_name || m.slug;
        const levels = (m.supported_reasoning_levels || []).map((l) => l && l.effort).filter(Boolean);
        // One id per model x effort, and never the bare slug: a bare id runs at codex's own
        // default effort, so setup could offer "the model you asked for" at a level nobody chose.
        // A model that lists no levels has nothing to choose, so it keeps its bare slug.
        if (!levels.length) models.push([m.slug, label]);
        else for (const e of levels) models.push([`${m.slug}:${e}`, `${label} (${e})`]);
      }
      // `raw` is summarised, not verbatim: each catalogue entry carries the model's full system
      // prompt, so the real stdout is a quarter of a megabyte. The other two providers print a
      // line per model, and `raw` on success is only ever read by a human, so match them.
      const raw = models.map(([id, label]) => `${id}\t${label}`).join('\n');
      return { ok: true, models, raw };
    },
    // --json prints one JSON event per line. Unparseable lines are skipped, as with the other two.
    parse(stdout) {
      let sawObject = false;
      let sessionId = null;
      let usage = null;
      let error = null;
      let fatal = null;
      const texts = [];
      for (const line of stdout.split('\n')) {
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o || typeof o !== 'object') continue;
        sawObject = true;
        if (o.type === 'thread.started' && o.thread_id) sessionId = o.thread_id;
        else if (o.type === 'turn.completed' && o.usage) usage = o.usage;
        // The terminal failure. `turn.failed` and the top-level `error` event carry the reason the
        // turn died - a rejected model id, a quota - while the item-level error above is only the
        // warning that preceded it. The terminal one wins, so it overwrites rather than defers.
        else if (o.type === 'turn.failed' && o.error) fatal = codexErrorText(o.error.message);
        else if (o.type === 'error' && o.message) fatal = fatal || codexErrorText(o.message);
        else if (o.type === 'item.completed' && o.item) {
          // Every agent_message, not the last one: codex emits a short commentary preamble and
          // the real answer as two separate items, and keeping only the last drops the half the
          // final message refers back to. Only messages that carry text count: an empty one is
          // not an answer, and counting it would let a renamed `text` field return ok with an
          // empty result - a silent non-answer, worse than the failure below.
          if (o.item.type === 'agent_message') {
            const text = String(o.item.text || '');
            if (text.trim()) texts.push(text);
          }
          // An unknown model id does not fail codex: it reports it here and answers on a fallback
          // model. That is a silently substituted model wearing a plausible answer, so it fails
          // the run even when an answer did arrive.
          else if (o.item.type === 'error' && !error) error = String(o.item.message || 'codex reported an error');
        }
      }
      if (!sawObject) return null;
      // A failure shape we have not seen would otherwise read as a successful empty answer, so
      // absence of an answer is itself the failure.
      if (fatal) error = fatal;
      else if (!error && !texts.length) error = 'codex produced no agent_message with text; the turn did not answer';
      return { ok: !error, text: texts.join('\n\n'), sessionId, usage, error };
    },
    // An unknown resume id exits 1 today rather than starting a fresh thread, and the returned
    // thread_id equals the requested one. This costs one comparison and is what would catch the
    // release that changes that, which is exactly how agy loses a conversation.
    verifySession(requested, returned) {
      return returned === requested;
    },
  },
};

/**
 * Reads the config file and layers it over the defaults. Deliberately does not validate:
 * `doctor` has to be able to load a broken config in order to report what is wrong with it.
 * Validation lives in configErrors().
 */
function loadConfig() {
  let user = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      fail(`config.json is not valid JSON (${CONFIG_PATH}): ${e.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...user, models: { ...(user.models || {}) } };
}

const KNOWN_CONFIG_KEYS = new Set([
  'models',
  'timeoutSeconds',
  'keepRuns',
  'sandbox',
  'maxDiffBytes',
  'maxAdviseBytes',
  'modelLabels',
]);

/**
 * Everything wrong with the config on disk, as user-facing sentences. A stale key is an error
 * rather than something to ignore, so a config written by an older version is caught whole
 * instead of half-read.
 */
function configErrors(cfg) {
  const errs = [];
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) errs.push(`unknown config key "${key}"; run setup`);
  }
  // A leftover "enabled" string is truthy, so cursor would read it as sandbox on and agy as
  // nothing at all. That is the same half-read failure the unknown-key check exists to stop.
  if (typeof cfg.sandbox !== 'boolean') errs.push('sandbox must be true or false; run setup');
  for (const [job, value] of Object.entries(cfg.models || {})) {
    // Both halves are required. "cursor/" parses as a model of '', which would reach the CLI with
    // no --model at all and silently run whatever that CLI defaults to.
    if (typeof value !== 'string' || !value.includes('/') || !value.slice(value.indexOf('/') + 1)) {
      errs.push(`models.${job} must be "<provider>/<model>"; run setup`);
      continue;
    }
    const provider = value.slice(0, value.indexOf('/'));
    if (!Object.hasOwn(PROVIDERS, provider)) {
      errs.push(`unknown provider "${provider}" in models.${job}`);
      continue;
    }
    // Asked here so `doctor` reports a model the CLI cannot run, instead of blessing a config that
    // then fails on every single run. Only some providers can judge a model id offline.
    const p = PROVIDERS[provider];
    if (p.validateModel) {
      // The job name goes in FRONT: these messages end in a list of valid values, and a trailing
      // "in models.review" reads as the last item of it.
      const bad = p.validateModel(value.slice(value.indexOf('/') + 1));
      if (bad) errs.push(`models.${job}: ${bad}`);
    }
  }
  return errs;
}

/** Splits "<provider>/<model>" on the first slash. `where` names the source in the error. */
function splitModel(value, where) {
  const i = value.indexOf('/');
  const model = i < 0 ? '' : value.slice(i + 1);
  // An empty model half is as wrong as a missing slash: it would run the CLI's default model.
  if (i < 0 || !model) fail(`${where} must be "<provider>/<model>"; run setup`);
  const provider = value.slice(0, i);
  if (!Object.hasOwn(PROVIDERS, provider)) fail(`unknown provider "${provider}" in ${where}`);
  return { provider, model };
}

/**
 * Picks the provider and model for one job. `--model <provider>/<model>` overrides both;
 * a bare `--model <id>` keeps the job's configured provider and swaps only the model, so a
 * one-off override cannot silently move the run to a different CLI.
 */
function resolveModel(cfg, job, override) {
  const spec = override && override !== true ? String(override) : null;
  if (spec && spec.includes('/')) return splitModel(spec, '--model');
  const configured = (cfg.models || {})[job];
  if (typeof configured !== 'string' || !configured) fail(`no model configured for ${job}; run setup`);
  const base = splitModel(configured, `models.${job}`);
  return spec ? { provider: base.provider, model: spec } : base;
}

/**
 * Finds the provider that issued a session id, by scanning run metadata. A session id is only
 * valid on the CLI that created it, so resume must not guess. The run's `scratch` flag comes back
 * with it, because a scratch run is the one kind resume cannot reproduce.
 */
function findRunProvider(session) {
  if (!existsSync(RUNS)) return null;
  for (const bucket of readdirSync(RUNS)) {
    let runs;
    try {
      runs = readdirSync(join(RUNS, bucket));
    } catch {
      continue;
    }
    for (const run of runs) {
      try {
        const m = JSON.parse(readFileSync(join(RUNS, bucket, run, 'meta.json'), 'utf8'));
        if (m.sessionId === session && Object.hasOwn(PROVIDERS, m.provider)) {
          return { provider: m.provider, model: m.model, scratch: Boolean(m.scratch) };
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Both flag forms: `--key value` and `--key=value`. Only the space form was read, so the equals
 * form made the whole of `scratch=true` the key and left `args.scratch` undefined. Every other
 * flag failed loudly that way, having lost the value the run needed; `--scratch` failed silently,
 * because it only had to be absent to hand the repository to the model. The split is on the FIRST
 * `=`, so a value containing one survives intact.
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const flag = a.slice(2);
      const eq = flag.indexOf('=');
      if (eq !== -1) {
        out[flag.slice(0, eq)] = flag.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[flag] = true;
      else {
        out[flag] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

/** Runs git and throws on failure. For the few calls whose failure has to stop the run. */
function gitStrict(repo, args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repo, args) {
  try {
    return gitStrict(repo, args);
  } catch {
    return '';
  }
}

function isRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
}

/**
 * True only when git ran and reported that this path is not a work tree. `!isRepo()` cannot tell
 * that apart from git failing to run at all - an unparseable global git config makes both false -
 * and telling someone their directory is wrong would bury git's own reason for the failure. The
 * `--version` probe answers in any directory and needs no repository, so it fails only when git
 * itself cannot start.
 */
function isNotRepo(repo) {
  if (isRepo(repo)) return false;
  try {
    gitStrict(repo, ['--version']);
  } catch {
    return false;
  }
  return true;
}

/**
 * Content fingerprint of the working tree, used to detect writes during a run.
 * Covers the status list, the tracked diff, and size+mtime of untracked files - porcelain
 * output alone reports only status codes and paths, so an already-dirty or already-untracked
 * file can be modified further without its status line changing at all.
 * Git-ignored files are deliberately out of scope; hashing them would mean walking node_modules.
 */
function treeFingerprint(repo) {
  if (!isRepo(repo)) return null;
  const h = createHash('sha256');
  h.update(git(repo, ['status', '--porcelain']));
  h.update(git(repo, ['diff', 'HEAD']));
  for (const rel of git(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    try {
      const st = statSync(join(repo, rel));
      h.update(`${rel}:${st.size}:${st.mtimeMs}`);
    } catch {
      h.update(`${rel}:missing`);
    }
  }
  return h.digest('hex');
}

function slug(p) {
  return p.replace(/^.*\//, '') + '-' + createHash('sha256').update(p).digest('hex').slice(0, 8);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Per-invocation suffix. Timestamps are only second-precise, so two runs started together shared
 * a run directory and silently overwrote each other's packet - each agent then read whichever
 * packet won the race and answered the wrong question.
 */
function runId() {
  return `${stamp()}-${process.pid.toString(36)}${randomBytes(2).toString('hex')}`;
}

/** Thrown by fail() so the caller unwinds; main()'s catch treats it as already-reported. */
class Reported extends Error {}

function fail(msg, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n');
  process.exitCode = 1;
  throw new Reported(msg);
}

function pruneRuns(dir, keep) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir)
    .map((n) => ({ n, p: join(dir, n) }))
    .filter((e) => {
      try {
        return statSync(e.p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.n.localeCompare(a.n));
  for (const e of entries.slice(keep)) rmSync(e.p, { recursive: true, force: true });
}

/**
 * Spawns the provider with exactly this argv, enforcing a hard timeout: SIGTERM at the deadline,
 * SIGKILL 5s later. The prompt, if there is one, is already inside argv - the CLIs disagree
 * about where it goes, so only the provider's buildArgs decides.
 */
function runAgent(bin, argv, cwd, timeoutSeconds) {
  return new Promise((resolveP) => {
    const started = Date.now();
    const child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const term = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutSeconds * 1000);
    child.on('error', (e) => {
      clearTimeout(term);
      resolveP({ code: -1, stdout, stderr: String(e.message), timedOut, elapsedMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(term);
      resolveP({ code, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

/** Absolute path of a binary on PATH, or '' when it is not there. */
function whichBin(bin) {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The runner handed to a provider's listModels() and warnings(): same bin, same cwd, 60s cap.
 * It takes a full argv, so those helpers place their own prompt the way their CLI needs it.
 */
function providerRunner(provider, cwd) {
  return (argv) => runAgent(provider.bin, argv, cwd, 60);
}

/**
 * Normalizes one provider run into the envelope the caller sees. Everything CLI-specific has
 * already been flattened by provider.parse, so nothing here knows which CLI ran.
 */
function buildEnvelope(provider, res, timeoutSeconds, resume) {
  if (res.timedOut) {
    return { ok: false, error: `timed out after ${timeoutSeconds}s`, raw: (res.stdout || res.stderr).slice(0, 4000) };
  }
  if (res.code !== 0) {
    // A bare "exited 1" is unactionable when the CLI said why. codex writes its reason to stdout
    // as a JSON event and always writes a benign "Reading additional input from stdin..." line to
    // stderr, so preferring stderr reported the noise and dropped a plain-English 400. Ask the
    // provider to read its own output first; fall back to the exit code when it cannot.
    let reason = null;
    try {
      const parsed = provider.parse(res.stdout);
      if (parsed && parsed.error) reason = String(parsed.error);
    } catch {
      // A parser that throws on a dying CLI's half-written output must not mask the exit code.
    }
    return {
      ok: false,
      error: reason || `${provider.bin} exited ${res.code}`,
      // Quote whichever stream carried the reason, not whichever one is non-empty.
      raw: (reason ? res.stdout || res.stderr : res.stderr || res.stdout).trim().slice(0, 4000),
    };
  }
  const parsed = provider.parse(res.stdout);
  if (!parsed) {
    return {
      ok: false,
      error: 'output was not parseable JSON',
      raw: (res.stdout || res.stderr).trim().slice(0, 4000),
    };
  }
  if (!parsed.ok) {
    return { ok: false, error: 'agent reported an error', raw: String(parsed.error || parsed.text || '').slice(0, 4000) };
  }
  // A CLI that silently starts a new conversation when the id is unknown answers the right
  // question in the wrong context, which reads as a plausible answer to the wrong history.
  if (resume && provider.verifySession && !provider.verifySession(resume, parsed.sessionId)) {
    return {
      ok: false,
      error: `${provider.bin} returned conversation ${parsed.sessionId} but ${resume} was requested; the session was not resumed`,
      raw: (res.stdout || '').trim().slice(0, 4000),
    };
  }
  return { ok: true, result: parsed.text, sessionId: parsed.sessionId, usage: parsed.usage || null };
}

function readPrompt(name) {
  const p = join(SKILL_DIR, 'prompts', `${name}.md`);
  if (!existsSync(p)) fail(`missing prompt template: ${p}`);
  return readFileSync(p, 'utf8');
}

/**
 * Assembles the review context. With --base, the merge-base diff of that ref against HEAD;
 * otherwise the uncommitted working-tree diff. Oversized diffs are truncated with an explicit
 * note listing what was dropped, so the reviewer is never silently reading a partial change.
 */
function collectDiff(repo, base, maxBytes, baseLabel) {
  let label, stat, diff;
  if (base) {
    label = `${baseLabel || base}...HEAD (merge-base)`;
    stat = git(repo, ['diff', '--stat', `${base}...HEAD`]);
    diff = git(repo, ['diff', `${base}...HEAD`]);
  } else {
    label = 'uncommitted working tree (vs HEAD)';
    stat = git(repo, ['diff', '--stat', 'HEAD']);
    diff = git(repo, ['diff', 'HEAD']);
  }
  const untracked = base ? '' : git(repo, ['ls-files', '--others', '--exclude-standard']).trim();
  let truncated = null;
  if (diff.length > maxBytes) {
    truncated = `Diff was ${diff.length} bytes, truncated to ${maxBytes}. The file summary above is complete; the diff body below is not. Ask for specific files if you need what was cut.`;
    diff = diff.slice(0, maxBytes);
  }
  return { label, stat, diff, untracked, truncated };
}

/**
 * Locates the live Claude Code transcript for this session. The project directory is the cwd
 * with every non-alphanumeric character replaced by a dash.
 * Note: a subagent inherits its PARENT's CLAUDE_CODE_SESSION_ID, so from inside a subagent this
 * resolves to the parent's conversation, not its own - subagents should pass --context instead.
 */
function findTranscript(repo) {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) return null;
  const projectDir = join(homedir(), '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  const path = join(projectDir, `${sid}.jsonl`);
  return existsSync(path) ? { path, sessionId: sid } : null;
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length - max} more chars)` : flat;
}

/**
 * Turns a transcript into a readable story: human turns, the agent's own prose, and tool calls
 * reduced to name plus a truncated argument and result. The raw file is mostly tool payloads -
 * dropping them is what makes a 1.5MB session fit in a prompt. Oldest turns are dropped first
 * when over budget, and the count of dropped turns is reported rather than silently swallowed.
 */
function distillTranscript(path, maxBytes) {
  const stripReminders = (t) =>
    String(t)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .trim();
  const turns = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const msg = d.message;
    if (!msg) continue;
    const parts = [];
    const content = msg.content;
    if (typeof content === 'string') parts.push(stripReminders(content));
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') parts.push(stripReminders(b.text || ''));
        // Thinking blocks are persisted with their text stripped (signature only), so there is
        // no reasoning to forward - emitting the marker would imply content that isn't there.
        else if (b.type === 'thinking') continue;
        else if (b.type === 'tool_use') parts.push(`[ran ${b.name}] ${oneLine(JSON.stringify(b.input || {}), 300)}`);
        else if (b.type === 'tool_result') {
          const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
          parts.push(`[result] ${oneLine(raw, 500)}`);
        }
      }
    }
    const text = parts.filter(Boolean).join('\n').trim();
    if (text) turns.push(`### ${msg.role === 'user' ? 'Human' : 'Agent'}\n\n${text}`);
  }
  let kept = turns;
  let dropped = 0;
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n\n')) > maxBytes) {
    kept = kept.slice(1);
    dropped++;
  }
  return { text: kept.join('\n\n'), dropped, total: turns.length };
}

/**
 * The parent directory for this user's throwaway checkouts under the system temp dir. The uid is
 * in the name because on Linux tmpdir() is /tmp, shared by everyone on the machine: the first user
 * to run created the parent with their own umask and owned it, cleanup() only ever removes the
 * leaf inside it, and every later user then got EACCES from mkdir and a dead run. macOS never hit
 * it because its tmpdir() is already per-user. The name still starts with external-advisor, so
 * whoever finds one of these in /tmp can tell what wrote it. process.getuid is not defined on
 * Windows, where the temp dir is per-user anyway.
 */
function tmpRoot(name) {
  const uid = typeof process.getuid === 'function' ? `-${process.getuid()}` : '';
  return join(tmpdir(), `${name}${uid}`);
}

/**
 * Exit codes for the signals that must still run cleanup: 128 plus the signal number. SIGHUP is
 * in the table because Node's default action for it is to terminate without firing 'exit', so
 * closing a terminal tab or dropping an SSH session mid-run orphaned the PR worktree or the
 * scratch workspace in the temp dir with nothing left to remove it.
 */
const SIGNAL_EXITS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Checks out a PR head in a throwaway worktree so the reviewer reads the PR's real code, not the
 * local checkout. Uses a private ref namespace and a detached worktree, so no branch is created
 * and the caller's working tree is never touched; cleanup() removes both.
 */
function preparePr(repo, number) {
  let meta;
  try {
    meta = JSON.parse(
      execFileSync('gh', ['pr', 'view', number, '--json', 'number,title,body,headRefName,baseRefName,state'], {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  } catch (e) {
    fail(
      `could not read PR #${number} via gh: ${String(e.stderr || e.message)
        .trim()
        .slice(0, 300)}`,
    );
  }

  const token = runId();
  const ref = `refs/external-advisor/pr-${number}-${token}`;
  const baseRef = `refs/external-advisor/base-${number}-${token}`;
  // Transient checkouts go to the system temp dir, never inside the repo: a full worktree under
  // .agent-artifacts/ is gitignored but still visible to file watchers, linters and test globs.
  const worktree = join(tmpRoot('external-advisor-worktrees'), `pr-${number}-${token}`);
  const cleanupRefs = () => {
    git(repo, ['update-ref', '-d', ref]);
    git(repo, ['update-ref', '-d', baseRef]);
  };
  git(repo, ['fetch', '--quiet', '--force', 'origin', `pull/${number}/head:${ref}`]);
  if (!git(repo, ['rev-parse', '--verify', '--quiet', ref]).trim()) {
    cleanupRefs();
    fail(`could not fetch pull/${number}/head from origin (is the PR from a fork with no head ref?)`);
  }
  // The base goes into a ref this run owns rather than origin/<base>: a bare fetch only updates
  // the remote-tracking ref when the remote's refspec covers that branch, so a single-branch clone
  // fetches into FETCH_HEAD, exits 0, and leaves a pre-existing origin/<base> stale. An explicit
  // destination always writes, and a failure to fetch fails the run instead of reviewing stale code.
  try {
    gitStrict(repo, ['fetch', '--quiet', '--force', 'origin', `${meta.baseRefName}:${baseRef}`]);
  } catch (e) {
    cleanupRefs();
    fail(
      `could not fetch ${meta.baseRefName} from origin; refusing to review against a possibly stale base: ${String(
        e.stderr || e.message,
      )
        .trim()
        .slice(0, 300)}`,
    );
  }
  if (!git(repo, ['rev-parse', '--verify', '--quiet', baseRef]).trim()) {
    cleanupRefs();
    fail(`could not resolve ${meta.baseRefName} after fetching; refusing to review against a missing base`);
  }

  // Registering on 'exit' rather than a `finally` is what guarantees the worktree and ref are
  // removed on every path, including signals; git's helpers are synchronous so they still run
  // inside an exit handler.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    git(repo, ['worktree', 'remove', '--force', worktree]);
    cleanupRefs();
    rmSync(worktree, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
  };
  process.on('exit', cleanup);
  for (const [sig, code] of Object.entries(SIGNAL_EXITS)) {
    process.on(sig, () => {
      cleanup();
      process.exit(code);
    });
  }

  mkdirSync(dirname(worktree), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', worktree, ref]);
  if (!existsSync(join(worktree, '.git'))) {
    cleanup();
    fail(`could not create a worktree for PR #${number} at ${worktree}`);
  }

  return {
    worktree,
    cleanup,
    number: meta.number,
    headRef: meta.headRefName,
    base: baseRef,
    baseLabel: `origin/${meta.baseRefName}`,
    title: meta.title,
    body:
      (meta.body || '').length > 4000
        ? `${meta.body.slice(0, 4000)}\n\n[...PR description truncated at 4000 of ${meta.body.length} characters...]`
        : meta.body || '',
  };
}

/**
 * A throwaway workspace for research questions that are not about this repository. It goes to the
 * system temp directory rather than inside the repo, for the same reason PR worktrees do: a
 * directory under the working tree is still picked up by file watchers, linters and test globs
 * even when it is gitignored.
 *
 * It is a git repository because `treeFingerprint` returns null outside one, and a null
 * fingerprint means the guard runs over the workspace and verifies nothing. The one empty commit
 * is for completeness rather than necessity: `git status --porcelain` and `ls-files --others`
 * already catch a created file with no HEAD, but `git diff HEAD` fails, and `git()` swallows that
 * failure silently. A HEAD keeps all three parts of the fingerprint real.
 */
function prepareScratch() {
  const dir = join(tmpRoot('external-advisor-scratch'), `research-${runId()}`);

  // Registered before the directory exists, and on 'exit' rather than only in a `finally`, so it
  // covers every path: signals, and a failure inside this function before it ever returns a
  // cleanup for the caller to call. rmSync is synchronous, so it still runs inside an exit
  // handler, and `force` makes a directory that was never created a no-op rather than an error.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  for (const [sig, code] of Object.entries(SIGNAL_EXITS)) {
    process.on(sig, () => {
      cleanup();
      process.exit(code);
    });
  }

  // Every other failure in this file is reported by fail() as a sentence. Left to throw, a broken
  // global git config reached main()'s catch and printed a raw JS stack as the `error` string.
  try {
    mkdirSync(dir, { recursive: true });
    gitStrict(dir, ['init', '-q', '-b', 'main']);
    // Identity and signing come from flags, never from the developer's global config: an empty
    // commit fails outright where user.email was never set, and blocks on a passphrase prompt
    // where commit.gpgsign is on globally. Hooks are repo-external here - a global core.hooksPath,
    // or one copied in by init.templateDir - so they are disabled twice over. --no-verify alone is
    // not enough: it skips pre-commit and commit-msg but not prepare-commit-msg, which still runs
    // against this empty commit and fails the whole research run over someone else's checks.
    // core.hooksPath then points somewhere that cannot hold a hook, so git finds nothing to run.
    gitStrict(dir, [
      '-c',
      'user.email=external-advisor@localhost',
      '-c',
      'user.name=external-advisor',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '--no-verify',
      '-m',
      'scratch',
    ]);
  } catch (e) {
    fail(
      `could not create the scratch workspace at ${dir}: ${String(e.stderr || e.message)
        .trim()
        .slice(0, 300)}`,
    );
  }

  return { dir, cleanup };
}

async function invoke({ cfg, verb, repo, workspace, provider, model, packetBody, timeoutSeconds, resume, extraMeta }) {
  // Checked before the packet is written or the provider spawns: outside a repo both fingerprints
  // are null, so the run would report `treeChanged: false` having verified nothing.
  if (!isRepo(repo)) {
    fail(`${repo} is not a git repository; the working-tree guard cannot run there`);
  }

  // `repo` is the durable identity used for run history and the write guard; `workspace` is what
  // the agent actually reads, which for a PR review is a throwaway worktree. Keying history off
  // the worktree gave every PR run its own bucket, so keepRuns never pruned any of them.
  const ws = workspace || repo;
  if (!Object.hasOwn(PROVIDERS, provider)) fail(`unknown provider "${provider}"`);
  const p = PROVIDERS[provider];

  // Pre-flight, before anything is written or spawned. Without it a missing binary surfaces as
  // `spawn ENOENT` with no way to fix it, and a signed-out agy blocks for 60 seconds on the
  // sign-in prompt.
  // The model check is first because it costs nothing: no spawn, no network. It has to run before
  // the run directory exists, or a refused model leaves an orphan packet.md with no meta.json -
  // and being the newest, that orphan survives pruning and evicts the history `resume` reads.
  // On `advise` that packet holds the whole distilled session transcript.
  if (p.validateModel && model) {
    const bad = p.validateModel(model);
    if (bad) fail(bad);
  }
  if (!whichBin(p.bin)) {
    fail(`${p.bin} not found on PATH`, { installHint: p.installHint, thenRun: p.loginHint });
  }
  // The auth probe: one extra spawn, no model turn, about a second. A provider with an `auth` hook
  // has a cheaper way to ask than its listModels, which on codex fetches the whole catalogue.
  const probe = p.auth ? await p.auth(providerRunner(p, ws)) : await p.listModels(providerRunner(p, ws));
  if (!probe.ok) {
    fail(`${p.bin} is not signed in`, { raw: String(probe.raw || '').slice(0, 1000), thenRun: p.loginHint });
  }

  const runDir = join(RUNS, slug(repo), `${runId()}-${verb}`);
  mkdirSync(runDir, { recursive: true });
  const packetPath = join(runDir, 'packet.md');
  writeFileSync(packetPath, packetBody);

  // Fingerprint both the durable repo and the workspace: for a PR review the agent operates in the
  // worktree, and cleanup deletes it, so a write there would otherwise leave no trace at all.
  const guardBefore = treeFingerprint(repo);
  const wsGuardBefore = ws === repo ? null : treeFingerprint(ws);

  // Nothing but the packet path goes on the command line; the provider decides where it sits.
  const prompt = `Read the file ${packetPath} in full and follow its instructions exactly.`;
  const argv = p.buildArgs({
    model,
    workspace: ws,
    addDir: runDir,
    sandbox: cfg.sandbox,
    resume,
    timeoutSeconds,
    prompt,
  });
  const res = await runAgent(p.bin, argv, ws, timeoutSeconds);

  const guardAfter = treeFingerprint(repo);
  const wsGuardAfter = ws === repo ? null : treeFingerprint(ws);
  // Which root moved is kept, not just whether one did. `treeChanged` is the OR of the two, so on
  // a scratch or PR run it fired without saying where: the repository's `git status` came back
  // clean, the throwaway workspace was already deleted, and the reader was left guessing which of
  // the two had been written to.
  const repoChanged = guardBefore !== null && guardBefore !== guardAfter;
  const wsChanged = wsGuardBefore !== null && wsGuardBefore !== wsGuardAfter;
  const changedRoots = [repoChanged ? repo : null, wsChanged ? ws : null].filter(Boolean);
  const treeChanged = changedRoots.length > 0;

  writeFileSync(join(runDir, 'response.json'), res.stdout || res.stderr || '');

  const envelope = buildEnvelope(p, res, timeoutSeconds, resume);

  const meta = {
    verb,
    repo,
    workspace: ws,
    provider,
    model: model || (resume ? "(the resumed session's own model)" : '(provider default)'),
    runDir,
    packetPath,
    packetBytes: Buffer.byteLength(packetBody),
    elapsedMs: res.elapsedMs,
    exitCode: res.code,
    timedOut: res.timedOut,
    treeChanged,
    guarded: ws === repo ? [repo] : [repo, ws],
    changedRoots,
    sessionId: envelope.sessionId || null,
    usage: envelope.usage || null,
    startedAt: new Date(Date.now() - res.elapsedMs).toISOString(),
    ...(extraMeta || {}),
  };
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  pruneRuns(join(RUNS, slug(repo)), cfg.keepRuns);

  // A guard violation fails the run even when the model answered, so `ok` has to reflect it:
  // a caller reading only `ok` must not be able to miss a write.
  const out = {
    ...envelope,
    ...(extraMeta || {}),
    ok: envelope.ok && !treeChanged,
    verb,
    runDir,
    packetPath,
    provider,
    model: meta.model,
    elapsedMs: res.elapsedMs,
    treeChanged,
  };
  if (treeChanged) {
    // Name the root that moved. "Inspect `git status`" was the only advice given, and it is the
    // wrong advice when the write landed in a throwaway workspace: that directory is deleted on
    // the way out, so there is nothing to inspect, and the repository is clean.
    const moved =
      repoChanged && wsChanged
        ? `Both the repository at ${repo} and the throwaway workspace at ${ws} changed during this run.`
        : repoChanged
          ? `The repository at ${repo} changed during this run.`
          : `The throwaway workspace at ${ws} changed during this run, and the repository at ${repo} did not.`;
    const next = repoChanged
      ? 'Inspect `git status` in the repository before trusting this output.'
      : 'That workspace is deleted when the run ends, so there is nothing left to inspect. Your code was not touched, but the model wrote where it was told it could not, so treat the answer as untrusted and check the provider is still read-only.';
    out.changedRoots = changedRoots;
    out.guardViolation = `${moved} A read-only advisor must not write. ${next}`;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = envelope.ok && !treeChanged ? 0 : 1;
}

/** Model ids this provider has actually run, so a one-off --model keeps its label. */
function modelsUsedByRuns(provider) {
  const ids = new Set();
  if (!existsSync(RUNS)) return ids;
  for (const bucket of readdirSync(RUNS)) {
    let runs;
    try {
      runs = readdirSync(join(RUNS, bucket));
    } catch {
      continue;
    }
    for (const run of runs) {
      try {
        const m = JSON.parse(readFileSync(join(RUNS, bucket, run, 'meta.json'), 'utf8'));
        if (m.provider === provider && m.model) ids.add(m.model);
      } catch {}
    }
  }
  return ids;
}

/** Provider names referenced by models.<job>, in config order, without duplicates. */
function configuredProviders(cfg) {
  return [...new Set(Object.values(cfg.models || {}).map((v) => String(v).split('/')[0]))];
}

/**
 * Health check for every registered provider, not only the configured ones, so setup can offer
 * whatever is installed. `ok` is true when the config parses cleanly and every provider named in
 * models is installed and authenticated.
 */
async function doctorReport(cfg, repo) {
  const errors = configErrors(cfg);
  const providers = {};
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const found = whichBin(p.bin);
    const entry = {
      bin: found || null,
      authenticated: false,
      readOnly: p.readOnly,
      readOnlyStrength: p.readOnlyStrength,
      webAccess: p.webAccess,
      webNote: p.webNote,
      modelCount: 0,
      models: [],
      modelLabels: {},
      warnings: [],
    };
    if (!found) {
      entry.error = `${p.bin} not found on PATH`;
      entry.installHint = p.installHint;
      entry.thenRun = p.loginHint;
      providers[name] = entry;
      continue;
    }
    const list = await p.listModels(providerRunner(p, repo));
    if (list.ok) {
      entry.authenticated = true;
      entry.modelCount = list.models.length;
      entry.models = list.models.map(([id]) => id);
      entry.modelLabels = Object.fromEntries(list.models);
      // Only probed once signed in: the probe is an agent call, and an unauthenticated one
      // blocks on the sign-in prompt.
      if (p.warnings) {
        const w = await p.warnings(providerRunner(p, repo));
        if (w) entry.warnings.push(w);
      }
    } else {
      entry.error = `${p.bin} is not signed in`;
      entry.installHint = p.installHint;
      entry.thenRun = p.loginHint;
      entry.raw = String(list.raw || '')
        .trim()
        .slice(0, 1000);
    }
    providers[name] = entry;
  }
  const ok =
    errors.length === 0 &&
    configuredProviders(cfg).every((n) => Object.hasOwn(providers, n) && providers[n].authenticated);
  return {
    ok,
    stateRoot: ROOT,
    configPath: CONFIG_PATH,
    configExists: existsSync(CONFIG_PATH),
    config: cfg,
    configErrors: errors,
    providers,
  };
}

/**
 * Setup-time only. Refreshes display names for the models each configured provider still offers,
 * keyed by provider then model id. A provider whose list call fails is skipped: its existing
 * sub-table is left untouched and its name is reported, so a signed-out CLI never wipes labels.
 * Never run during a run: two processes writing config is the same class of bug that made runs
 * overwrite each other's packets.
 */
async function syncLabels(cfg, repo) {
  const names = configuredProviders(cfg);
  const onDisk = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const labels = { ...(onDisk.modelLabels || {}) };
  const skipped = [];
  for (const name of names) {
    const p = PROVIDERS[name];
    const list = await p.listModels(providerRunner(p, repo));
    if (!list.ok) {
      skipped.push(name);
      continue;
    }
    const live = Object.fromEntries(list.models);
    const used = new Set();
    for (const value of Object.values(cfg.models || {})) {
      if (String(value).startsWith(`${name}/`)) used.add(String(value).slice(name.length + 1));
    }
    for (const id of modelsUsedByRuns(name)) used.add(id);
    const table = {};
    // Only ids the provider still offers, so the table doesn't accumulate retired models.
    for (const id of used) if (live[id]) table[id] = live[id];
    labels[name] = table;
  }
  onDisk.modelLabels = labels;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(onDisk, null, 2)}\n`);
  return { ok: true, configPath: CONFIG_PATH, providers: names, skipped, labels };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const verb = args._[0];
  const repo = resolve(args.repo || process.cwd());
  resolveRoots();
  const cfg = loadConfig();
  const timeoutSeconds = Number(args.timeout || cfg.timeoutSeconds);

  // --scratch is a boolean, and it is the one flag whose whole job is keeping the repository away
  // from an external model, so a value on it is refused rather than interpreted. Guessing either
  // way is wrong: reading `--scratch=false` as "on" ignores what was typed, and reading it as
  // "off" hands over the repository to someone who asked for isolation.
  if (Object.hasOwn(args, 'scratch') && args.scratch !== true) {
    fail(
      `--scratch takes no value, and "${args.scratch}" was given. Write a bare --scratch to run in a throwaway workspace, or leave the flag out to run in the repository.`,
    );
  }

  // parseArgs accepts any --flag, so `resume --scratch` and `consult --scratch` parsed cleanly and
  // did nothing at all: the user read about the flag, typed it, and got silence.
  // A missing verb falls through to the verb list below, which is the more useful message.
  if (args.scratch && verb && verb !== 'research') {
    fail(`--scratch is not supported by "${verb}"; only research runs in a throwaway workspace`);
  }

  // Doctor's whole job is to report a broken config, so it is the one verb that may load one.
  if (verb !== 'doctor') {
    const errs = configErrors(cfg);
    if (errs.length) fail(errs[0], { configErrors: errs });
  }

  if (verb === 'doctor') {
    const report = await doctorReport(cfg, repo);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (verb === 'sync-labels') {
    const out = await syncLabels(cfg, repo);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  if (verb === 'models') {
    // --provider narrows to one CLI; without it, every provider named in config.
    const names = args.provider && args.provider !== true ? [String(args.provider)] : configuredProviders(cfg);
    let bad = false;
    for (const name of names) {
      process.stdout.write(`# ${name}\n`);
      if (!Object.hasOwn(PROVIDERS, name)) {
        process.stdout.write(`unknown provider "${name}"\n`);
        bad = true;
        continue;
      }
      const p = PROVIDERS[name];
      const list = await p.listModels(providerRunner(p, repo));
      process.stdout.write(`${String(list.raw || '').trim()}\n`);
      if (!list.ok) bad = true;
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }

  if (verb === 'review') {
    if (!isRepo(repo)) fail(`not a git repository: ${repo}`);

    // --pr reviews from a throwaway worktree checked out at the PR head so the agent reads the
    // PR's actual code. Reviewing a PR diff against the local checkout yields confident, wrong
    // findings about call sites the PR did in fact update.
    const pr = args.pr && args.pr !== true ? preparePr(repo, String(args.pr)) : null;
    const reviewRoot = pr ? pr.worktree : repo;

    try {
      const { label, stat, diff, untracked, truncated } = collectDiff(
        reviewRoot,
        pr ? pr.base : args.base === true ? null : args.base,
        cfg.maxDiffBytes,
        pr ? pr.baseLabel : null,
      );
      // Untracked files carry the change when a branch only adds files, which is the normal
      // shape of work that has not been committed yet.
      if (!diff.trim() && !untracked.trim()) {
        const def =
          git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace('origin/', '') || 'main';
        return fail(`no diff found for ${label}. Pass --base <ref> (this repo's default branch looks like "${def}").`);
      }
      const branch = pr
        ? `PR #${pr.number} - ${pr.headRef} (worktree checked out at the PR head)`
        : git(reviewRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      const task =
        args.task && args.task !== true
          ? args.task
          : pr
            ? [pr.title, pr.body].filter(Boolean).join('\n\n')
            : '(none supplied)';
      const body = [
        readPrompt('review'),
        '',
        '---',
        '',
        '## What the author says this change is for',
        '',
        task,
        '',
        '## Repository',
        '',
        `- Path: ${reviewRoot}`,
        `- Branch: ${branch}`,
        `- Diff scope: ${label}`,
        '',
        '## Files changed',
        '',
        '```',
        stat.trim() || '(none)',
        '```',
        untracked
          ? `\n## Untracked files (new files - their contents are not in the diff, open them in the workspace)\n\n\`\`\`\n${untracked}\n\`\`\``
          : '',
        truncated ? `\n> **Truncation notice:** ${truncated}` : '',
        '',
        '## Diff',
        '',
        ...(diff.trim()
          ? ['```diff', diff, '```']
          : ['(No tracked changes. The whole change is the untracked files listed above - read them.)']),
        '',
      ].join('\n');
      const picked = resolveModel(cfg, 'review', args.model);
      return await invoke({
        cfg,
        verb: 'review',
        repo,
        workspace: reviewRoot,
        provider: picked.provider,
        model: picked.model,
        packetBody: body,
        timeoutSeconds,
      });
    } finally {
      if (pr) pr.cleanup();
    }
  }

  if (verb === 'advise') {
    let story;
    let source;
    if (args.context && args.context !== true) {
      if (!existsSync(args.context)) fail(`context file not found: ${args.context}`);
      story = readFileSync(args.context, 'utf8');
      source = { kind: 'context-file', path: args.context };
    } else {
      const found = findTranscript(repo);
      if (!found) {
        return fail(
          'could not locate this session transcript (CLAUDE_CODE_SESSION_ID unset or no transcript file). Pass --context <file> with a written summary instead.',
        );
      }
      const d = distillTranscript(found.path, cfg.maxAdviseBytes);
      if (!d.text.trim()) fail(`transcript at ${found.path} distilled to nothing`);
      story = d.text;
      // A subagent inherits the parent's session id, so auto-detect quietly hands it the parent's
      // conversation and the advice looks plausible while being about someone else's work. There
      // is no reliable way to detect that from inside the process, so name the session loudly and
      // let the caller notice it isn't theirs.
      source = {
        kind: 'transcript',
        path: found.path,
        sessionId: found.sessionId,
        turns: d.total,
        droppedOldestTurns: d.dropped,
        ageSeconds: Math.round((Date.now() - statSync(found.path).mtimeMs) / 1000),
      };
    }

    const question =
      args.question && args.question !== true
        ? args.question
        : 'No specific question - give the agent your general assessment of how this work is going.';
    const body = [
      readPrompt('advise'),
      '',
      '---',
      '',
      '## What the agent wants to know',
      '',
      question,
      '',
      '## Working directory',
      '',
      repo,
      '',
      source.kind === 'transcript' && source.droppedOldestTurns
        ? `> **Note:** the ${source.droppedOldestTurns} oldest turns were dropped to fit; the story below starts mid-task.\n`
        : '',
      '## The story so far',
      '',
      story,
      '',
    ].join('\n');
    const extraMeta = { contextSource: source };
    if (source.kind === 'transcript') {
      extraMeta.contextWarning = `Auto-forwarded the transcript for session ${source.sessionId} (last activity ${source.ageSeconds}s ago). If this is running inside a subagent, that is the PARENT conversation, not your own work - discard this answer and re-run with --context <file>.`;
    }
    const picked = resolveModel(cfg, 'advise', args.model);
    return invoke({
      cfg,
      verb: 'advise',
      repo,
      provider: picked.provider,
      model: picked.model,
      packetBody: body,
      timeoutSeconds,
      extraMeta,
    });
  }

  if (verb === 'consult') {
    const packetFile = args.packet;
    if (!packetFile || packetFile === true) fail('consult requires --packet <file>');
    if (!existsSync(packetFile)) fail(`packet file not found: ${packetFile}`);
    const body = [readPrompt('consult'), '', '---', '', readFileSync(packetFile, 'utf8'), ''].join('\n');
    const picked = resolveModel(cfg, 'consult', args.model);
    return invoke({
      cfg,
      verb: 'consult',
      repo,
      provider: picked.provider,
      model: picked.model,
      packetBody: body,
      timeoutSeconds,
    });
  }

  if (verb === 'research') {
    // A flag with no value parses as `true`. Reading that as "absent" dropped it in silence:
    // `--question q --packet` answered the question and ignored the file the user meant to pass.
    if (args.question === true) fail('research --question was given no text; write --question <text>');
    if (args.packet === true) fail('research --packet was given no file; write --packet <file>');
    const question = args.question ? String(args.question) : null;
    const packetFile = args.packet ? String(args.packet) : null;
    // Exactly one source. Accepting both would silently drop one, and the caller would have no way
    // to tell which question the model actually answered.
    if (question && packetFile) fail('research takes --question or --packet, not both');
    if (!question && !packetFile) fail('research requires --question <text> or --packet <file>');
    if (packetFile && !existsSync(packetFile)) fail(`packet file not found: ${packetFile}`);
    const brief = packetFile ? readFileSync(packetFile, 'utf8') : question;
    // Resolved before the workspace is built: a missing models.research would otherwise create a
    // temp git repo and immediately delete it again.
    const picked = resolveModel(cfg, 'research', args.model);
    // Checked here for the same reason resolveModel is: invoke() checks it too, but only after
    // prepareScratch() has built a temp git repo and deleted it again for nothing, and its message
    // is about a working-tree guard the user never asked for.
    if (args.scratch && isNotRepo(repo)) {
      fail(
        `${repo} is not a git repository, and even --scratch has to be run from inside one. The throwaway workspace is all the model reads, but the repository is still where this run is filed in the history and what the write guard checks afterwards.`,
      );
    }
    // --scratch is for questions that are not about this code. The repo stays the run's durable
    // identity - history bucket and write guard - while the model only ever sees the temp dir.
    const scratch = args.scratch ? prepareScratch() : null;
    try {
      const body = [
        readPrompt('research'),
        '',
        '---',
        '',
        '## The question',
        '',
        brief,
        '',
        '## Workspace',
        '',
        scratch
          ? 'A throwaway empty directory. There is no project here: answer from sources you fetch, not from files.'
          : `The repository at ${repo}. Read it when the question is about this code.`,
        '',
      ].join('\n');
      return await invoke({
        cfg,
        verb: 'research',
        repo,
        workspace: scratch ? scratch.dir : undefined,
        provider: picked.provider,
        model: picked.model,
        packetBody: body,
        timeoutSeconds,
        // Recorded so a later reader of meta.json knows the model never saw the repository.
        // `resume` has no workspace flag, so it cannot reproduce a scratch run.
        extraMeta: scratch ? { scratch: true } : undefined,
      });
    } finally {
      if (scratch) scratch.cleanup();
    }
  }

  if (verb === 'resume') {
    const session = args.session;
    const message = args.message;
    if (!session || session === true) fail('resume requires --session <id>');
    if (!message || message === true) fail('resume requires --message <text>');
    // A session id belongs to the CLI that issued it, so the provider comes from the original
    // run's metadata, never from config.
    const origin = findRunProvider(String(session));
    if (!origin) {
      fail(
        `no run found for session "${session}"; resume only works from the state directory that started it or the run was pruned (keepRuns)`,
      );
    }
    // The throwaway workspace was deleted when the research run ended, and resume passes no
    // workspace, so `ws` would fall back to the repository - the code --scratch existed to keep
    // the model away from. `resume --scratch` is not the answer either: resume never reads that
    // flag, so it would silently do the same thing.
    if (origin.scratch) {
      fail(
        'cannot resume a scratch run; its workspace was deleted and a resume would run in the repository. Start a fresh research --scratch run instead.',
      );
    }
    // No model unless explicitly given: a resumed session keeps the model it started with, so
    // defaulting here would silently answer a review follow-up with the consult model.
    let model = null;
    if (args.model && args.model !== true) {
      const spec = String(args.model);
      if (spec.includes('/')) {
        const picked = splitModel(spec, '--model');
        if (picked.provider !== origin.provider) {
          fail(`--model provider "${picked.provider}" does not match session provider "${origin.provider}"`);
        }
        model = picked.model;
      } else {
        model = spec;
      }
    }
    return invoke({
      cfg,
      verb: 'resume',
      repo,
      provider: origin.provider,
      model,
      packetBody: `${message}\n`,
      timeoutSeconds,
      resume: session,
    });
  }

  fail(`unknown verb "${verb || ''}". Expected: advise | review | consult | research | resume | doctor | models | sync-labels`);
}

main().catch((e) => {
  if (e instanceof Reported) return;
  process.stdout.write(JSON.stringify({ ok: false, error: e.stack || String(e) }, null, 2) + '\n');
  process.exitCode = 1;
});
