// Development/publishing utility. Never runs the app or a model, never reads credentials.
// Git uses the owner's already configured authentication. No force push; main is untouched.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGET = 'https://github.com/ilyasmaxutov/UI-TARS-desktop.git';
export const BRANCH = 'studio/native-ci';
export const BASELINE = '3967b46d7b2e0e4b47ef4bdae98b6c01c415f378';
// Only this reviewed toolchain-only tree may be joined using the source tree.
const STAGING_BLOBS = {
  '.github/workflows/studio-native.yml': '42550444f34cae15459758ea87fe897427eb31da',
  'README.md': 'bded12cb8d5ff09a1824255014bbe695e3905354',
};
function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  if (result.error) throw new Error(`Git could not complete: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return { ...result, stdout: result.stdout.trim() };
}
function assertCleanSource(root, baseline, validateSource) {
  if (validateSource) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'platform-studio') throw new Error('Not the Platform Studio source repository.');
    if (!readFileSync(join(root, '.github/workflows/check.yml'), 'utf8').includes('studio/**')) {
      throw new Error('The publishing branch would not trigger the Studio workflow.');
    }
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']).stdout) {
    throw new Error('Uncommitted changes: publication stopped, nothing was uploaded.');
  }
  const head = git(root, ['rev-parse', 'HEAD']).stdout;
  if (git(root, ['merge-base', '--is-ancestor', baseline, head], true).status !== 0) {
    throw new Error('Source does not preserve the required Studio baseline.');
  }
  return head;
}
function remoteHead(cwd, url, branch) {
  return git(cwd, ['ls-remote', '--refs', url, `refs/heads/${branch}`]).stdout.split(/\s+/)[0] || null;
}
function isStagingTree(cwd, sha, expected) {
  const rows = git(cwd, ['ls-tree', '-r', sha]).stdout.split('\n').filter(Boolean);
  if (rows.length !== Object.keys(expected).length) return false;
  return rows.every(line => {
    const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    return match && expected[match[3]] === match[2];
  });
}
// Exported core allows real bare-repository integration tests without GitHub/network.
// CLI below fixes all destination parameters; local test parameters are not CLI flags.
export function publishRepository({ root, url = TARGET, branch = BRANCH, baseline = BASELINE,
  stagingBlobs = STAGING_BLOBS, validateSource = true, beforePush = () => {}, log = () => {} }) {
  root = resolve(root);
  if (!/^studio\/[a-z0-9][a-z0-9/-]*$/.test(branch)) throw new Error('Only a studio/* branch is allowed.');
  const source = assertCleanSource(root, baseline, validateSource);
  const scratch = mkdtempSync(join(tmpdir(), 'studio-publish-'));
  const checkout = join(scratch, 'checkout');
  try {
    git(scratch, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', root, checkout]);
    git(checkout, ['checkout', '--quiet', '--detach', source]);
    const previous = remoteHead(checkout, url, branch);
    if (previous) {
      git(checkout, ['fetch', '--quiet', '--no-tags', url, `refs/heads/${branch}`]);
      if (git(checkout, ['rev-parse', 'FETCH_HEAD']).stdout !== previous) {
        throw new Error('Remote branch changed during inspection. No push performed.');
      }
      const sourceIsAncestor = git(checkout, ['merge-base', '--is-ancestor', source, previous], true).status === 0;
      if (sourceIsAncestor) {
        return { status: 'already-published', source, remote: previous, branch, pushes: 0 };
      }
      const remoteIsAncestor = git(checkout, ['merge-base', '--is-ancestor', previous, source], true).status === 0;
      if (!remoteIsAncestor) {
        if (!isStagingTree(checkout, previous, stagingBlobs)) {
          throw new Error('Remote contains unrelated or newer work. No merge or force push performed.');
        }
        // Preserve the existing CI-staging ancestry without replacing legacy main.
        git(checkout, ['-c', 'user.name=Platform Studio Publisher', '-c', 'user.email=studio@localhost',
          'merge', '--quiet', '--allow-unrelated-histories', '-s', 'ours',
          '-m', `Import Platform Studio ${source.slice(0, 12)} into dedicated CI branch`, previous]);
      }
    }
    const intended = git(checkout, ['rev-parse', 'HEAD']).stdout;
    beforePush({ checkout, previous, intended });
    log({ phase: 'push', source, intended, branch });
    // One explicit ref, no --force/--mirror/--all and no GITHUB_TOKEN in source or logs.
    const pushed = git(checkout, ['push', '--porcelain', url, `${intended}:refs/heads/${branch}`], true);
    let observed;
    try { observed = remoteHead(checkout, url, branch); }
    catch { throw new Error('Push outcome unknown. Read the remote ref before any retry; no automatic retry occurred.'); }
    if (observed !== intended) {
      throw new Error(`Publication not confirmed (git status ${pushed.status}); remote was not overwritten. ${pushed.stderr.trim()}`);
    }
    return { status: 'published', source, remote: observed, previous, branch, pushes: 1,
      mainModified: false, actions: 'push-triggered; execution not yet observed' };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(x => x !== '--publish')) throw new Error('Usage: node scripts/publish-github.mjs [--publish]');
    const root = resolve(import.meta.dirname, '..');
    const source = assertCleanSource(root, BASELINE, true);
    if (!process.argv.includes('--publish')) {
      console.log(JSON.stringify({ status: 'local-preflight-only', source, target: TARGET, branch: BRANCH,
        next: 'Add --publish for the single authorized push. No network used in preflight.' }, null, 2));
    } else {
      console.log(JSON.stringify(publishRepository({ root }), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
