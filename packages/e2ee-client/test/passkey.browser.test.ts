import { build } from 'esbuild';
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

type Fixture = typeof import('./browser/passkey-fixture');
type Surface = typeof globalThis & { PasskeyFixture: Fixture };
const ORIGIN = 'https://vault.lody.ai';

let browser: Browser;
let script: string;
beforeAll(async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL('./browser/passkey-fixture.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'PasskeyFixture',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  script = output.outputFiles[0]!.text.replaceAll('</script', '<\\/script');
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** A page on the real RP origin, served locally, with a CDP virtual authenticator. */
async function page(options: {
  hasPrf: boolean;
}): Promise<{ page: Page; cdp: CDPSession; authenticatorId: string }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const opened = await context.newPage();
  await opened.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>${script}</script>` })
  );
  await opened.goto(`${ORIGIN}/`);
  const cdp = await context.newCDPSession(opened);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: options.hasPrf,
    },
  });
  return { page: opened, cdp, authenticatorId };
}

const run = (target: Page, input: { prfInput: number[] }) =>
  target.evaluate((value) => (globalThis as Surface).PasskeyFixture.run(value), input);

it('registers, then derives the same 32-byte PRF from a known and a discovered credential', async () => {
  const { page: target } = await page({ hasPrf: true });
  const result = await run(target, { prfInput: [1, 2, 3] });
  expect(result.prfEnabled).toBe(true);
  expect(result.credentialId).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(result.knownId).toBe(result.credentialId);
  expect(result.knownPrf).toMatch(/^[0-9a-f]{64}$/);
  expect(result.discoveredPrf).toBe(result.knownPrf);
  expect(result.discoveredHandle).toBe('07'.repeat(32));
  expect(result.userVerified).toBe(true);
  expect(result.registrationAccepted).toBe(true);
  expect(result.assertionAccepted).toBe(true);
  // Another salt gives another output, so the result is the PRF, not a fixed value.
  const other = await run(target, { prfInput: [9] });
  expect(other.knownPrf).not.toBe(result.knownPrf);
});

it('reports a browser without PRF plainly, and the contract refuses it', async () => {
  const { page: target } = await page({ hasPrf: false });
  const result = await run(target, { prfInput: [1, 2, 3] });
  expect(result.prfEnabled).toBe(false);
  expect(result.knownPrf).toBeNull();
  expect(result.registrationAccepted).toBe(false);
  expect(result.assertionAccepted).toBe(false);
});

it('turns a refused system prompt into a cancellation', { timeout: 20_000 }, async () => {
  const { page: target, cdp, authenticatorId } = await page({ hasPrf: true });
  await run(target, { prfInput: [1] });
  // The user declines verification, which the browser reports as NotAllowedError.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  expect(await target.evaluate(() => (globalThis as Surface).PasskeyFixture.available())).toBe(
    true
  );
  expect(await target.evaluate(() => (globalThis as Surface).PasskeyFixture.dismissed())).toMatch(
    /^E2eePasskeyCancelled:/
  );
});
