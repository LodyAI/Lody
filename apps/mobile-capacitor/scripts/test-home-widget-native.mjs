import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.log('Home Widget native tests require macOS; skipped on this platform.');
} else {
  const temporary = mkdtempSync(join(tmpdir(), 'lody-home-widget-test-'));
  try {
    const binary = join(temporary, 'home-widget-tests');
    const compile = spawnSync(
      'xcrun',
      [
        'swiftc',
        '-module-cache-path',
        join(temporary, 'modules'),
        fileURLToPath(new URL('../ios/App/App/LodyHomeWidgetStore.swift', import.meta.url)),
        fileURLToPath(new URL('../ios/App/App/LodyTokenUsageWidgetStore.swift', import.meta.url)),
        fileURLToPath(
          new URL('../ios/App/App/LodyProviderQuotaWidgetStore.swift', import.meta.url)
        ),
        fileURLToPath(new URL('../tests/HomeWidgetStoreTests.swift', import.meta.url)),
        '-o',
        binary,
      ],
      { stdio: 'inherit' }
    );
    if (compile.status !== 0) process.exitCode = compile.status ?? 1;
    else {
      const run = spawnSync(binary, [], { stdio: 'inherit' });
      process.exitCode = run.status ?? 1;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
