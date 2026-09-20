/**
 * Regression tests for the runner's safeguards. Each one pins a defect found by reviewing this
 * skill with itself, in the order the guards run.
 *
 * No network and no account with any vendor: `gh`, `cursor-agent`, `agy` and `codex` are stub
 * executables placed on PATH, and every repository is a throwaway under the OS temp directory.
 *
 *   node --test run.test.mjs
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(SKILL_DIR, 'run.mjs');

/** A provider that answers without reading anything, so a run reaches the guards and exits. */
const AGENT_OK = `echo '{"type":"result","result":"stub review","session_id":"stub-1"}'`;

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(name) {
  const dir = mkdtempSync(join(tmpdir(), `ea-${name}-`));
  scratch.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  return dir;
}

function commit(dir, file, body, message) {
  writeFileSync(join(dir, file), body);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** Writes an executable stub and returns the bin directory to prepend to PATH. */
function stubBin(stubs) {
  const bin = join(tmp('bin'), 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, script] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }
  return bin;
}

/** DEFAULT_CONFIG carries no models, so every run needs one written into the state directory. */
function writeConfig(home, config) {
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * cursor-agent stub. `--list-models` prints the `id - Label (current)` shape the real CLI uses;
 * anything else answers a run.
 * `argvLog` only ever records `-p` calls, because `--list-models` exits above it. That is what
 * lets a test prove the auth probe made no agent call, and pin the argv of the one that ran.
 */
function cursorStub({ listFails = false, argvLog = '' } = {}) {
  const list = listFails
    ? `echo 'Error: not logged in' >&2; exit 1 ;;`
    : `printf 'gpt-5.6-sol-high - GPT-5.6 Sol 1M High (current)\\ngrok-4.6 - Grok 4.6\\n'; exit 0 ;;`;
  return [
    `case "$1" in`,
    `  --list-models) ${list}`,
    `esac`,
    argvLog ? `case "$1" in\n  -p) echo "$@" >> "${argvLog}" ;;\nesac` : '',
    AGENT_OK,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * agy stub. `models` prints tab-separated `id<TAB>label` and is the auth probe; `-p=/config`
 * answers the settings probe; any other `-p=` answers a run with the agy JSON envelope.
 * `argvLog` only ever records `-p=` calls, because `models` exits above it. That is what lets a
 * test prove doctor made no agent call.
 */
function agyStub({ argvLog = '', conversationId = 'agy-conv-1', signedOut = false, badConfig = false } = {}) {
  const models = signedOut
    ? `echo 'Error: Please sign in to view available models.' >&2; exit 1 ;;`
    : `printf 'gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n'; exit 0 ;;`;
  // The real /config reply nests the setting under command.data.config, not command.data.
  // `badConfig` is a successful reply in a shape the parser cannot read, which is what a CLI
  // upgrade that moves the setting would look like.
  const configReply = badConfig
    ? `{"conversation_id":"","status":"SUCCESS","response":"x"}`
    : `{"conversation_id":"","status":"SUCCESS","response":"config",` +
      `"command":{"name":"config","data":{"config":{"toolPermission":"always-proceed"}}}}`;
  const envelope =
    `{"conversation_id":"${conversationId}","status":"SUCCESS","response":"stub review",` +
    `"duration_seconds":1,"num_turns":1,` +
    `"usage":{"input_tokens":1,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":2}}`;
  return [
    `case "$1" in`,
    `  models) ${models}`,
    `esac`,
    argvLog ? `echo "$@" >> "${argvLog}"` : '',
    `case "$*" in`,
    `  *"-p=/config"*) echo '${configReply}'; exit 0 ;;`,
    `esac`,
    `echo '${envelope}'`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * codex stub. `login status` is the auth probe, `debug models` prints the catalogue, and anything
 * else is `exec` and answers a run with codex's JSONL event stream.
 * `debug models` succeeds even when `signedOut`, because the real one does: it exits 0 signed out
 * and returns a different bundled catalogue. A stub that failed it too would keep passing if the
 * `login status` probe were deleted.
 * Unlike the other two stubs, `argvLog` records EVERY call, and wraps each argv element in
 * brackets - `[-c][model_reasoning_effort="xhigh"]`. Joining argv with spaces cannot tell one
 * element from two, and both the element boundary and the quotes inside a `-c` value are what the
 * codex argv tests are pinning.
 * `messageKey` renames the field the answer arrives under, which is what a codex release that
 * renamed `text` would look like.
 */
function codexStub({
  argvLog = '',
  threadId = 'codex-thread-1',
  signedOut = false,
  messages = ['stub review'],
  messageKey = 'text',
  errorMessage = '',
  turnFailed = '',
  failShape = 'both',
} = {}) {
  // One listed model with two efforts, one listed model with no efforts at all, and one hidden
  // model: the three shapes listModels has to treat differently.
  const catalogue =
    '{"models":[' +
    '{"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","visibility":"list",' +
    '"supported_reasoning_levels":[{"effort":"high","description":"d"},{"effort":"xhigh","description":"d"}]},' +
    '{"slug":"gpt-flat","display_name":"GPT Flat","visibility":"list"},' +
    '{"slug":"gpt-reserve","display_name":"Reserve","visibility":"hide",' +
    '"supported_reasoning_levels":[{"effort":"high"}]}]}';
  const login = signedOut ? `echo 'Not logged in'; exit 1 ;;` : `echo 'Logged in using ChatGPT'; exit 0 ;;`;
  const events = [
    `{"type":"thread.started","thread_id":"${threadId}"}`,
    '{"type":"turn.started"}',
    // The real error item arrives before the answer it silently substituted a model for.
    ...(errorMessage
      ? [`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"${errorMessage}"}}`]
      : []),
    ...messages.map(
      (t, i) =>
        `{"type":"item.completed","item":{"id":"item_${i + 1}","type":"agent_message","${messageKey}":"${t}"}}`,
    ),
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,' +
      '"reasoning_output_tokens":0}}',
  ];
  // A turn codex could not run: the reason arrives on stdout as a top-level event and a
  // turn.failed, the exit code is 1, and stderr carries only the benign stdin line. That last
  // detail is the whole point - a reader who prefers stderr sees the noise and not the reason.
  // `failShape` picks which of the two codex sends. Real codex sends both, so a test using
  // 'both' cannot tell which branch of the parser did the work - hence the single-event shapes.
  const failure = [
    `{"type":"thread.started","thread_id":"${threadId}"}`,
    '{"type":"turn.started"}',
    // The warning that precedes the real failure when a model id is the cause. It must lose to it.
    ...(errorMessage
      ? [`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"${errorMessage}"}}`]
      : []),
    ...(failShape === 'turn' ? [] : [`{"type":"error","message":"${turnFailed}"}`]),
    ...(failShape === 'error' ? [] : [`{"type":"turn.failed","error":{"message":"${turnFailed}"}}`]),
  ];
  return [
    argvLog ? `printf '[%s]' "$@" >> "${argvLog}"; echo >> "${argvLog}"` : '',
    `case "$1 $2" in`,
    `  'login status') ${login}`,
    `  'debug models') echo '${catalogue}'; exit 0 ;;`,
    `esac`,
    ...(turnFailed
      ? [
          ...failure.map((e) => `echo '${e}'`),
          `echo 'Reading additional input from stdin...' >&2`,
          'exit 1',
        ]
      : events.map((e) => `echo '${e}'`)),
  ]
    .filter(Boolean)
    .join('\n');
}

/** All three jobs pointed at one cursor model. The value shape is "<provider>/<model>". */
const CURSOR_MODELS = { models: { review: 'cursor/m1', advise: 'cursor/m1', consult: 'cursor/m1' } };

/**
 * The child's environment, isolated from this process. `omitBin` strips every PATH entry that
 * holds that binary, so a test can prove the not-installed branch even on a machine where the real
 * CLI is installed. `env` adds variables for the child alone - the object below is a fresh copy,
 * so a value hostile to git cannot reach the `git()` and `commit()` helpers, which run here.
 */
function childEnv({ home, bin, omitBin, env: extraEnv } = {}) {
  const env = { ...process.env, EXTERNAL_ADVISOR_HOME: home, ...extraEnv };
  let path = process.env.PATH || '';
  if (omitBin) {
    path = path
      .split(':')
      .filter((d) => d && !existsSync(join(d, omitBin)))
      .join(':');
  }
  env.PATH = bin ? `${bin}:${path}` : path;
  return env;
}

/** Runs the CLI against an isolated state directory and returns its JSON envelope. */
function runCli(args, opts = {}) {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [RUNNER, ...args], {
        cwd: SKILL_DIR,
        encoding: 'utf8',
        env: childEnv(opts),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (e) {
    // A failed run still prints its envelope on stdout before exiting non-zero.
    return JSON.parse(e.stdout || '{}');
  }
}

/** Runs the CLI for its exit status alone: a run killed by a signal prints no envelope to parse. */
function runStatus(args, opts = {}) {
  try {
    execFileSync(process.execPath, [RUNNER, ...args], {
      cwd: SKILL_DIR,
      encoding: 'utf8',
      env: childEnv(opts),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e) {
    return e.status === null ? `killed by ${e.signal}` : e.status;
  }
}

describe('flag forms', () => {
  it('reads --key=value, keeping a value that contains its own separators', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('equals-form'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub(), 'cursor-agent': cursorStub() });

    // parseArgs only split on a space, so the whole of `model=agy/...` became the key and the flag
    // was silently dropped. Splitting on the first `=` alone keeps the slash in the value.
    const out = runCli(['research', '--repo', repo, '--model=agy/gemini-3.1-pro-high', '--question', 'anything'], {
      home,
      bin,
    });

    assert.equal(out.ok, true, out.error);
    assert.equal(out.provider, 'agy', 'the equals form must reach the same flag as the space form');
    assert.equal(out.model, 'gemini-3.1-pro-high', 'the value must survive the slash inside it');
  });

  it('refuses a value on --scratch instead of guessing what it meant', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('scratch-with-value'));
    commit(repo, 'README.md', 'base\n', 'init');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub({ argvLog: log }) });

    // `--scratch=true` used to parse as a key named `scratch=true`, leaving args.scratch undefined:
    // the run handed the repository to the model with no warning and no `scratch` in the envelope.
    // Reading it as "on" now would be a guess, and reading `--scratch=false` as "off" would be the
    // same failure again, so a value is an error either way.
    const out = runCli(['research', '--repo', repo, '--scratch=true', '--question', 'anything'], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /--scratch takes no value/);
    assert.equal(existsSync(log), false, 'the refusal must land before the model is given a workspace');
  });
});

describe('write guard', () => {
  it('refuses to run outside a git repository', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const dir = tmp('nogit');
    writeFileSync(join(dir, 'q.md'), 'question');

    const out = runCli(['consult', '--repo', dir, '--packet', join(dir, 'q.md')], { home });

    assert.equal(out.ok, false);
    assert.match(out.error, /not a git repository/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('fails the run when the tree changes while the agent works', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('guard'));
    commit(repo, 'tracked.txt', 'original\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': `echo tampered >> tracked.txt\n${AGENT_OK}` });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });

    assert.equal(out.treeChanged, true);
    assert.equal(out.ok, false, 'a guard violation must fail the run even though the agent answered');
    assert.match(out.guardViolation, /read-only advisor must not write/);
  });
});

