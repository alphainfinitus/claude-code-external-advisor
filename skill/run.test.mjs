/**
 * Regression tests for the runner's safeguards. Each one pins a defect found by reviewing this
 * skill with itself, in the order the guards run.
 *
 * No network and no Cursor subscription: `gh` and `cursor-agent` are stub executables placed on
 * PATH, and every repository is a throwaway under the OS temp directory.
 *
 *   node --test skill/run.test.mjs
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
import { dirname, join } from 'node:path';
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

/** All three jobs pointed at one cursor model. The value shape is "<provider>/<model>". */
const CURSOR_MODELS = { models: { review: 'cursor/m1', advise: 'cursor/m1', consult: 'cursor/m1' } };

/**
 * Runs the CLI against an isolated state directory and returns its JSON envelope.
 * `omitBin` strips every PATH entry that holds that binary, so a test can prove the
 * not-installed branch even on a machine where the real CLI is installed.
 */
function runCli(args, { home, bin, omitBin } = {}) {
  const env = { ...process.env, EXTERNAL_ADVISOR_HOME: home };
  let path = process.env.PATH || '';
  if (omitBin) {
    path = path
      .split(':')
      .filter((d) => d && !existsSync(join(d, omitBin)))
      .join(':');
  }
  env.PATH = bin ? `${bin}:${path}` : path;
  try {
    return JSON.parse(
      execFileSync(process.execPath, [RUNNER, ...args], {
        cwd: SKILL_DIR,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (e) {
    // A failed run still prints its envelope on stdout before exiting non-zero.
    return JSON.parse(e.stdout || '{}');
  }
}

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
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

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
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

    const out = runCli(['doctor'], { home, bin });

    assert.equal(out.ok, false);
    assert.equal(out.configErrors[0], 'config contains "provider"; remove it and use "<provider>/<model>" in models');
  });

  it('writes model labels keyed by provider then model id', () => {
    const home = tmp('home');
    writeConfig(home, { models: { consult: 'cursor/gpt-5.6-sol-high' } });
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

    const out = runCli(['sync-labels'], { home, bin });

    assert.equal(out.ok, true);
    assert.equal(out.labels.cursor['gpt-5.6-sol-high'], 'GPT-5.6 Sol 1M High');
    const onDisk = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(onDisk.modelLabels.cursor['gpt-5.6-sol-high'], 'GPT-5.6 Sol 1M High');
  });

  it('reports each provider web reach so a research model can be picked knowingly', () => {
    const home = tmp('home');
    writeConfig(home, CURSOR_MODELS);
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

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
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub() });

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
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub({ badConfig: true }) });

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
    const bin = stubBin({ 'cursor-agent': cursorStub({ listFails: true }), agy: agyStub() });

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
    const bin = stubBin({ 'cursor-agent': cursorStub(), agy: agyStub({ argvLog: log, signedOut: true }) });

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
