/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBootDiagnostics, renderBootFailure } from '../src/lib/boot-failure';

describe('collectBootDiagnostics', () => {
  it('formats an Error using its name + message', () => {
    const diag = collectBootDiagnostics(new TypeError('foo is not a function'));
    expect(diag.message).toBe('TypeError: foo is not a function');
    expect(diag.copyableText.startsWith('TypeError: foo is not a function')).toBe(true);
  });

  it('passes string errors through verbatim', () => {
    expect(collectBootDiagnostics('boom').message).toBe('boom');
  });

  it('handles null and undefined without throwing', () => {
    expect(collectBootDiagnostics(null).message).toBe('Unknown error');
    expect(collectBootDiagnostics(undefined).message).toBe('Unknown error');
  });

  it('JSON-stringifies plain object errors', () => {
    const diag = collectBootDiagnostics({ code: 'EBOOM', detail: 'broken' });
    expect(diag.message).toContain('EBOOM');
    expect(diag.message).toContain('broken');
  });

  it('falls back to String() when JSON.stringify throws (circular)', () => {
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;
    const diag = collectBootDiagnostics(circular);
    // Either the stringify fallback or String(circular) — just confirm it didn't throw.
    expect(typeof diag.message).toBe('string');
    expect(diag.message.length).toBeGreaterThan(0);
  });

  it('includes the stack when the Error has one', () => {
    const err = new Error('explode');
    err.stack = 'Error: explode\n    at someFn (file.ts:1:1)\n    at other (file.ts:2:2)';
    const diag = collectBootDiagnostics(err);
    expect(diag.details).toContain('Stack:');
    expect(diag.details).toContain('at someFn');
    expect(diag.copyableText).toContain('at someFn');
  });

  it('appends every buildInfo entry to the details block', () => {
    const diag = collectBootDiagnostics(new Error('x'), {
      buildInfo: { Runtime: 'electron', Commit: 'abc123', BuildDate: '2026-05-28' },
    });
    expect(diag.details).toContain('Runtime: electron');
    expect(diag.details).toContain('Commit: abc123');
    expect(diag.details).toContain('BuildDate: 2026-05-28');
  });

  it('round-trips the optional hint into the returned diagnostics', () => {
    expect(collectBootDiagnostics(new Error('x'), { hint: 'try a reload' }).hint).toBe(
      'try a reload'
    );
    expect(collectBootDiagnostics(new Error('x')).hint).toBe('');
  });

  it('copyableText starts with the message and then has the details block', () => {
    const diag = collectBootDiagnostics(new Error('hi'), {
      buildInfo: { Foo: 'bar' },
    });
    // The message must appear before the details (the copy contract relied on
    // by the recovery flow puts the headline error first for skimming).
    const messageIdx = diag.copyableText.indexOf(diag.message);
    const detailsIdx = diag.copyableText.indexOf('Foo: bar');
    expect(messageIdx).toBe(0);
    expect(detailsIdx).toBeGreaterThan(messageIdx);
  });

  it('records an ISO timestamp in the details block', () => {
    const diag = collectBootDiagnostics(new Error('x'));
    expect(diag.details).toMatch(/Time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

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

  it('says reloading is the likely fix only when a chunk failed to load', () => {
    renderBootFailure(root, new TypeError('Failed to fetch dynamically imported module: /a.js'));
    expect(root.textContent).toContain('reloading usually fixes this.');

    root.innerHTML = '';
    renderBootFailure(root, new Error('boom'));
    expect(root.textContent).not.toContain('reloading usually fixes this.');
  });

  it('keeps diagnostics folded until asked for', () => {
    renderBootFailure(root, new Error('boom'), { buildInfo: { Runtime: 'electron' } });
    const details = root.querySelector<HTMLPreElement>('#lody-boot-failure-diagnostics')!;
    expect(details.hidden).toBe(true);

    byText('Diagnostics').click();
    expect(details.hidden).toBe(false);
    expect(details.textContent).toContain('Runtime: electron');
  });

  it('confirms a copy on the button itself, then returns to its label', async () => {
    const onCopy = vi.fn();
    renderBootFailure(root, new Error('boom'), { onCopy });

    byText('Copy error').click();
    await vi.waitFor(() => expect(byText('Copied')).toBeDefined());
    expect(writeText.mock.calls[0]?.[0]).toMatch(/^Error: boom\n\n/);
    expect(onCopy).toHaveBeenCalledWith(writeText.mock.calls[0]?.[0]);

    vi.advanceTimersByTime(2000);
    expect(byText('Copy error')).toBeDefined();
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

  it('reloads only when asked, through the caller when it owns reloading', () => {
    const onReload = vi.fn();
    renderBootFailure(root, new Error('boom'), { onReload });
    expect(onReload).not.toHaveBeenCalled();

    byText('Reload').click();
    expect(onReload).toHaveBeenCalledTimes(1);
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

  it('leaves the palette to the OS when the person chose "system"', () => {
    window.localStorage.setItem('vite-ui-theme', 'system');
    renderBootFailure(root, new Error('boom'));
    expect(root.querySelector<HTMLElement>('.lody-boot-failure')!.dataset.theme).toBeUndefined();
  });
});