describe('review scope', () => {
  it('reviews a branch whose only change is new untracked files', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('untracked'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    const packet = readFileSync(out.packetPath, 'utf8');
    assert.match(packet, /## Untracked files/);
    assert.match(packet, /added\.js/);
    assert.match(packet, /No tracked changes/);
  });
});

describe('run history', () => {
  it('keeps separate buckets for repositories that share a basename', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    for (const parent of ['one', 'two']) {
      const repo = join(tmp(`slug-${parent}`), 'webapp');
      mkdirSync(repo, { recursive: true });
      initRepo(repo);
      commit(repo, 'f.txt', parent, 'init');
      writeFileSync(join(repo, 'q.md'), 'question');
      const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });
      assert.equal(out.ok, true, out.error);
    }

    const buckets = readdirSync(join(home, 'runs'));
    assert.equal(buckets.length, 2, `expected one bucket per repository, got: ${buckets.join(', ')}`);
  });
});

describe('pull request base', () => {
  /**
   * Builds an origin whose base branch has moved on since the PR was opened, and a clone whose
   * refspec does not cover that branch. `staging` ends at commit A, which the PR also contains,
   * so a review against the fetched base sees only B while one against a stale ref sees A and B.
   */
  function prFixture({ baseRefName = 'staging' } = {}) {
    const origin = join(tmp('origin'), 'origin.git');
    mkdirSync(origin, { recursive: true });
    git(dirname(origin), 'init', '-q', '--bare', 'origin.git');

    const seed = initRepo(tmp('seed'));
    git(seed, 'remote', 'add', 'origin', origin);
    commit(seed, 'base.txt', 'base\n', 'C1');
    git(seed, 'push', '-q', 'origin', 'main');
    git(seed, 'push', '-q', 'origin', 'main:staging');

    git(seed, 'checkout', '-qb', 'feature');
    const a = commit(seed, 'a.txt', 'a\n', 'A');
    commit(seed, 'b.txt', 'b\n', 'B');
    git(seed, 'push', '-q', 'origin', 'feature:refs/pull/1/head');

    // A single-branch clone tracks main only, so nothing here ever refreshes origin/staging.
    const work = join(tmp('work'), 'clone');
    git(dirname(work), 'clone', '-q', '--single-branch', '--branch', 'main', origin, 'clone');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'test');
    git(work, 'fetch', '-q', 'origin', 'staging:refs/remotes/origin/staging');

    // staging advances to A after the clone cached it, leaving the clone's copy stale.
    git(seed, 'push', '-q', 'origin', `${a}:staging`);

    const bin = stubBin({
      gh: `echo '{"number":1,"title":"Stub PR","body":"","headRefName":"feature","baseRefName":"${baseRefName}","state":"OPEN"}'`,
      'cursor-agent': AGENT_OK,
    });
    return { work, bin };
  }

  it('diffs against the fetched base, not a stale remote-tracking ref', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const { work, bin } = prFixture();

    assert.equal(
      git(work, 'rev-parse', 'origin/staging').trim(),
      git(work, 'rev-parse', 'origin/main').trim(),
      'fixture must start with origin/staging stale at C1',
    );

    const out = runCli(['review', '--pr', '1', '--repo', work], { home, bin });

    assert.equal(out.ok, true, out.error);
    const packet = readFileSync(out.packetPath, 'utf8');
    assert.match(packet, /b\.txt/, 'the commit unique to the PR must be in the diff');
    assert.doesNotMatch(packet, /a\.txt/, 'a commit already on the base must not appear as a PR change');
  });

  it('fails when the base branch cannot be fetched', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const { work, bin } = prFixture({ baseRefName: 'nosuchbase' });

    const out = runCli(['review', '--pr', '1', '--repo', work], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /refusing to review against a possibly stale base/);
    assert.equal(git(work, 'for-each-ref', 'refs/external-advisor').trim(), '', 'must clean up its refs');
  });
});

