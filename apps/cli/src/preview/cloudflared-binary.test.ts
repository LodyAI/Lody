import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureCloudflaredBinary } from './cloudflared-binary';
import notices from './cloudflared-notices.generated.json';

vi.mock('./cloudflared-manifest.json', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('synthetic cloudflared');
  return {
    default: {
      version: 'fixture',
      source: 'https://upstream.test',
      artifacts: {
        'linux-x64': {
          fileName: 'cloudflared-linux-amd64',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          archive: false,
        },
      },
    },
  };
});

vi.mock('./cloudflared-notices.generated.json', () => ({
  default: {
    version: 'fixture',
    source: 'https://upstream.test',
    goVersions: ['go-fixture', 'go-fixture-next'],
    files: [
      { name: 'cloudflared/LICENSE', content: 'Synthetic upstream license\n' },
      { name: 'dependency/NOTICE', content: 'Synthetic dependency notice\n' },
    ],
  },
}));

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});
async function options() {
  const rootDir = await mkdtemp(join(tmpdir(), 'lody-cloudflared-test-'));
  directories.push(rootDir);
  return {
    rootDir,
    platform: 'linux-x64',
    runtimeBaseUrl: 'https://artifacts.test',
    signal: new AbortController().signal,
  };
}

describe('managed cloudflared binary', () => {
  it.each(['version', 'source'] as const)(
    'rejects a bundled notice %s mismatch before downloading',
    async (field) => {
      const config = await options();
      const original = notices[field];
      try {
        notices[field] = 'another-release';
        await expect(ensureCloudflaredBinary(config)).rejects.toThrow(
          'Bundled cloudflared notices do not match the pinned release'
        );
        expect(await readdir(config.rootDir)).toEqual([]);
      } finally {
        notices[field] = original;
      }
    }
  );

  it('installs verified bytes atomically and reuses only a verified cache', async () => {
    const config = await options();
    const command = await ensureCloudflaredBinary({
      ...config,
      fetch: async (url) => {
        expect(String(url)).toBe(
          'https://artifacts.test/api/runtimes/cloudflared/fixture/linux-x64/cloudflared-linux-amd64'
        );
        return new Response('synthetic cloudflared');
      },
    });
    expect(await readFile(command, 'utf8')).toBe('synthetic cloudflared');
    expect((await stat(command)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(dirname(command), 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(
      'cloudflared fixture\nSource: https://upstream.test\nRelease toolchains: go-fixture, go-fixture-next\n\n' +
        '===== cloudflared/LICENSE =====\nSynthetic upstream license\n\n' +
        '===== dependency/NOTICE =====\nSynthetic dependency notice\n'
    );
    expect(await readdir(join(config.rootDir, 'fixture'))).toEqual(['linux-x64']);
    const cached = await ensureCloudflaredBinary({
      ...config,
      fetch: async () => {
        throw new Error('Cache must not download');
      },
    });
    expect(cached).toBe(command);
    await writeFile(command, 'corrupt cache');
    await expect(ensureCloudflaredBinary(config)).rejects.toThrow(
      'Cached cloudflared integrity check failed'
    );
  });

  it.each(['missing', 'modified'])(
    'rejects an installed runtime with %s notices without downloading a replacement',
    async (state) => {
      const config = await options();
      const command = await ensureCloudflaredBinary({
        ...config,
        fetch: async () => new Response('synthetic cloudflared'),
      });
      const file = join(dirname(command), 'THIRD_PARTY_NOTICES.txt');
      if (state === 'missing') await rm(file);
      else await writeFile(file, 'incomplete notices');
      await expect(
        ensureCloudflaredBinary({
          ...config,
          fetch: async () => {
            throw new Error('Must not download over an incomplete existing installation');
          },
        })
      ).rejects.toThrow(state === 'missing' ? 'ENOENT' : 'Cached cloudflared notices');
      expect(await readFile(command, 'utf8')).toBe('synthetic cloudflared');
      expect(await readdir(join(config.rootDir, 'fixture'))).toEqual(['linux-x64']);
    }
  );

  it.each(['synthetic cloudflareX', 'too long to match the pinned artifact size'])(
    'rejects corrupt bytes and removes incomplete downloads: %s',
    async (body) => {
      const config = await options();
      await expect(
        ensureCloudflaredBinary({ ...config, fetch: async () => new Response(body) })
      ).rejects.toThrow(/cloudflared download/);
      expect(await readdir(join(config.rootDir, 'fixture'))).toEqual([]);
    }
  );

  it('aborts a stalled response, cancels its stream and removes scratch files', async () => {
    const config = await options();
    const controller = new AbortController();
    let downloading: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      downloading = resolve;
    });
    let cancelled = false;
    const result = ensureCloudflaredBinary({
      ...config,
      signal: controller.signal,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              downloading();
            },
            cancel() {
              cancelled = true;
            },
          })
        ),
    });
    const rejected = expect(result).rejects.toThrow();
    await started;
    controller.abort(new Error('cancel download'));
    await rejected;
    expect(cancelled).toBe(true);
    expect(await readdir(join(config.rootDir, 'fixture'))).toEqual([]);
  });
});
