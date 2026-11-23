import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, selectCiScope } from '../.github/scripts/select-ci-scope.mjs';

const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
export function collectLocalScope({
  root = rootDirectory,
  git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  load = loadWorkspace,
} = {}) {
  try {
    let hasRemote = false;
    try {
      git(['rev-parse', '--verify', '--quiet', 'origin/main']);
      hasRemote = true;
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    const base = hasRemote ? git(['merge-base', 'origin/main', 'HEAD']).trim() : 'HEAD';
    const files = [
      ...new Set(
        [
          ...[[base, 'HEAD'], ['--cached'], []].flatMap((revisions) =>
            git([
              'diff',
              '--name-only',
              '--no-renames',
              '--ignore-submodules=none',
              '-z',
              ...revisions,
              '--',
            ]).split('\0')
          ),
          ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
        ].filter(Boolean)
      ),
    ].sort();
    const workspace = load(root);
    const scope = selectCiScope({ eventName: 'pull_request', baseSha: base, files, workspace });
    const selected = new Set([...scope.testPackages, ...scope.typecheckPackages]);
    const visited = new Set();
    function visit(name) {
      if (visited.has(name)) return;
      visited.add(name);
      for (const dependency of workspace.byName.get(name)?.workspaceDeps ?? []) visit(dependency);
    }
    for (const name of selected) visit(name);
    scope.adapterPackages = [...visited]
      .filter((name) => /^acp-extension-(claude|codex|devin|grok|dsh)$/.test(name))
      .sort();
    return scope;
  } catch (error) {
    return { mode: 'full', reason: `local-scope-failed:${error.code ?? error.name ?? 'unknown'}` };
  }
}
