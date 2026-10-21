import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMarkdownFileLink } from '../src/node/file-link-resolution';
import { resolveFilePreviewPath } from '../src/node/file-preview-path-policy';
import { runCommandTextLegacy } from '../src/node/process';

const scratch: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of scratch.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-links-')));
  scratch.push(temp);
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  const write = (relative: string, content = relative) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const tree = (relative: string) => ({
    root: path.join(root, relative),
    head: 'a'.repeat(40),
    branch: 'refs/heads/feature',
  });
  const resolve = (requestedPath = 'docs/guide.md', trees = [tree('nested')]) =>
    resolveMarkdownFileLink(
      { workspaceRoot: root, requestedPath, extraRoots: [] },
      async () => trees
    );
  return { temp, root, write, tree, resolve };
}

describe('Markdown file link resolution', () => {
  it('finds a unique nested file while canonical preview stays workspace-relative', async () => {
    const f = fixture();
    const file = f.write('nested/docs/guide.md');
    expect(
      resolveFilePreviewPath({ workspaceRoot: f.root, requestedPath: 'docs/guide.md' })
    ).toMatchObject({ ok: false, rejection: { code: 'file_not_found' } });
    const result = await f.resolve();
    expect(result).toMatchObject({
      status: 'resolved-link',
      candidates: [
        { path: 'nested/docs/guide.md', absolutePath: file, branch: 'refs/heads/feature' },
      ],
    });
  });

  it('includes the main checkout in ambiguity and keeps the selected identity stable', async () => {
    const f = fixture();
    f.write('docs/guide.md', 'main');
    f.write('nested/docs/guide.md', 'nested');
    f.write('another/docs/guide.md', 'another');
    const result = await f.resolve('docs/guide.md', [
      f.tree(''),
      f.tree('nested'),
      f.tree('another'),
    ]);
    expect(result.status).toBe('resolved-link');
    if (result.status !== 'resolved-link') throw new Error('Missing candidates');
    expect(result.candidates.map((c) => c.path)).toEqual([
      'docs/guide.md',
      'nested/docs/guide.md',
      'another/docs/guide.md',
    ]);
    const chosen = result.candidates[1];
    if (!chosen) throw new Error('Missing selected candidate');
    f.write('docs/guide.md', 'changed main');
    const preview = resolveFilePreviewPath({ workspaceRoot: f.root, requestedPath: chosen.path });
    expect(preview.ok && fs.readFileSync(preview.resolved.absolutePath, 'utf8')).toBe('nested');
  });

  it('deduplicates real paths and excludes external worktrees and symlink escapes even locally', async () => {
    const f = fixture();
    const file = f.write('nested/docs/guide.md');
    fs.mkdirSync(path.join(f.root, 'alias/docs'), { recursive: true });
    fs.symlinkSync(file, path.join(f.root, 'alias/docs/guide.md'));
    const outside = path.join(f.temp, 'outside');
    fs.mkdirSync(path.join(outside, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'docs/guide.md'), 'external');
    fs.mkdirSync(path.join(f.root, 'escape/docs'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'docs/guide.md'), path.join(f.root, 'escape/docs/guide.md'));
    const result = await resolveMarkdownFileLink(
      {
        workspaceRoot: f.root,
        requestedPath: 'docs/guide.md',
        options: { allowArbitraryPaths: true },
      },
      async () => [
        f.tree('nested'),
        f.tree('alias'),
        f.tree('escape'),
        { ...f.tree(''), root: outside },
      ]
    );
    expect(result).toMatchObject({ status: 'resolved-link', candidates: [{ absolutePath: file }] });
    if (result.status === 'resolved-link') expect(result.candidates).toHaveLength(1);
  });

  it('falls back to the session root when worktree discovery is unavailable', async () => {
    const f = fixture();
    const file = f.write('docs/guide.md');
    f.write('nested/docs/guide.md');
    const result = await resolveMarkdownFileLink(
      { workspaceRoot: f.root, requestedPath: 'docs/guide.md' },
      async () => {
        throw new Error('Git failed');
      }
    );
    expect(result).toMatchObject({ status: 'resolved-link', candidates: [{ absolutePath: file }] });
    if (result.status === 'resolved-link') expect(result.candidates).toHaveLength(1);
  });

  it('falls back for a checkout whose Git metadata is broken', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, '.git'), 'gitdir: /nonexistent\n');
    const file = f.write('docs/guide.md');
    expect(
      await resolveMarkdownFileLink({ workspaceRoot: f.root, requestedPath: 'docs/guide.md' })
    ).toMatchObject({ status: 'resolved-link', candidates: [{ absolutePath: file }] });
  });

  it('retains permission failures instead of selecting the readable main file', async () => {
    const f = fixture();
    f.write('docs/guide.md');
    const nested = f.write('nested/docs/guide.md');
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((target, options) => {
      if (String(target) === nested) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
      return stat(target, options);
    }) as typeof fs.statSync);
    expect(await f.resolve()).toMatchObject({ status: 'error', code: 'permission_denied' });
  });

  it('preserves whitespace and case-tolerant lookup under a nested base', async () => {
    const f = fixture();
    const nested = f.write('nested/docs/Guide.md');
    const result = await f.resolve(' docs/guide.md ');
    expect(result).toMatchObject({
      status: 'resolved-link',
      candidates: [{ absolutePath: nested }],
    });
  });

  it('keeps explicit paths and ordinary non-Git directories independent of discovery', async () => {
    const f = fixture();
    const file = f.write('docs/guide.md');
    const result = await resolveMarkdownFileLink(
      {
        workspaceRoot: path.join(f.root, 'missing'),
        requestedPath: file,
        options: { allowArbitraryPaths: true },
      },
      async () => {
        throw new Error('Must not discover');
      }
    );
    expect(result).toMatchObject({ status: 'resolved-link', candidates: [{ absolutePath: file }] });
    expect(
      await resolveMarkdownFileLink({ workspaceRoot: f.root, requestedPath: 'docs/guide.md' })
    ).toMatchObject({ status: 'resolved-link' });
    expect(await f.resolve('missing.md', [])).toMatchObject({
      status: 'error',
      code: 'file_not_found',
    });
  });

  it('discovers real Git worktrees with spaces and Unicode using NUL-delimited output', async () => {
    const f = fixture();
    const git = (args: string[]) =>
      runCommandTextLegacy({
        command: 'git',
        args: ['-C', f.root, ...args],
        check: 'exit-0',
        timeout: 5_000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
      });
    await git(['init', '-q']);
    await git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'Synthetic fixture',
    ]);
    await git(['worktree', 'add', '--detach', 'nested 工作树', 'HEAD']);
    const file = f.write('nested 工作树/docs/guide.md');
    const result = await resolveMarkdownFileLink({
      workspaceRoot: f.root,
      requestedPath: 'docs/guide.md',
    });
    expect(result).toMatchObject({
      status: 'resolved-link',
      candidates: [
        { absolutePath: file, branch: null, head: expect.stringMatching(/^[a-f0-9]{40,64}$/) },
      ],
    });
  });
});
