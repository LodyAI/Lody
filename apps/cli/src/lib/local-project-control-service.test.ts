import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import { LocalProjectControlService } from './local-project-control-service';
import type { Logger } from '../utils/logger';

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(),
    close: vi.fn(),
  } as unknown as Logger;
}

async function createTempProject(): Promise<string> {
  // Resolve symlinks (e.g. macOS /var -> /private/var) so the scanner's
  // realpath-based `absolutePath` matches paths the tests build from this root.
  return await realpath(await mkdtemp(join(tmpdir(), 'lody-local-project-')));
}

async function createDirectorySymlink(targetPath: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, 'dir');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return false;
    }
    throw error;
  }
}

describe('LocalProjectControlService file browsing security', () => {
  it('blocks direct .git directory browsing and file reads', async () => {
    const rootPath = await createTempProject();
    try {
      await mkdir(join(rootPath, '.git'), { recursive: true });
      await writeFile(join(rootPath, '.git', 'config'), '[remote "origin"]\n');

      const service = new LocalProjectControlService(createLogger());

      await expect(service.listProjectDirectory(rootPath, '.git')).rejects.toThrow(
        'Project directory is not browsable.'
      );
      expect(service.readProjectFile(rootPath, '.git/config')).toBeNull();

      const rootList = await service.listProjectDirectory(rootPath, '');
      expect(rootList.entries.map((entry) => entry.name)).not.toContain('.git');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('blocks direct reads of gitignored files', async () => {
    const rootPath = await createTempProject();
    try {
      await writeFile(join(rootPath, '.gitignore'), '.env\n');
      await writeFile(join(rootPath, '.env'), 'SECRET=value\n');

      const service = new LocalProjectControlService(createLogger());

      expect(service.readProjectFile(rootPath, '.env')).toBeNull();

      const rootList = await service.listProjectDirectory(rootPath, '');
      expect(rootList.entries.map((entry) => entry.name)).not.toContain('.env');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects symlink directory browsing outside the project root', async () => {
    const rootPath = await createTempProject();
    const outsidePath = await createTempProject();
    try {
      await writeFile(join(outsidePath, 'secret.txt'), 'outside\n');
      const symlinkCreated = await createDirectorySymlink(outsidePath, join(rootPath, 'outside'));
      if (!symlinkCreated) {
        return;
      }

      const service = new LocalProjectControlService(createLogger());

      await expect(service.listProjectDirectory(rootPath, 'outside')).rejects.toThrow(
        'Project directory path escapes project root.'
      );

      const rootList = await service.listProjectDirectory(rootPath, '');
      expect(rootList.entries.map((entry) => entry.name)).not.toContain('outside');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });
});

describe('LocalProjectControlService project skills', () => {
  it('lists direct child skills and root SKILL.md files by group', async () => {
    const rootPath = await createTempProject();
    try {
      await mkdir(join(rootPath, '.agents', 'skills', 'review'), { recursive: true });
      await mkdir(join(rootPath, '.claude', 'skills'), { recursive: true });
      await writeFile(
        join(rootPath, '.agents', 'skills', 'review', 'SKILL.md'),
        `---
name: Review Bot
description: Checks diffs
version: 1.0.0
author: Lody
---
# Review
`
      );
      await writeFile(
        join(rootPath, '.claude', 'skills', 'SKILL.md'),
        `---
name: Claude Root
metadata:
  version: 2.0.0
  author: Claude Team
---
# Claude
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listProjectSkills(rootPath, [
        '.agents/skills',
        '.claude/skills',
        '.qwen/skills',
      ]);

      expect(result.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.groups.map((group) => group.dir)).toEqual(['.agents/skills', '.claude/skills']);
      expect(result.groups.map((group) => group.scope)).toEqual(['project', 'project']);
      expect(result.groups[0]?.skills).toEqual([
        {
          id: '.agents/skills/review',
          name: 'Review Bot',
          description: 'Checks diffs',
          version: '1.0.0',
          author: 'Lody',
          relativePath: '.agents/skills/review/SKILL.md',
          isSymlink: false,
          content: '# Review',
        },
      ]);
      expect(result.groups[1]?.skills[0]).toMatchObject({
        id: '.claude/skills/SKILL.md',
        name: 'Claude Root',
        version: '2.0.0',
        author: 'Claude Team',
        relativePath: '.claude/skills/SKILL.md',
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('follows in-project symlinked skill directories and lists every duplicate entry', async () => {
    const rootPath = await createTempProject();
    try {
      await mkdir(join(rootPath, '.agents', 'skills', 'review'), { recursive: true });
      await mkdir(join(rootPath, '.claude'), { recursive: true });
      await writeFile(
        join(rootPath, '.agents', 'skills', 'review', 'SKILL.md'),
        `---
name: Review Bot
description: Checks diffs
---
`
      );
      const groupSymlinkCreated = await createDirectorySymlink(
        join(rootPath, '.agents', 'skills'),
        join(rootPath, '.claude', 'skills')
      );
      const duplicateSymlinkCreated = await createDirectorySymlink(
        join(rootPath, '.agents', 'skills', 'review'),
        join(rootPath, '.agents', 'skills', 'review-alias')
      );
      if (!groupSymlinkCreated || !duplicateSymlinkCreated) {
        return;
      }

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listProjectSkills(rootPath, [
        '.agents/skills',
        '.claude/skills',
      ]);

      const agentsGroup = result.groups.find((group) => group.dir === '.agents/skills');
      const claudeGroup = result.groups.find((group) => group.dir === '.claude/skills');

      // Both the real skill and its in-repo symlink alias are listed (no dedup):
      // duplicates and symlinks are surfaced so the UI shows every entry.
      expect(agentsGroup?.skills).toHaveLength(2);
      const realSkill = agentsGroup?.skills.find(
        (skill) => skill.relativePath === '.agents/skills/review/SKILL.md'
      );
      const aliasSkill = agentsGroup?.skills.find(
        (skill) => skill.relativePath === '.agents/skills/review-alias/SKILL.md'
      );
      expect(realSkill).toMatchObject({ isSymlink: false });
      expect(aliasSkill).toMatchObject({
        isSymlink: true,
        symlinkTarget: '.agents/skills/review',
      });

      // The whole group is also reachable through the .claude/skills symlink.
      expect(claudeGroup?.skills).toHaveLength(2);
      expect(claudeGroup?.skills.map((skill) => skill.relativePath).sort()).toEqual([
        '.claude/skills/review-alias/SKILL.md',
        '.claude/skills/review/SKILL.md',
      ]);
      for (const skill of claudeGroup?.skills ?? []) {
        expect(skill.isSymlink).toBe(true);
      }
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('skips dangling skill symlinks as missing entries', async () => {
    const rootPath = await createTempProject();
    try {
      await mkdir(join(rootPath, '.agents', 'skills', 'review'), { recursive: true });
      await mkdir(join(rootPath, '.gemini', 'skills', 'writer'), { recursive: true });
      await mkdir(join(rootPath, '.broken'), { recursive: true });
      await writeFile(
        join(rootPath, '.agents', 'skills', 'review', 'SKILL.md'),
        'name: Review Bot\n'
      );
      await writeFile(join(rootPath, '.gemini', 'skills', 'writer', 'SKILL.md'), 'name: Writer\n');

      const childSymlinkCreated = await createDirectorySymlink(
        join(rootPath, '.agents', 'skills', 'missing'),
        join(rootPath, '.gemini', 'skills', 'web-design-guidelines')
      );
      const groupSymlinkCreated = await createDirectorySymlink(
        join(rootPath, '.agents', 'missing-skills'),
        join(rootPath, '.broken', 'skills')
      );
      if (!childSymlinkCreated || !groupSymlinkCreated) {
        return;
      }

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listProjectSkills(rootPath, [
        '.agents/skills',
        '.gemini/skills',
        '.broken/skills',
      ]);

      expect(result.groups.map((group) => group.dir)).toEqual(['.agents/skills', '.gemini/skills']);
      expect(result.groups[1]?.skills.map((skill) => skill.relativePath)).toEqual([
        '.gemini/skills/writer/SKILL.md',
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('skips skill symlinks that resolve outside the project root', async () => {
    const rootPath = await createTempProject();
    const outsidePath = await createTempProject();
    try {
      await mkdir(join(rootPath, '.agents', 'skills'), { recursive: true });
      await mkdir(join(outsidePath, 'external-skill'), { recursive: true });
      await writeFile(join(outsidePath, 'external-skill', 'SKILL.md'), 'name: outside\n');
      const symlinkCreated = await createDirectorySymlink(
        join(outsidePath, 'external-skill'),
        join(rootPath, '.agents', 'skills', 'external')
      );
      if (!symlinkCreated) {
        return;
      }

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listProjectSkills(rootPath, ['.agents/skills']);

      expect(result.groups).toEqual([
        {
          scope: 'project',
          dir: '.agents/skills',
          skills: [],
          truncated: false,
          skippedExternalSymlinks: 1,
        },
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('lists current-user global skills using home-relative paths', async () => {
    const homePath = await createTempProject();
    try {
      await mkdir(join(homePath, '.agents', 'skills', 'pr-writer'), { recursive: true });
      await writeFile(
        join(homePath, '.agents', 'skills', 'pr-writer', 'SKILL.md'),
        `---
name: pr-writer
description: Writes PR summaries
---
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.groups).toEqual([
        {
          scope: 'global',
          dir: '~/.agents/skills',
          skills: [
            {
              id: '~/.agents/skills/pr-writer',
              name: 'pr-writer',
              description: 'Writes PR summaries',
              relativePath: '~/.agents/skills/pr-writer/SKILL.md',
              absolutePath: join(homePath, '.agents', 'skills', 'pr-writer', 'SKILL.md'),
              isSymlink: false,
            },
          ],
          truncated: false,
        },
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('lists current-user global skills in catalog-layout subdirectories', async () => {
    const homePath = await createTempProject();
    try {
      await mkdir(join(homePath, '.agents', 'skills', '.system', 'imagegen'), { recursive: true });
      await writeFile(
        join(homePath, '.agents', 'skills', '.system', 'imagegen', 'SKILL.md'),
        `---
name: imagegen
description: Generates images
---
`
      );
      await mkdir(join(homePath, '.agents', 'skills', 'catalog', 'ignored'), {
        recursive: true,
      });
      await writeFile(
        join(homePath, '.agents', 'skills', 'catalog', 'SKILL.md'),
        `---
name: catalog-skill
description: Shadows nested skills
---
`
      );
      await writeFile(
        join(homePath, '.agents', 'skills', 'catalog', 'ignored', 'SKILL.md'),
        `---
name: ignored
---
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.groups).toEqual([
        {
          scope: 'global',
          dir: '~/.agents/skills',
          skills: [
            {
              id: '~/.agents/skills/catalog',
              name: 'catalog-skill',
              description: 'Shadows nested skills',
              relativePath: '~/.agents/skills/catalog/SKILL.md',
              absolutePath: join(homePath, '.agents', 'skills', 'catalog', 'SKILL.md'),
              isSymlink: false,
            },
            {
              id: '~/.agents/skills/imagegen',
              name: 'imagegen',
              description: 'Generates images',
              relativePath: '~/.agents/skills/.system/imagegen/SKILL.md',
              absolutePath: join(homePath, '.agents', 'skills', '.system', 'imagegen', 'SKILL.md'),
              isSymlink: false,
            },
          ],
          truncated: false,
        },
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('lists codex built-in system skills under the system scope', async () => {
    const homePath = await createTempProject();
    try {
      await mkdir(join(homePath, '.codex', 'skills', '.system', 'imagegen'), { recursive: true });
      await writeFile(
        join(homePath, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
        `---
name: imagegen
description: Generates images
---
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.groups).toEqual([
        {
          scope: 'system',
          dir: '~/.codex/skills/.system',
          skills: [
            {
              id: '~/.codex/skills/.system/imagegen',
              name: 'imagegen',
              description: 'Generates images',
              relativePath: '~/.codex/skills/.system/imagegen/SKILL.md',
              absolutePath: join(homePath, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
              isSymlink: false,
            },
          ],
          truncated: false,
        },
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('returns global and system skills together from one home scan', async () => {
    const homePath = await createTempProject();
    try {
      await mkdir(join(homePath, '.agents', 'skills', 'pr-writer'), { recursive: true });
      await writeFile(
        join(homePath, '.agents', 'skills', 'pr-writer', 'SKILL.md'),
        `---
name: pr-writer
---
`
      );
      await mkdir(join(homePath, '.codex', 'skills', '.system', 'imagegen'), { recursive: true });
      await writeFile(
        join(homePath, '.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
        `---
name: imagegen
---
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.groups.map((group) => ({ scope: group.scope, dir: group.dir }))).toEqual([
        { scope: 'global', dir: '~/.agents/skills' },
        { scope: 'system', dir: '~/.codex/skills/.system' },
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('does not scan arbitrary home-relative directories for global skills', async () => {
    const homePath = await createTempProject();
    try {
      await mkdir(join(homePath, 'Documents', 'private-skill'), { recursive: true });
      await writeFile(
        join(homePath, 'Documents', 'private-skill', 'SKILL.md'),
        `---
name: private-skill
---
Secret notes
`
      );

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.groups).toEqual([]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it('skips global skill symlinks that resolve outside the user home', async () => {
    const homePath = await createTempProject();
    const outsidePath = await createTempProject();
    try {
      await mkdir(join(homePath, '.agents', 'skills'), { recursive: true });
      await mkdir(join(outsidePath, 'external-skill'), { recursive: true });
      await writeFile(join(outsidePath, 'external-skill', 'SKILL.md'), 'name: outside\n');
      const symlinkCreated = await createDirectorySymlink(
        join(outsidePath, 'external-skill'),
        join(homePath, '.agents', 'skills', 'external')
      );
      if (!symlinkCreated) {
        return;
      }

      const service = new LocalProjectControlService(createLogger());
      const result = await service.listGlobalSkills({ homePath });

      expect(result.groups).toEqual([
        {
          scope: 'global',
          dir: '~/.agents/skills',
          skills: [],
          truncated: false,
          skippedExternalSymlinks: 1,
        },
      ]);
    } finally {
      await rm(homePath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });
});

describe('LocalProjectControlService image reads', () => {
  // A 1x1 PNG: its bytes are not valid UTF-8, so a text decode would corrupt
  // them. Reading it must round-trip exactly through the base64 encoding.
  const pngBytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
      '9c620001000005000100d10a2db40000000049454e44ae426082',
    'hex'
  );

  it('returns image files as base64-encoded bytes that round-trip exactly', async () => {
    const rootPath = await createTempProject();
    try {
      await writeFile(join(rootPath, 'logo.png'), pngBytes);

      const service = new LocalProjectControlService(createLogger());
      const result = service.readProjectFile(rootPath, 'logo.png');

      expect(result).not.toBeNull();
      expect(result?.encoding).toBe('base64');
      expect(result?.truncated).toBe(false);
      expect(Buffer.from(result?.content ?? '', 'base64').equals(pngBytes)).toBe(true);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('reads text files as utf8, even with image-like extensions handled as text (svg)', async () => {
    const rootPath = await createTempProject();
    try {
      await writeFile(join(rootPath, 'notes.md'), '# Hello\n');
      await writeFile(join(rootPath, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

      const service = new LocalProjectControlService(createLogger());

      // Backward compat: text reads must omit `encoding` entirely so older
      // `.strict()`-schema clients keep accepting the payload under version skew.
      const text = service.readProjectFile(rootPath, 'notes.md');
      expect(text?.encoding).toBeUndefined();
      expect(text && 'encoding' in text).toBe(false);
      expect(text?.content).toBe('# Hello\n');

      // SVG is XML text, so it stays text rather than base64 binary.
      const svg = service.readProjectFile(rootPath, 'icon.svg');
      expect(svg?.encoding).toBeUndefined();
      expect(svg?.content).toContain('<svg');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('marks oversized images truncated so callers can skip a partial blob', async () => {
    const rootPath = await createTempProject();
    try {
      const big = Buffer.concat([pngBytes, Buffer.alloc(64, 0)]);
      await writeFile(join(rootPath, 'big.png'), big);

      const service = new LocalProjectControlService(createLogger());
      const result = service.readProjectFile(rootPath, 'big.png', { maxBytes: 16 });

      expect(result?.encoding).toBe('base64');
      expect(result?.truncated).toBe(true);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