describe('config resolution', () => {
  it('rejects a model with no provider prefix', () => {
    const home = tmp('home');
    writeConfig(home, { models: { consult: 'gemini-x' } });
    const repo = initRepo(tmp('cfg'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'models.consult must be "<provider>/<model>"; run setup');
  });

  it('rejects a model with an empty model half', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'cursor/' } });
    const repo = initRepo(tmp('cfg'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });

    assert.equal(out.ok, false);
    // An empty half would otherwise fall through to the CLI's own default model.
    assert.equal(out.error, 'models.review must be "<provider>/<model>"; run setup');

    // The same rule applies to the flag, which is parsed by splitModel rather than configErrors.
    writeConfig(home, CURSOR_MODELS);
    const flag = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md'), '--model', 'cursor/'], {
      home,
      bin,
    });

    assert.equal(flag.ok, false);
    assert.equal(flag.error, '--model must be "<provider>/<model>"; run setup');
  });

  it('rejects a provider that is not in the table', () => {
    const home = tmp('home');
    writeConfig(home, { models: { consult: 'nope/x' } });
    const repo = initRepo(tmp('cfg'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'unknown provider "nope" in models.consult');
  });

  it('rejects a config that still carries the old provider key', () => {
    const home = tmp('home');
    writeConfig(home, { provider: 'cursor', models: { consult: 'cursor/m1' } });
    const repo = initRepo(tmp('cfg'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'config contains "provider"; remove it and use "<provider>/<model>" in models');
  });

  it('keeps the job provider when --model has no prefix', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('bare'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const out = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md'), '--model', 'other'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const meta = JSON.parse(readFileSync(join(out.runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.provider, 'cursor');
    assert.equal(meta.model, 'other');
  });

  it('resumes with the provider recorded by the original run', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('resume'));
    commit(repo, 'f.txt', 'x\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': AGENT_OK });

    const first = runCli(['consult', '--repo', repo, '--packet', join(repo, 'q.md')], { home, bin });
    assert.equal(first.sessionId, 'stub-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'stub-1', '--message', 'why?'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const meta = JSON.parse(readFileSync(join(out.runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.provider, 'cursor');
  });
});

describe('doctor and labels', () => {
  it('reports every provider, not only the configured one', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    // doctor probes every entry in PROVIDERS, so every provider binary must be stubbed or it
    // would reach a real CLI on the developer's machine.
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.configErrors.length, 0);
    assert.equal(out.providers.cursor.authenticated, true);
    assert.equal(out.providers.cursor.readOnly, '--mode ask');
    assert.equal(out.providers.cursor.readOnlyStrength, 'dispatch');
    assert.equal(out.providers.cursor.modelLabels['gpt-5.6-sol-high'], 'GPT-5.6 Sol 1M High');
    assert.ok(out.providers.cursor.models.includes('grok-4.6'));
  });

  it('reports a stale provider key as a config error instead of crashing', () => {
    const home = tmp('home');
    writeConfig(home, { provider: 'cursor', models: { consult: 'cursor/m1' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.configErrors[0], 'config contains "provider"; remove it and use "<provider>/<model>" in models');
  });

  it('writes model labels keyed by provider then model id', () => {
    const home = tmp('home');
    writeConfig(home, { models: { consult: 'cursor/gpt-5.6-sol-high' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['sync-labels'], { home, bin });

    assert.equal(out.ok, true);
    assert.equal(out.labels.cursor['gpt-5.6-sol-high'], 'GPT-5.6 Sol 1M High');
    const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(onDisk.modelLabels.cursor['gpt-5.6-sol-high'], 'GPT-5.6 Sol 1M High');
  });

  it('creates its state directory when it does not exist yet', () => {
    // A plugin data directory that has never been written to. sync-labels writes config.json
    // with a bare writeFileSync, so without a mkdir it dies on ENOENT before producing output.
    const home = join(tmp('home'), 'data', 'external-advisor');
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['sync-labels'], { home, bin });

    assert.equal(out.ok, true);
    assert.equal(existsSync(join(home, 'config.json')), true);
  });

  it('reports each provider web reach so a research model can be picked knowingly', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.providers.agy.webAccess, 'full');
    assert.equal(out.providers.cursor.webAccess, 'restricted');
    assert.match(out.providers.cursor.webNote, /allow-list/);
    assert.ok(out.providers.agy.webNote.length > 0, 'a bare rating with no measurement is not usable');
  });
});

describe('cursor argv', () => {
  it('sends ask mode, the sandbox flag, and the prompt last', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('cursorargv'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // `--mode ask` is the only layer that makes cursor refuse a write at tool dispatch.
    assert.match(last, /--mode ask/);
    assert.match(last, /--sandbox enabled/);
    // cursor-agent takes the prompt as the last positional argument.
    assert.match(last, /Read the file \S+ in full and follow its instructions exactly\.$/);
  });
});

