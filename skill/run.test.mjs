/**
 * Regression tests for the runner's safeguards. Each one pins a defect found by reviewing this
 * skill with itself, in the order the guards run.
 *
 * No network and no Cursor subscription: `gh` and `cursor-agent` are stub executables placed on
 * PATH, and every repository is a throwaway under the OS temp directory.
 *
 *   node --test .agents/skills/external-advisor/
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

/** Runs the CLI against an isolated state directory and returns its JSON envelope. */
function runCli(args, { home, bin } = {}) {
  const env = { ...process.env, EXTERNAL_ADVISOR_HOME: home };
  if (bin) env.PATH = `${bin}:${process.env.PATH}`;
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
    const dir = tmp('nogit');
    writeFileSync(join(dir, 'q.md'), 'question');

    const out = runCli(['consult', '--repo', dir, '--packet', join(dir, 'q.md')], { home });

    assert.equal(out.ok, false);
    assert.match(out.error, /not a git repository/);
    assert.equal(existsSync(join(home, 'runs')), false, 'must reject before writing a packet');
  });

  it('fails the run when the tree changes while the agent works', () => {
    const home = tmp('home');
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
    const { work, bin } = prFixture({ baseRefName: 'nosuchbase' });

    const out = runCli(['review', '--pr', '1', '--repo', work], { home, bin });

    assert.equal(out.ok, false);
    assert.match(out.error, /refusing to review against a possibly stale base/);
    assert.equal(git(work, 'for-each-ref', 'refs/external-advisor').trim(), '', 'must clean up its refs');
  });
});
