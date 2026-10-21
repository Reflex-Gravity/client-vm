// SPDX-License-Identifier: Apache-2.0
// `git` (isomorphic-git, fetched on first use) diffed against the host's real
// git: the same steps run in both, and stdout and exit codes must match.
// Fixed author/committer dates make commit ids comparable too.
import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { host, openHost } from './sandbox.ts';

const ENV =
  "export GIT_AUTHOR_DATE='2024-01-01T00:00:00Z' GIT_COMMITTER_DATE='2024-01-01T00:00:00Z'; ";

// Each step runs from the repository root; earlier steps' effects persist.
const STEPS = [
  'git init -q -b main . && git config user.name T && git config user.email t@e.x',
  'echo hello > a.txt && mkdir -p d/e && echo x > d/b.txt && echo y > d/e/c.txt && git status',
  'git status --short',
  'git add -A && git status',
  'git commit -m first',
  'git log --oneline',
  'git log',
  'echo more >> a.txt && rm d/b.txt && echo new > n.txt && git status --short',
  'git diff',
  'git diff --stat',
  'git add a.txt && git diff --staged',
  'git diff --name-only HEAD',
  'cd d && git status',
  'git commit -am second',
  'git log --format="%H %an <%ae> %s"',
  'git show --stat HEAD',
  'git show HEAD~1 --name-only',
  'git branch feat && git branch',
  'git checkout -q feat && echo f > f.txt && git add f.txt && git commit -q -m feat && git rev-parse HEAD',
  'git checkout -q main && git merge feat',
  'git ls-files',
  'git tag v1 && git tag && git rev-parse v1',
  'git rm -q n.txt && git mv a.txt b.txt && git status --short',
  'git commit -q -m moves && git log --oneline -n 2',
  'echo dirty >> b.txt && git restore b.txt && git status --short',
  'git reset -q --hard HEAD~1 && git log --oneline && git ls-files',
  'git diff HEAD~2 HEAD --stat',
  'git rev-parse --abbrev-ref HEAD && git rev-parse --show-toplevel | sed "s|.*/||"',
  'git log --oneline nope; echo "exit $?"',
  'git checkout -q -b topic && git branch && git switch -q main',
  'echo s >> a.txt && git stash -q && git status --short && git stash pop -q && git status --short',
  'git checkout -q -- a.txt && git checkout -q topic && echo t > t.txt && git add t.txt && git commit -q -m t && git checkout -q main',
  'echo m > m.txt && git add m.txt && git commit -q -m m && git merge --no-ff -m "merge topic" topic && git log --format=%s',
  'git checkout -q -b c1 && echo one > a.txt && git commit -qam one && git checkout -q main && echo two > a.txt && git commit -qam two',
  'git merge c1; echo "exit $?"',
  'cat a.txt; git status --short',
  'echo resolved > a.txt && git add a.txt && git commit -q --no-edit && git log --format="%s|%P" -n 1 | sed "s/|.*//"',
  'git log --format=%H -n 1 && git cat-file -p HEAD 2>/dev/null | grep -c ^parent; true',
  'git cat-file -p "HEAD^{tree}" && git cat-file -t HEAD:d && git cat-file -s HEAD && git show HEAD:d/e/c.txt',
  'git cat-file -e HEAD:nope; echo "exit $?"',
];

function hostGit(): boolean {
  return spawnSync('git', ['--version']).status === 0;
}

test('git matches host git', async ({ page }) => {
  test.skip(!hostGit(), 'host git not installed');
  test.setTimeout(180_000);
  await openHost(page);
  const id = await host(page, 'createInstance');
  await host(page, 'exec', id, 'mkdir -p /home/user/repo');

  const dir = mkdtempSync(join(tmpdir(), 'clientvm-git-'));
  const repo = join(dir, 'repo');
  execFileSync('mkdir', ['-p', repo]);
  try {
    for (const step of STEPS) {
      const real = spawnSync('bash', ['-c', ENV + step], {
        cwd: repo,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' },
      });
      const ours = await host(page, 'exec', id, ENV + step, {
        cwd: '/home/user/repo',
        timeoutMs: 60_000,
      });
      expect.soft(ours.stdout, step).toBe(real.stdout);
      expect.soft(ours.code, `${step}\n${ours.stderr}`).toBe(real.status);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