describe('agy provider', () => {
  it('runs a review through agy and records the provider', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('agy'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ agy: agyStub() });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    assert.equal(out.result, 'stub review');
    assert.equal(out.sessionId, 'agy-conv-1');
    assert.equal(out.provider, 'agy');
    const meta = JSON.parse(readFileSync(join(out.runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.provider, 'agy');
    assert.equal(meta.model, 'gemini-3.1-pro-high');
    assert.equal(meta.usage.total_tokens, 2);
  });

  it('lets --model <provider>/<model> switch provider and model', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('switch'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

    const out = runCli(['review', '--repo', repo, '--model', 'agy/other'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const meta = JSON.parse(readFileSync(join(out.runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.provider, 'agy');
    assert.equal(meta.model, 'other');
  });
});

describe('research', () => {
  it('runs a question through the configured provider and records the verb', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub() });

    const out = runCli(['research', '--repo', repo, '--question', 'what is the current agy release'], {
      home,
      bin,
    });

    assert.equal(out.ok, true, out.error);
    assert.equal(out.verb, 'research');
    assert.equal(out.provider, 'agy');
    const packet = readFileSync(out.packetPath, 'utf8');
    assert.match(packet, /what is the current agy release/, 'the question must reach the packet');
    assert.match(packet, /Every substantive claim you make must carry its source/, 'the research prompt must be prepended');
  });

  it('reads a long brief from --packet', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-packet'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'brief.md'), 'compare these four rate limiters\n');
    const bin = stubBin({ agy: agyStub() });

    const out = runCli(['research', '--repo', repo, '--packet', join(repo, 'brief.md')], { home, bin });

    assert.equal(out.ok, true, out.error);
    assert.match(readFileSync(out.packetPath, 'utf8'), /compare these four rate limiters/);
  });

  it('requires exactly one of --question and --packet', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-args'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'brief.md'), 'brief\n');
    const bin = stubBin({ agy: agyStub() });

    const neither = runCli(['research', '--repo', repo], { home, bin });
    assert.equal(neither.ok, false);
    assert.match(neither.error, /requires --question <text> or --packet <file>/);

    const both = runCli(
      ['research', '--repo', repo, '--question', 'q', '--packet', join(repo, 'brief.md')],
      { home, bin },
    );
    assert.equal(both.ok, false);
    assert.match(both.error, /not both/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('names the job when no research model is configured', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('research-nomodel'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub(), 'cursor-agent': cursorStub() });

    const out = runCli(['research', '--repo', repo, '--question', 'q'], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'no model configured for research; run setup');
  });

  it('runs a scratch question in a throwaway workspace and leaves the repository alone', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('research-scratch'));
    commit(repo, 'README.md', 'base\n', 'init');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub({ argvLog: log }) });

    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });

    assert.equal(out.ok, true, out.error);
    assert.equal(out.treeChanged, false);
    assert.equal(out.scratch, true, 'the envelope must mark the run as scratch');
    const argv = readFileSync(log, 'utf8').trim().split('\n').pop();
    const ws = argv.match(/--workspace (\S+)/)[1];
    assert.notEqual(ws, repo, 'a scratch run must not hand over the repository');
    assert.equal(existsSync(ws), false, 'the scratch workspace must be removed when the run ends');
    assert.match(
      readFileSync(out.packetPath, 'utf8'),
      /There is no project here/,
      'the packet must tell the model there is no project here',
    );
  });

  it('removes the scratch workspace when the run fails', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-scratch-fail'));
    commit(repo, 'README.md', 'base\n', 'init');
    const cwdLog = join(tmp('cwd'), 'cwd.log');
    // The auth probe passes, then the agent call records where it ran and dies. Counting leftover
    // directories instead would pass before --scratch exists, because nothing would be created.
    const bin = stubBin({
      agy: [
        `pwd >> "${cwdLog}"`,
        `case "$1" in`,
        `  models) printf 'gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\n'; exit 0 ;;`,
        `esac`,
        `echo 'agy exploded' >&2; exit 1`,
      ].join('\n'),
    });

    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });

    assert.equal(out.ok, false, 'the run must fail when the provider dies');
    const ws = readFileSync(cwdLog, 'utf8').trim().split('\n').pop();
    assert.match(ws, /external-advisor-scratch/, 'the agent must have run in a scratch workspace');
    assert.equal(existsSync(ws), false, 'a failed run must not leave its workspace behind');
  });

  it('refuses to resume a scratch run, whose follow-up would land in the repository', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('resume-scratch'));
    commit(repo, 'README.md', 'base\n', 'init');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ agy: agyStub({ argvLog: log }) });

    const first = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });
    assert.equal(first.sessionId, 'agy-conv-1', first.error);
    const callsBefore = readFileSync(log, 'utf8').trim().split('\n').length;

    const out = runCli(['resume', '--repo', repo, '--session', 'agy-conv-1', '--message', 'and then?'], {
      home,
      bin,
    });

    assert.equal(out.ok, false);
    assert.match(out.error, /cannot resume a scratch run/);
    // resume passes no workspace, so `ws` falls back to the repository: without the guard the
    // follow-up reads the very code --scratch existed to hide.
    assert.equal(
      readFileSync(log, 'utf8').trim().split('\n').length,
      callsBefore,
      'the refusal must land before the agent is spawned',
    );
  });

  it('still resumes a research run that was not scratch', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('resume-research'));
    commit(repo, 'README.md', 'base\n', 'init');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ agy: agyStub({ argvLog: log }) });

    const first = runCli(['research', '--repo', repo, '--question', 'anything'], { home, bin });
    assert.equal(first.sessionId, 'agy-conv-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'agy-conv-1', '--message', 'and then?'], {
      home,
      bin,
    });

    assert.equal(out.ok, true, out.error);
    assert.match(readFileSync(log, 'utf8').trim().split('\n').pop(), /--conversation agy-conv-1/);
  });

  it('refuses a --packet that was typed with no file', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-bare-packet'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub() });

    // A flag with no value parses as `true`. Read as "absent", this answered the question and
    // silently dropped the --packet the user typed.
    const out = runCli(['research', '--repo', repo, '--question', 'q', '--packet'], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /--packet was given no file/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('fails when --packet names a file that is not there', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-missing-packet'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub() });

    const out = runCli(['research', '--repo', repo, '--packet', join(repo, 'gone.md')], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /packet file not found/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('refuses --scratch on a verb that never reads it', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('scratch-wrong-verb'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'q.md'), 'question');
    const bin = stubBin({ 'cursor-agent': cursorStub() });

    // parseArgs accepts any --flag, so this used to parse cleanly and run in the repository with
    // no hint that the flag did nothing.
    const out = runCli(['consult', '--repo', repo, '--scratch', '--packet', join(repo, 'q.md')], {
      home,
      bin,
    });

    assert.equal(out.ok, false);
    assert.match(out.error, /--scratch is not supported by "consult"/);
    assert.match(out.error, /only research/, 'the refusal must name the verb that does support it');
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('reports a scratch workspace it could not build as a sentence, not a stack trace', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-scratch-broken'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub() });
    // An unparseable global config fails `git init` inside the scratch directory. Left to throw,
    // that reached main()'s catch and the user read a JS stack as the `error` string.
    const gitconfig = join(tmp('gitconfig'), 'gitconfig');
    writeFileSync(gitconfig, '[core\n');

    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], {
      home,
      bin,
      env: { GIT_CONFIG_GLOBAL: gitconfig },
    });

    assert.equal(out.ok, false);
    assert.match(out.error, /could not create the scratch workspace/);
    assert.match(out.error, /bad config line/, "git's own reason must survive into the message");
    assert.doesNotMatch(out.error, /run\.mjs:\d+/, 'a stack frame is not a user-facing error');
  });

  it('commits the scratch workspace through a repo-external hook that always fails', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('research-scratch-hooks'));
    commit(repo, 'README.md', 'base\n', 'init');
    const bin = stubBin({ agy: agyStub() });
    // --no-verify skips pre-commit and commit-msg but not prepare-commit-msg, so a global
    // core.hooksPath failed the scratch commit over someone else's checks. Only the `-c
    // core.hooksPath=/dev/null` in prepareScratch defeats this hook.
    const hooks = join(tmp('hooks'), 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\necho "hostile hook ran" >&2\nexit 1\n');
    chmodSync(join(hooks, 'prepare-commit-msg'), 0o755);
    const gitconfig = join(tmp('gitconfig'), 'gitconfig');
    writeFileSync(gitconfig, `[core]\n\thooksPath = ${hooks}\n`);

    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], {
      home,
      bin,
      env: { GIT_CONFIG_GLOBAL: gitconfig },
    });

    assert.equal(out.ok, true, out.error);
    assert.equal(out.scratch, true, 'the run must still have used a throwaway workspace');
  });

  it('refuses --scratch outside a repository before it builds anything', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const outside = tmp('nogit');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub({ argvLog: log }) });

    // invoke() checks this too, but only after prepareScratch() has created a temp git repo and
    // deleted it again, and it reports a working-tree guard the user never asked for.
    const out = runCli(['research', '--repo', outside, '--scratch', '--question', 'anything'], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /even --scratch has to be run from inside one/);
    assert.equal(existsSync(log), false, 'the refusal must land before any workspace is built');
  });

  it('puts the scratch parent directory under this user alone', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('scratch-parent'));
    commit(repo, 'README.md', 'base\n', 'init');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub({ argvLog: log }) });

    // On Linux tmpdir() is /tmp, shared by every user. One shared parent meant the first user to
    // run owned it and everyone after them got EACCES from mkdir. macOS never showed it, because
    // its tmpdir() is already per-user.
    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const ws = readFileSync(log, 'utf8').trim().split('\n').pop().match(/--workspace (\S+)/)[1];
    assert.equal(
      basename(dirname(ws)),
      `external-advisor-scratch-${process.getuid()}`,
      'the parent must be per-user and still name the skill that created it',
    );
  });

  it('removes the scratch workspace when the terminal hangs up mid-run', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('scratch-sighup'));
    commit(repo, 'README.md', 'base\n', 'init');
    const cwdLog = join(tmp('cwd'), 'cwd.log');
    // SIGHUP had no handler, and Node's default for it is to terminate without running 'exit', so
    // a closed terminal tab or a dropped SSH session left the workspace in the temp dir forever.
    // The stub signals its parent - the runner - and then outlives it.
    const bin = stubBin({
      'cursor-agent': [
        `case "$1" in`,
        `  --list-models) printf 'm1 - M1 (current)\\n'; exit 0 ;;`,
        `esac`,
        `pwd >> "${cwdLog}"`,
        `kill -HUP $PPID`,
        `sleep 10`,
      ].join('\n'),
    });

    const status = runStatus(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });

    const ws = readFileSync(cwdLog, 'utf8').trim().split('\n').pop();
    assert.equal(existsSync(ws), false, 'a hangup must not orphan the throwaway workspace');
    assert.equal(status, 129, 'a signal exit must be 128 + the signal number');
  });

  it('names the throwaway workspace, not the repository, when only it was written to', () => {
    const home = tmp('home');
    writeConfig(home, { models: { research: 'cursor/m1' } });
    const repo = initRepo(tmp('scratch-guard-root'));
    commit(repo, 'README.md', 'base\n', 'init');
    // The stub writes into its own working directory, which is the scratch workspace.
    const bin = stubBin({
      'cursor-agent': [
        `case "$1" in`,
        `  --list-models) printf 'm1 - M1 (current)\\n'; exit 0 ;;`,
        `esac`,
        `echo written > ./from-the-model.txt`,
        AGENT_OK,
      ].join('\n'),
    });

    // treeChanged is the OR of both fingerprints, so it said only that something moved. The
    // repository was clean and the workspace already deleted, leaving nothing to check.
    const out = runCli(['research', '--repo', repo, '--scratch', '--question', 'anything'], { home, bin });

    assert.equal(out.treeChanged, true);
    assert.deepEqual(out.changedRoots.includes(repo), false, 'the repository was not the root that moved');
    assert.match(out.guardViolation, /The throwaway workspace at .* changed/);
  });
});

