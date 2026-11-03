/** @vitest-environment jsdom */
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureBootFailedBeacon,
  collectBootDiagnostics,
  renderBootFailure,
} from '../src/lib/boot-failure';

describe('renderBootFailure', () => {
  let root: HTMLDivElement;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buttons(): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll('button'));
  }

  function byText(text: string): HTMLButtonElement {
    const found = buttons().find((button) => button.textContent === text);
    if (!found) throw new Error(`No button "${text}": ${buttons().map((b) => b.textContent)}`);
    return found;
  }

  it('replaces a half-committed tree with the error, the fix first and the build last', () => {
    root.innerHTML = '<main>partial React tree</main>';
    renderBootFailure(root, new Error("Unexpected 'stylex.create' call at runtime."), {
      buildInfo: { Build: 'ff272419', BuildDate: '2026-09-25' },
    });

    expect(root.textContent).not.toContain('partial React tree');
    expect(root.querySelector('h1')?.textContent).toBe("Lody didn't start this time");
    expect(root.querySelector('pre')?.textContent).toBe(
      "Error: Unexpected 'stylex.create' call at runtime."
    );
    expect(buttons().map((button) => button.textContent)).toEqual([
      'Reload',
      'Copy error',
      'Diagnostics',
    ]);
    expect(root.textContent).toContain('Build ff272419 · 2026-09-25');
  });

  it('names the cause and the likely fix only when a chunk failed to load', () => {
    renderBootFailure(root, new TypeError('Failed to fetch dynamically imported module: /a.js'));
    // Lody did start; the title says what actually failed.
    expect(root.querySelector('h1')?.textContent).toBe("Part of Lody didn't load");
    expect(root.textContent).toContain('reloading usually fixes this.');

    root.innerHTML = '';
    renderBootFailure(root, new Error('boom'));
    expect(root.querySelector('h1')?.textContent).toBe("Lody didn't start this time");
    expect(root.textContent).not.toContain('reloading usually fixes this.');
  });

  it('opens the diagnostics for selection when copying is blocked', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    renderBootFailure(root, new Error('boom'));

    byText('Copy error').click();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-role="status"]')?.textContent).toContain('blocked')
    );
    expect(root.querySelector<HTMLPreElement>('#lody-boot-failure-diagnostics')!.hidden).toBe(
      false
    );
    expect(buttons().some((button) => button.textContent === 'Copied')).toBe(false);
  });

  it('follows the stored language and palette, since neither i18n nor the theme has run', () => {
    window.localStorage.setItem('lody-language', JSON.stringify('zh_CN'));
    window.localStorage.setItem('vite-ui-theme', 'dark');
    renderBootFailure(root, new Error('boom'), { surface: 'recovery' });

    const page = root.querySelector<HTMLElement>('.lody-boot-failure')!;
    expect(page.dataset.theme).toBe('dark');
    expect(page.getAttribute('lang')).toBe('zh-CN');
    expect(root.querySelector('h1')?.textContent).toBe('Lody 窗口停下来了');
    expect(buttons()[0]?.textContent).toBe('重新加载');
  });
});

describe('boot failure telemetry boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it('uses fixed error types while preserving local diagnostics', async () => {
    vi.stubEnv('VITE_LODY_PLATFORM', 'cloud');
    vi.stubEnv('VITE_PUBLIC_POSTHOG_KEY', 'synthetic-key');
    vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', 'http://127.0.0.1');
    const bodies: Blob[] = [];
    vi.stubGlobal('navigator', {
      onLine: true,
      sendBeacon: (_url: string, body: Blob) => {
        bodies.push(body);
        return true;
      },
    });
    const error = new Error('PRIVATE_MESSAGE');
    error.name = 'PRIVATE_PATH';
    captureBootFailedBeacon(error);
    expect(bodies).toHaveLength(1);
    const wire = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(bodies[0]!);
    });
    expect(wire).not.toContain('PRIVATE_');
    expect(JSON.parse(wire).properties.error_type).toBe('Error');
    expect(collectBootDiagnostics(error).message).toContain('PRIVATE_MESSAGE');
    vi.stubEnv('VITE_LODY_PLATFORM', 'local');
    captureBootFailedBeacon(error);
    expect(bodies).toHaveLength(1);
  });
});
