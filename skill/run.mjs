#!/usr/bin/env node
/**
 * external-advisor runner.
 *
 * Invokes an external CLI coding agent in its read-only mode and returns a normalized JSON
 * envelope on stdout. Provider-specific argv lives in PROVIDERS so a
 * second CLI (codex, gemini) can be added without touching run/guard/persistence logic.
 *
 * Usage:
 *   node run.mjs review  [--repo P] [--pr N] [--base REF] [--task STR] [--model M] [--timeout S]
 *   node run.mjs consult  --packet FILE [--repo P] [--model M] [--timeout S]
 *   node run.mjs advise   [--question STR] [--context FILE] [--repo P] [--model M] [--timeout S]
 *   node run.mjs resume   --session ID --message STR [--repo P] [--model M]
 *   node run.mjs sync-labels
 *   node run.mjs doctor
 *   node run.mjs models
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));

// State lives inside the skill directory, next to run.mjs: each installation of the skill carries
// its own config and run history, whether that is ~/.claude/skills/ or a repo's .agents/skills/.
// The repo copy must gitignore config.json and runs/ - being ignored is also what keeps run
// artifacts out of `git status --exclude-standard`, so they cannot trip our own write guard.
let ROOT;
let RUNS;
let CONFIG_PATH;

function resolveRoots() {
  ROOT = process.env.EXTERNAL_ADVISOR_HOME || SKILL_DIR;
  RUNS = join(ROOT, 'runs');
  CONFIG_PATH = join(ROOT, 'config.json');
}

const DEFAULT_CONFIG = {
  timeoutSeconds: 900,
  keepRuns: 20,
  sandbox: true,
  maxDiffBytes: 400000,
  maxAdviseBytes: 160000,
};

/**
 * Provider adapters. This table is the only place that knows a CLI's flags or output format.
 * `buildArgs` must produce a read-only invocation, and it returns the FULL argv including the
 * prompt, because the CLIs disagree about where the prompt goes. `readOnlyStrength` says how
 * strong that guard is: "dispatch" means the CLI refuses the tool call, "prompt" means the model
 * is only told not to write. `parse` returns the normalized {ok, text, sessionId, usage, error},
 * so nothing downstream knows which CLI ran.
 */
const PROVIDERS = {
  cursor: {
    bin: 'cursor-agent',
    installHint: 'curl https://cursor.com/install -fsS | bash',
    loginHint: 'cursor-agent login  (opens a browser; the user must run this themselves)',
    readOnly: '--mode ask',
    readOnlyStrength: 'dispatch',
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
      const res = await run(['-p=/config', '--output-format', 'json']);
      if (res.code !== 0) return null;
      try {
        const lines = res.stdout.trim().split('\n').filter(Boolean);
        // The setting is nested at command.data.config, not command.data.
        const data = JSON.parse(lines[lines.length - 1]).command.data.config;
        if (data && data.toolPermission === 'always-proceed') {
          return 'toolPermission is "always-proceed": agy will auto-approve tool calls in headless runs; plan mode is the only guard';
        }
      } catch {}
      return null;
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
    if (KNOWN_CONFIG_KEYS.has(key)) continue;
    if (key === 'provider') errs.push('config contains "provider"; remove it and use "<provider>/<model>" in models');
    else errs.push(`unknown config key "${key}"; run setup`);
  }
  // A leftover "enabled" string is truthy, so cursor would read it as sandbox on and agy as
  // nothing at all. That is the same half-read failure the provider check exists to stop.
  if (typeof cfg.sandbox !== 'boolean') errs.push('sandbox must be true or false; run setup');
  for (const [job, value] of Object.entries(cfg.models || {})) {
    if (typeof value !== 'string' || !value.includes('/')) {
      errs.push(`models.${job} must be "<provider>/<model>"; run setup`);
      continue;
    }
    const provider = value.slice(0, value.indexOf('/'));
    if (!Object.hasOwn(PROVIDERS, provider)) errs.push(`unknown provider "${provider}" in models.${job}`);
  }
  return errs;
}

/** Splits "<provider>/<model>" on the first slash. `where` names the source in the error. */
function splitModel(value, where) {
  const i = value.indexOf('/');
  if (i < 0) fail(`${where} must be "<provider>/<model>"; run setup`);
  const provider = value.slice(0, i);
  const model = value.slice(i + 1);
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
 * valid on the CLI that created it, so resume must not guess.
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
          return { provider: m.provider, model: m.model };
        }
      } catch {}
    }
  }
  return null;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
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
    return {
      ok: false,
      error: `${provider.bin} exited ${res.code}`,
      raw: (res.stderr || res.stdout).trim().slice(0, 4000),
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
  const worktree = join(tmpdir(), 'external-advisor-worktrees', `pr-${number}-${token}`);
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
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      cleanup();
      process.exit(sig === 'SIGINT' ? 130 : 143);
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
  const treeChanged =
    (guardBefore !== null && guardBefore !== guardAfter) || (wsGuardBefore !== null && wsGuardBefore !== wsGuardAfter);

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
    out.guardViolation =
      'The working tree changed during this run. A read-only advisor must not write. Inspect `git status` before trusting this output.';
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

  if (verb === 'resume') {
    const session = args.session;
    const message = args.message;
    if (!session || session === true) fail('resume requires --session <id>');
    if (!message || message === true) fail('resume requires --message <text>');
    // A session id belongs to the CLI that issued it, so the provider comes from the original
    // run's metadata, never from config.
    const origin = findRunProvider(String(session));
    if (!origin) {
      fail(`no run found for session "${session}"; resume only works from the state directory that started it`);
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

  fail(`unknown verb "${verb || ''}". Expected: advise | review | consult | resume | doctor | models | sync-labels`);
}

main().catch((e) => {
  if (e instanceof Reported) return;
  process.stdout.write(JSON.stringify({ ok: false, error: e.stack || String(e) }, null, 2) + '\n');
  process.exitCode = 1;
});