describe('agy resume', () => {
  it('resumes with --conversation and re-sends plan mode', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('agyresume'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ agy: agyStub({ argvLog: log }) });

    const first = runCli(['review', '--repo', repo], { home, bin });
    assert.equal(first.sessionId, 'agy-conv-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'agy-conv-1', '--message', 'why?'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    // `-p` eats the next token, so the prompt must ride on `-p=` and stay first in the argv.
    assert.match(last.split(' ')[0], /^-p=/);
    assert.match(last, /--conversation agy-conv-1/);
    assert.match(last, /--mode plan/);
  });

  it('resumes on the provider from the run metadata, not the configured one', () => {
    const home = tmp('home');
    // Every job is configured for cursor, so only the original run's metadata can send this
    // resume to agy. A session id is only valid on the CLI that issued it.
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('crossresume'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub({ argvLog: log }) });

    const first = runCli(['review', '--repo', repo, '--model', 'agy/gemini-3.1-pro-high'], { home, bin });
    assert.equal(first.sessionId, 'agy-conv-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'agy-conv-1', '--message', 'why?'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const meta = JSON.parse(readFileSync(join(out.runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.provider, 'agy');
    // The agy stub is the only one that logs, so a --conversation line proves which CLI ran.
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    assert.match(last, /--conversation agy-conv-1/);
  });

  it('fails when agy answers from a different conversation', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('mismatch'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const binOne = stubBin({ agy: agyStub({ conversationId: 'agy-conv-1' }) });
    const binTwo = stubBin({ agy: agyStub({ conversationId: 'agy-conv-2' }) });

    const first = runCli(['review', '--repo', repo], { home, bin: binOne });
    assert.equal(first.sessionId, 'agy-conv-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'agy-conv-1', '--message', 'why?'], {
      home,
      bin: binTwo,
    });

    assert.equal(out.ok, false);
    assert.equal(
      out.error,
      'agy returned conversation agy-conv-2 but agy-conv-1 was requested; the session was not resumed',
    );
  });
});

