import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { BOOT_SHELL_CSS, BOOT_SHELL_MARKUP } from './src/lib/boot-shell';
import { createBootShellScript } from './src/lib/boot-shell-script';

/**
 * Paints the boot shell (`src/lib/boot-shell.ts`) in the document's first
 * frame, before the renderer bundle has downloaded or run.
 *
 * An entry opts in with two markers: `BOOT_SHELL_HEAD_MARKER` in `<head>`
 * becomes the shell's stylesheet and boot script, `BOOT_SHELL_ROOT_MARKER`
 * inside `#root` becomes its markup. React's first commit replaces the markup.
 * Entries without markers (the recovery page) are left untouched.
 *
 * The boot script is inline, so a Content-Security-Policy must allow it by
 * hash: add `bootShellScriptCspSource()` to `script-src`.
 */

export const BOOT_SHELL_HEAD_MARKER = '<!-- lody:boot-shell-head -->';
export const BOOT_SHELL_ROOT_MARKER = '<!-- lody:boot-shell -->';

/** The `script-src` source that allows the inline boot script. */
export function bootShellScriptCspSource(): string {
  const digest = createHash('sha256').update(createBootShellScript()).digest('base64');
  return `'sha256-${digest}'`;
}

export function injectBootShell(html: string): string {
  const hasHead = html.includes(BOOT_SHELL_HEAD_MARKER);
  const hasRoot = html.includes(BOOT_SHELL_ROOT_MARKER);
  if (!hasHead && !hasRoot) return html;
  if (!hasHead || !hasRoot) {
    throw new Error(
      `Boot shell entries need both ${BOOT_SHELL_HEAD_MARKER} and ${BOOT_SHELL_ROOT_MARKER}.`
    );
  }
  // `data-href`/`data-precedence` let React adopt this sheet for the
  // `<style href precedence>` that `BootShell` renders instead of adding a copy.
  const head =
    `<style data-href="lody-boot-shell" data-precedence="lody-boot-shell">${BOOT_SHELL_CSS}</style>` +
    `<script>${createBootShellScript()}</script>`;
  return html
    .replace(BOOT_SHELL_HEAD_MARKER, head)
    .replace(BOOT_SHELL_ROOT_MARKER, BOOT_SHELL_MARKUP);
}

const HEAD_STYLESHEET_LINK = /<link\b[^>]*\brel="stylesheet"[^>]*>\s*/g;

/**
 * A stylesheet in `<head>` blocks the first paint until it has downloaded, and
 * the entry stylesheet is the whole product's CSS — on a slow network the
 * inlined shell would wait for it. Linked at the end of `<body>` it blocks only
 * what follows it (nothing), while module scripts still wait for it before
 * running, so React never renders unstyled.
 */
export function moveStylesheetsAfterBootShell(html: string): string {
  if (!html.includes('data-lody-boot-shell')) return html;
  const headEnd = html.indexOf('</head>');
  const bodyEnd = html.lastIndexOf('</body>');
  if (headEnd < 0 || bodyEnd < 0) return html;
  const head = html.slice(0, headEnd);
  const links = head.match(HEAD_STYLESHEET_LINK);
  if (!links) return html;
  const body = html.slice(headEnd, bodyEnd);
  return (
    head.replace(HEAD_STYLESHEET_LINK, '') +
    body +
    links.map((link) => link.trim()).join('\n') +
    '\n' +
    html.slice(bodyEnd)
  );
}

export function bootShellPlugin(): Plugin[] {
  return [
    {
      name: 'lody-boot-shell',
      transformIndexHtml: { order: 'pre', handler: injectBootShell },
    },
    {
      // `post` runs after Vite has linked the built entry stylesheet.
      name: 'lody-boot-shell-stylesheets',
      apply: 'build',
      transformIndexHtml: { order: 'post', handler: moveStylesheetsAfterBootShell },
    },
  ];
}
