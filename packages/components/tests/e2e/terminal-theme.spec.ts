import { expect, test } from '@playwright/test';

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`resolves terminal colors synchronously with ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.route('**/terminal-theme-test', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })
    );
    await page.goto('/terminal-theme-test');

    const themes = await page.evaluate(async () => {
      // Use the real stylesheet and resolver served by Storybook's Vite server.
      const stylesheet = '/src/tailwind/index.css';
      const modulePath = '/src/components/terminal/terminal-theme.ts';
      await import(stylesheet);
      const { buildTerminalTheme } = await import(modulePath);
      const host = document.createElement('div');
      document.body.appendChild(host);
      try {
        return ['#101010', '#ffffff'].map((background) => {
          const foreground = background === '#101010' ? '#ffffff' : '#101010';
          host.style.setProperty('--terminal-background', background);
          host.style.setProperty('--terminal-foreground', foreground);
          host.style.setProperty('--terminal-cursor', foreground);
          host.style.setProperty('--terminal-ansi-red', '#f87171');
          host.style.setProperty('--terminal-ansi-green', '#4ade80');
          host.style.setProperty('--terminal-selection', 'rgba(100, 120, 140, 0.4)');
          return { theme: buildTerminalTheme(host), remainingChildren: host.childElementCount };
        });
      } finally {
        host.remove();
      }
    });

    expect(themes).toMatchObject([
      {
        theme: {
          background: 'rgb(16, 16, 16)',
          foreground: 'rgb(255, 255, 255)',
          cursor: 'rgb(255, 255, 255)',
          red: 'rgb(248, 113, 113)',
          green: 'rgb(74, 222, 128)',
          selectionBackground: 'rgba(100, 120, 140, 0.4)',
        },
        remainingChildren: 0,
      },
      {
        theme: {
          background: 'rgb(255, 255, 255)',
          foreground: 'rgb(16, 16, 16)',
          cursor: 'rgb(16, 16, 16)',
          red: 'rgb(248, 113, 113)',
          green: 'rgb(74, 222, 128)',
          selectionBackground: 'rgba(100, 120, 140, 0.4)',
        },
        remainingChildren: 0,
      },
    ]);
  });
}