describe('pre-flight', () => {
  it('reports a missing binary with its install hint, before writing a packet', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const repo = initRepo(tmp('nobin'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    // agy is stubbed so nothing can reach a real CLI; cursor-agent is deliberately absent.
    const bin = stubBin({ gh: 'exit 0', agy: agyStub() });

    const out = runCli(['review', '--repo', repo], { home, bin, omitBin: 'cursor-agent' });

    assert.equal(out.ok, false);
    // Without the pre-flight this is `cursor-agent exited -1` / spawn ENOENT, with no way to fix it.
    assert.equal(out.error, 'cursor-agent not found on PATH');
    assert.ok(out.installHint, 'a missing binary must carry its install hint');
    assert.ok(out.thenRun, 'a missing binary must say what to run after installing');
    assert.equal(existsSync(join(home, 'runs')), false, 'must fail before creating a run directory');
  });

  it('refuses to start a run on a signed-out provider', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const repo = initRepo(tmp('signedout'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ agy: agyStub({ argvLog: log, signedOut: true }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'agy is not signed in');
    assert.ok(String(out.raw || '').trim(), "the CLI's own reason must be forwarded");
    // A `-p` call against a signed-out agy blocks for 60 seconds on the sign-in prompt. The stub
    // logs `-p` calls only, so a missing log file proves the run never made one.
    assert.equal(existsSync(log), false, 'a signed-out provider must never see an agent call');
  });
});

describe('multi-provider reporting', () => {
  it('surfaces the agy tool-permission warning from doctor', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.ok, true);
    assert.equal(out.providers.agy.readOnly, '--mode plan');
    assert.equal(out.providers.agy.readOnlyStrength, 'prompt');
    assert.equal(
      out.providers.agy.warnings[0],
      'toolPermission is "always-proceed": agy will auto-approve tool calls in headless runs; plan mode is the only guard',
    );
    assert.deepEqual(out.providers.cursor.warnings, []);
  });

  it('warns when the agy toolPermission cannot be read at all', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub({ badConfig: true }), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    // Returning nothing here would silently delete the always-proceed safety warning the first
    // time agy changes the shape of its /config reply.
    assert.equal(
      out.providers.agy.warnings[0],
      'could not read agy toolPermission; check ~/.gemini/antigravity-cli/settings.json',
    );
  });

  it('keeps the labels of a provider whose model list cannot be read', () => {
    const home = tmp('home');
    writeConfig(home, {
      models: { review: 'agy/gemini-3.1-pro-high', consult: 'cursor/gpt-5.6-sol-high' },
      modelLabels: { cursor: { 'gpt-5.6-sol-high': 'OLD LABEL' } },
    });
    const bin = stubBin({ 'cursor-agent': cursorStub({ listFails: true }), agy: agyStub(), codex: codexStub() });

    const out = runCli(['sync-labels'], { home, bin });

    assert.deepEqual(out.skipped, ['cursor']);
    assert.equal(out.labels.cursor['gpt-5.6-sol-high'], 'OLD LABEL');
    assert.equal(out.labels.agy['gemini-3.1-pro-high'], 'Gemini 3.1 Pro (High)');
    const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(onDisk.modelLabels.cursor['gpt-5.6-sol-high'], 'OLD LABEL');
  });

  it('never makes an agent call to a signed-out provider', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'agy/gemini-3.1-pro-high' } });
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({
      'cursor-agent': cursorStub(),
      agy: agyStub({ argvLog: log, signedOut: true }),
      codex: codexStub(),
    });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.providers.agy.authenticated, false);
    assert.equal(out.providers.agy.error, 'agy is not signed in');
    assert.deepEqual(out.providers.agy.warnings, []);
    // On a signed-out agy, `-p` blocks for 60 seconds on the sign-in prompt, so warnings must
    // run only after listModels reports signed in. The stub logs `-p` calls and nothing else,
    // so a missing log file proves doctor made no agent call.
    assert.equal(existsSync(log), false, 'doctor must not spawn an agent turn on a signed-out provider');
  });
});

