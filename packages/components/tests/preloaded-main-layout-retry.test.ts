import { expect, it, vi } from 'vitest';

const attempts = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/components/main-layout', () => {
  attempts.count += 1;
  if (attempts.count === 1) throw new Error('chunk fetch failed');
  return { MainLayout: () => null };
});

it('does not cache a failed warm-up, so the real mount retries the import', async () => {
  const { preloadMainLayout } = await import('../src/components/preloaded-main-layout');
  // The login page's idle warm-up, offline.
  await expect(preloadMainLayout()).rejects.toThrow();
  // The post-sign-in mount: a cached rejection would fail here without retrying.
  await expect(preloadMainLayout()).resolves.toHaveProperty('default');
});
