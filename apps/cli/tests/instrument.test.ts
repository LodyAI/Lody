import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogInstance = vi.hoisted(() => ({
  captureException: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn(async () => {}),
}));

const PostHogCtor = vi.hoisted(() =>
  vi.fn(function PostHogMock() {
    return posthogInstance;
  })
);

vi.mock('posthog-node', () => ({ PostHog: PostHogCtor }));

// The analytics poster is exercised by its own suite; here we only assert that
// captureMessage is routed to it rather than to the exception client.
const analyticsMock = vi.hoisted(() => ({
  captureCli: vi.fn(),
  flushCliAnalytics: vi.fn(async () => {}),
}));

vi.mock('../src/lib/analytics/posthog', () => analyticsMock);

const originalEnv = { ...process.env };

describe('CLI PostHog error reporting', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setEnv({
      ...originalEnv,
      LODY_PLATFORM: 'cloud',
      LODY_ENV: 'production',
      LODY_POSTHOG_KEY: 'phc_test_key',
      POSTHOG_HOST: 'https://us.i.posthog.com',
    });
  });

  afterEach(() => {
    setEnv(originalEnv);
  });

  it('initializes a PostHog client when a key is present in a non-dev env', async () => {
    const mod = await import('../src/instrument');

    expect(PostHogCtor).toHaveBeenCalledTimes(1);
    expect(PostHogCtor).toHaveBeenCalledWith(
      'phc_test_key',
      expect.objectContaining({ host: 'https://us.i.posthog.com' })
    );
    expect(mod.isErrorReportingEnabled()).toBe(true);
  });

  it('does not initialize a client in dev', async () => {
    process.env.LODY_ENV = 'dev';
    const mod = await import('../src/instrument');

    expect(PostHogCtor).not.toHaveBeenCalled();
    expect(mod.isErrorReportingEnabled()).toBe(false);
  });

  it('routes captureException to the PostHog exception client', async () => {
    const { captureException } = await import('../src/instrument');
    const error = new Error('boom');

    await captureException(error, { component: 'test', extra: { foo: 'bar' } });

    expect(posthogInstance.captureException).toHaveBeenCalledTimes(1);
    const [reported, , properties] = posthogInstance.captureException.mock.calls[0]!;
    expect(reported).toBe(error);
    expect(properties).toMatchObject({ component: 'test', foo: 'bar', platform: 'cli' });
    expect(analyticsMock.captureCli).not.toHaveBeenCalled();
  });

  it('routes captureMessage to a regular analytics event, not an exception', async () => {
    const { captureMessage } = await import('../src/instrument');

    await captureMessage('something slow', { component: 'heartbeat', level: 'error' });

    expect(analyticsMock.captureCli).toHaveBeenCalledWith(
      'cli/diagnostic',
      expect.objectContaining({ message: 'something slow', level: 'error', component: 'heartbeat' })
    );
    expect(posthogInstance.captureException).not.toHaveBeenCalled();
  });
});

function setEnv(nextEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, nextEnv);
}