describe('codex argv', () => {
  it('sends the reasoning effort as a -c override with the quotes inside the value', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:xhigh' } });
    const repo = initRepo(tmp('codexeffort'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // The suffix is the effort, not part of the slug, so the id codex is given must be stripped.
    assert.match(last, /\[-m\]\[gpt-5\.6-terra\]/);
    // codex reads a `-c` value as TOML, so the quotes are its string delimiters and must sit
    // inside the one argv element. `[-c][...]` proves it is two elements and not one string.
    assert.match(last, /\[-c\]\[model_reasoning_effort="xhigh"\]/);
  });

  it('sends no reasoning override when the model id carries no effort suffix', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra' } });
    const repo = initRepo(tmp('codexnoeffort'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    assert.match(last, /\[-m\]\[gpt-5\.6-terra\]/);
    // A bare id means codex's own default effort. Inventing one here would answer at a level
    // nobody chose while reporting the model they did.
    assert.equal(last.includes('model_reasoning_effort'), false);
  });

  it('refuses an unknown effort suffix instead of letting codex pick a fallback model', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:turbo' } });
    const repo = initRepo(tmp('codexbadeffort'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /unknown codex reasoning effort "turbo"/);
    // The valid set has to be in the message: codex takes an unknown value, warns, and answers on
    // a fallback model, so there is nothing downstream to learn it from.
    assert.match(out.error, /low, medium, high, xhigh, max, ultra/);
    // The refusal happens before the run directory exists. It used to happen inside buildArgs,
    // after packet.md was written, so every failed run left an orphan with no meta.json - and
    // being the newest, that orphan survived pruning and evicted the history resume reads.
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
    // Nothing spawned at all, so the stub never created its log.
    assert.equal(existsSync(log), false, 'an unknown effort must never reach codex');
  });

  it('refuses an unknown effort given on the command line, not just one in config', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexbadflag'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    // configErrors never sees a --model override, so invoke() is the only guard on this path.
    const out = runCli(['review', '--repo', repo, '--model', 'codex/gpt-5.6-terra:turbo'], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /unknown codex reasoning effort "turbo"/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
    assert.equal(existsSync(log), false, 'an unknown effort must never reach codex');
  });

  it('sends a model id that is only a suffix as -m rather than dropping -m', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/:xhigh' } });
    const repo = initRepo(tmp('codexonlysuffix'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // The stub answers whatever -m it is given, so this run succeeding says nothing about the
    // real CLI; it only proves the argv below is the one that was sent.
    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // The split is `cut > 0`, so an id with nothing before the colon is never split and goes to
    // codex whole. That fails closed: the real codex answers with an error item, which fails the
    // run. `cut >= 0` would leave an empty id, drop -m, and silently run codex's own default.
    assert.match(last, /\[-m\]\[:xhigh\]/);
    assert.equal(last.includes('model_reasoning_effort'), false);
  });

  it('never asks codex for a writable --add-dir, and keeps the read-only flags', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexadddir'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // On codex --add-dir means "additionally WRITABLE", the opposite of what cursor and agy use it
    // for, and codex reads outside its cwd anyway, so passing the run directory buys a write hole
    // and nothing else.
    assert.equal(last.includes('[--add-dir]'), false);
    assert.match(last, /\[-s\]\[read-only\]/);
    assert.match(last, /\[--ignore-user-config\]/);
  });
});

describe('codex resume', () => {
  it('resumes with --all and re-sends the sandbox on -c, the only form resume takes it in', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexresume'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const first = runCli(['review', '--repo', repo], { home, bin });
    assert.equal(first.sessionId, 'codex-thread-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'codex-thread-1', '--message', 'why?'], { home, bin });

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // --all is what finds a thread started from another cwd; `review --pr` deletes its worktree,
    // so a resume never runs from the directory the thread began in.
    assert.match(last, /\[exec\]\[resume\]\[codex-thread-1\]\[--all\]/);
    // `exec resume` rejects -s, -C and --add-dir, so the sandbox has to ride on -c. Sending -s
    // here exits non-zero and the run never happens. The four flags asserted below it does take,
    // so a maintainer reading "-c is all resume accepts" and deleting them would be wrong.
    assert.match(last, /\[-c\]\[sandbox_mode="read-only"\]/);
    assert.match(last, /\[--json\]/);
    assert.match(last, /\[--ignore-user-config\]/);
    assert.match(last, /\[--skip-git-repo-check\]/);
    assert.equal(last.includes('[-s]'), false);
    assert.equal(last.includes('[-C]'), false);
    assert.equal(last.includes('[--add-dir]'), false);
  });

  it('sends -m and the effort on a resume that names a model, the one resume branch that does', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexresumemodel'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const first = runCli(['review', '--repo', repo], { home, bin });
    assert.equal(first.sessionId, 'codex-thread-1', first.error);

    const out = runCli(
      ['resume', '--repo', repo, '--session', 'codex-thread-1', '--message', 'why?', '--model', 'codex/gpt-5.6-luna:max'],
      { home, bin },
    );

    assert.equal(out.ok, true, out.error);
    const last = readFileSync(log, 'utf8').trim().split('\n').pop();
    // A plain resume passes no model, so this branch is the only one that reaches `-m`. Moving
    // that push inside `if (!resume)` - a plausible edit, since resume rejects -s, -C and
    // --add-dir - would silently answer on the session's original model instead of the asked-for
    // one, and every other test would still pass.
    assert.match(last, /\[-m\]\[gpt-5\.6-luna\]/);
    assert.match(last, /\[-c\]\[model_reasoning_effort="max"\]/);
  });

  it("reports codex's own reason for a dead turn, not just its exit code", () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexdead'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    // What a model id the account cannot use actually produced, measured on 0.153.4.
    const api =
      '{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",' +
      '\\"message\\":\\"The gpt-6-astra model is not supported when using Codex with a ChatGPT account.\\"}}';
    const bin = stubBin({ codex: codexStub({ turnFailed: api }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, false);
    // The reason is on stdout and stderr holds only the benign stdin line, so "stderr or nothing"
    // reported `codex exited 1` and threw the 400 away - unactionable for whoever has to fix it.
    assert.match(out.error, /not supported when using Codex with a ChatGPT account/);
    assert.equal(out.error.includes('exited 1'), false, out.error);
    assert.equal(out.raw.includes('Reading additional input from stdin'), false, out.raw);
  });

  it('reads a turn.failed that arrives without a top-level error event', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexturnonly'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ codex: codexStub({ turnFailed: 'the turn died', failShape: 'turn' }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // Real codex sends the top-level `error` event and `turn.failed` together, so a parser that
    // read only the first would look correct forever. Either alone has to carry the reason.
    assert.equal(out.ok, false);
    assert.match(out.error, /the turn died/);
  });

  it('prefers the reason the turn died to the warning that preceded it', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexboth'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    // The real pair: codex warns that it is falling back, then the API refuses the model outright.
    const bin = stubBin({
      codex: codexStub({
        errorMessage: 'Model metadata for gpt-6-astra not found. Defaulting to fallback metadata',
        turnFailed:
          '{\\"error\\":{\\"message\\":\\"The gpt-6-astra model is not supported when using Codex with a ChatGPT account.\\"}}',
      }),
    });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // Reporting the fallback warning tells the reader codex degraded itself; reporting the 400
    // tells them the model id is wrong. Only the second is something they can act on.
    assert.equal(out.error, 'The gpt-6-astra model is not supported when using Codex with a ChatGPT account.', out.error);
  });

  it('unwraps the API JSON codex nests inside a turn.failed message', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexnested'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const api =
      '{\\"type\\":\\"error\\",\\"status\\":429,\\"error\\":{\\"type\\":\\"rate_limit\\",' +
      '\\"message\\":\\"You have hit your usage limit.\\"}}';
    const bin = stubBin({ codex: codexStub({ turnFailed: api }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // codex hands over the API's whole JSON response as a string. Passed through it is a wall of
    // escaped braces; the sentence a human can act on is two levels in.
    assert.equal(out.error, 'You have hit your usage limit.', out.error);
    assert.equal(out.error.includes('rate_limit'), false);
  });

  it('fails when codex answers from a different thread', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexmismatch'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const binOne = stubBin({ codex: codexStub({ threadId: 'codex-thread-1' }) });
    const binTwo = stubBin({ codex: codexStub({ threadId: 'codex-thread-2' }) });

    const first = runCli(['review', '--repo', repo], { home, bin: binOne });
    assert.equal(first.sessionId, 'codex-thread-1', first.error);

    const out = runCli(['resume', '--repo', repo, '--session', 'codex-thread-1', '--message', 'why?'], {
      home,
      bin: binTwo,
    });

    // An unknown resume id exits 1 on codex today rather than starting a fresh thread. This is
    // what would catch the release that changes that, which is exactly how agy loses a
    // conversation: the right answer to the wrong history reads as a plausible one.
    assert.equal(out.ok, false);
    assert.equal(
      out.error,
      'codex returned conversation codex-thread-2 but codex-thread-1 was requested; the session was not resumed',
    );
  });
});

describe('codex output', () => {
  it('keeps every agent_message, not just the last one', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codextwomsg'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ codex: codexStub({ messages: ['first', 'second'] }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    // codex splits one answer into a commentary preamble and the real answer. Keeping only the
    // last drops the half the final message refers back to.
    assert.equal(out.result, 'first\n\nsecond');
  });

  it('fails the run on an error item even when an answer also arrived', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexerritem'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({
      codex: codexStub({ errorMessage: 'Model metadata for no-such-model-xyz not found. Defaulting to fallback' }),
    });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // An unknown model does not fail codex: it reports it here and answers on a fallback model.
    // A plausible answer from a model nobody picked is the same class of bug as agy resuming the
    // wrong conversation, so the answer must not be handed back as a success.
    assert.equal(out.ok, false);
    assert.match(String(out.raw), /Model metadata for no-such-model-xyz not found/);
  });

  it('fails a turn whose agent_message carries no text', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexnotext'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    // The answer arrives under a different key, which is what a codex release that renamed `text`
    // would look like.
    const bin = stubBin({ codex: codexStub({ messageKey: 'message' }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // The item is there but empty. Counting it as an answer would return ok with an empty result:
    // a silent non-answer, which is worse than a failure because nothing downstream can see it.
    assert.equal(out.ok, false);
    assert.match(String(out.raw), /no agent_message with text/);
  });

  it('fails a turn that produced no agent_message at all', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexnomsg'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const bin = stubBin({ codex: codexStub({ messages: [] }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    // No turn.failed event has ever been observed, so a failure shape nobody has seen yet would
    // otherwise come back as a successful empty answer. Absence of an answer is the failure.
    assert.equal(out.ok, false);
    assert.match(String(out.raw), /no agent_message/);
  });
});

