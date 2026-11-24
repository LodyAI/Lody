import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

import { compilePlugin } from '../plugins/plugin-build';
import previewDocument from '../../scripts/plugin-preview/preview.html?raw';
import frameDocument from '../../scripts/plugin-preview/frame.html?raw';
import frame from '../../scripts/plugin-preview/generated/frame.js?raw';
import css from '../../scripts/plugin-preview/generated/assets/stylex.css?raw';
import { runOneShotCommand } from '../lib/command-runtime';
import { openBrowser } from '../utils/open-browser';

export async function renderPluginPreview(sourceDir: string, output?: string) {
  const stage = await mkdtemp(join(tmpdir(), 'lody-preview-build-'));
  try {
    const { manifest } = await compilePlugin({ sourceDir, stage });
    const files: Record<string, string> = Object.create(null);
    for (const file of new Set([
      ...(manifest.client ? [manifest.client] : []),
      ...(manifest.assets ?? []),
      ...(manifest.styles ?? []),
    ]))
      files[file] = (await readFile(join(stage, file))).toString('base64');
    const nonce = randomBytes(18).toString('base64');
    const encode = (s: string) => Buffer.from(s).toString('base64');
    const template = frameDocument
      .replace('/*FRAME_STYLES*/', () => css)
      .replace('FRAME_NONCE', nonce)
      .replace('/*FRAME_SCRIPT*/', () => frame.replace(/<\/script/gi, '<\\/script'));
    const html = previewDocument
      .replaceAll('PREVIEW_NONCE', nonce)
      .replace('FRAME_TEMPLATE', () => encode(template))
      .replace('PLUGIN_DATA', () => encode(JSON.stringify({ files, manifest })));
    const path = output
      ? resolve(output)
      : join(await mkdtemp(join(tmpdir(), 'lody-plugin-preview-')), 'index.html');
    await writeFile(path, html, { mode: 0o600, flag: 'wx' });
    return path;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export const previewPlugin = (path: string, options: { output?: string; open: boolean }) =>
  runOneShotCommand(
    'plugin preview',
    {},
    async () => {
      const file = await renderPluginPreview(resolve(path), options.output);
      console.log(file);
      if (options.open && process.env.LODY_AGENT_SESSION_ID === undefined && process.stdin.isTTY)
        await openBrowser(pathToFileURL(file).href);
    },
    { localOnly: true }
  );
