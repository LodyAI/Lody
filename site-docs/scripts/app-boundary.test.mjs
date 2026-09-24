import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findAppBoundaryViolations } from './app-boundary.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'site-boundary-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

await test('the site imports nothing from the app', () => {
  assert.deepEqual(findAppBoundaryViolations(packageRoot), []);
});

await test('app imports, scans and dependencies are reported', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { '@lody/shared': 'workspace:*' } }),
    'components/preview.tsx': [
      "import { ChatComposer } from '@/components/chat/chat-composer';",
      "import type { SessionMeta } from '@lody/shared';",
      "const lazyView = () => import('@/components/ai-gui/view');",
    ].join('\n'),
    'app/global.css': "@source '../../packages/components/src/**/*.{ts,tsx}';",
    'vite.config.ts': "const src = path.resolve(dirname, '../packages/components/src');",
  });
  try {
    assert.deepEqual(findAppBoundaryViolations(root), [
      'components/preview.tsx:1 imports the app through the `@/*` alias',
      'components/preview.tsx:2 imports an app workspace package',
      'components/preview.tsx:3 imports the app through the `@/*` alias',
      'app/global.css:1 points at `packages/components/src` (alias, Tailwind @source, or path)',
      'vite.config.ts:1 points at `packages/components/src` (alias, Tailwind @source, or path)',
      'package.json dependencies depends on @lody/shared',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('site-owned aliases and prose mentions are allowed', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }),
    'components/section.tsx': [
      "import { scheduleAfterLoadIdle } from '@site/lib/after-first-paint';",
      '// Mirrors the app composer in @lody/components; copy, never import.',
    ].join('\n'),
  });
  try {
    assert.deepEqual(findAppBoundaryViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