describe('codex reporting', () => {
  it('refuses to start a run when codex login status says not signed in', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexsignedout'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log, signedOut: true }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.error, 'codex is not signed in');
    assert.ok(String(out.raw || '').trim(), "the CLI's own reason must be forwarded");
    // A signed-out `codex exec` retries 401 against the API in a loop instead of exiting. The stub
    // logs every call, so the log proves the probe short-circuited: no exec, and no catalogue call
    // either, which is the one `login status` cannot be replaced by.
    const calls = readFileSync(log, 'utf8');
    assert.equal(calls.includes('[exec]'), false, 'a signed-out codex must never see an agent call');
    assert.equal(calls.includes('[debug][models]'), false, 'nothing may run after the auth probe fails');
  });

  it('probes codex auth with login status alone, never the catalogue', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:high' } });
    const repo = initRepo(tmp('codexprobe'));
    commit(repo, 'README.md', 'base\n', 'init');
    writeFileSync(join(repo, 'added.js'), 'export const x = 1\n');
    const log = join(tmp('argv'), 'argv.log');
    const bin = stubBin({ codex: codexStub({ argvLog: log }) });

    const out = runCli(['review', '--repo', repo], { home, bin });

    assert.equal(out.ok, true, out.error);
    // Two spawns, not three. `debug models` answers a yes/no question by pulling a quarter of a
    // megabyte over the network - every catalogue entry carries that model's full system prompt -
    // and a transient failure of that fetch would tell a signed-in user they are signed out.
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2, `expected login status then exec, got:\n${calls.join('\n')}`);
    assert.match(calls[0], /^\[login\]\[status\]$/);
    assert.match(calls[1], /^\[exec\]/);
    assert.equal(calls.join('\n').includes('[debug][models]'), false, 'a run must not fetch the catalogue');
  });

  it('reports an unknown codex effort in the config as a doctor error', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:turbo' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    // doctor used to bless this config, so setup could write a model that failed on every run
    // afterwards. The job name is in the message because doctor reports the whole config at once.
    assert.equal(out.ok, false);
    // The job name is in front, not behind: the message ends in the list of valid efforts, and a
    // trailing "in models.review" reads as the last item of that list.
    assert.match(out.configErrors[0], /^models\.review: unknown codex reasoning effort "turbo"/);
  });

  it('reports codex read-only strength, web reach, and one id per model and effort', () => {
    const home = tmp('home');
    writeConfig(home, { models: { review: 'codex/gpt-5.6-terra:xhigh' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.ok, true, JSON.stringify(out.configErrors));
    assert.equal(out.providers.codex.readOnly, '-s read-only');
    // Stronger than cursor's: an OS sandbox as well as a tool-router refusal. The enum has no
    // value above "dispatch", so that is what it records.
    assert.equal(out.providers.codex.readOnlyStrength, 'dispatch');
    assert.equal(out.providers.codex.webAccess, 'full');
    assert.match(out.providers.codex.webNote, /0\.153\.4/, 'a web rating with no measured version is not usable');
    const ids = out.providers.codex.models;
    assert.ok(ids.includes('gpt-5.6-terra:high') && ids.includes('gpt-5.6-terra:xhigh'), ids.join(','));
    // Never the bare slug of a model that has efforts: picking it would run at codex's default.
    assert.equal(ids.includes('gpt-5.6-terra'), false);
    // A model with no efforts to choose from keeps its bare slug, or it could not be picked at all.
    assert.ok(ids.includes('gpt-flat'), ids.join(','));
    // A hidden model is not offerable, under any id. Exact-match on the bare slug cannot fail:
    // the hidden model has efforts, so dropping the visibility filter emits it as
    // `gpt-reserve:high` and the bare slug is still absent. The prefix is what pins the filter.
    assert.equal(
      ids.some((id) => id.startsWith('gpt-reserve')),
      false,
      ids.join(','),
    );
    assert.equal(out.providers.codex.modelLabels['gpt-5.6-terra:xhigh'], 'GPT-5.6-Terra (xhigh)');
  });

  it('writes codex labels under the suffixed model id, the id a run is configured with', () => {
    const home = tmp('home');
    writeConfig(home, { models: { consult: 'codex/gpt-5.6-terra:xhigh' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub(), codex: codexStub() });

    const out = runCli(['sync-labels'], { home, bin });

    assert.equal(out.ok, true);
    // The effort is part of the configured id, so a label table keyed by the bare slug would never
    // match anything and every codex model would show up unlabelled.
    assert.equal(out.labels.codex['gpt-5.6-terra:xhigh'], 'GPT-5.6-Terra (xhigh)');
    const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(onDisk.modelLabels.codex['gpt-5.6-terra:xhigh'], 'GPT-5.6-Terra (xhigh)');
  });
});
