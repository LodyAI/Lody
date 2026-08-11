import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `repo.unloadDoc(docId)` evicts the doc from loro-repo's instance cache, so the
 * next `openPersistedDoc` returns a DIFFERENT `LoroDoc`. The local data plane
 * resolves a room's doc ONCE and holds that object for as long as a renderer
 * stays subscribed, so an unload that is not paired with
 * `LocalLoroDataPlaneServer.invalidateDocRoom` silently severs renderer↔CLI sync
 * in both directions — with no error, no status change, and no watchdog trip
 * (relay pings are answered before the room message chain).
 *
 * `LoroDocumentManager.unloadDocRoom` is the only sanctioned pairing. This guard
 * keeps it the ONLY entry point, because the failure mode is invisible at
 * runtime and a second call site would reintroduce it without any test failing.
 *
 * Behavioral coverage of the pairing itself lives in
 * `packages/shared/tests/local-loro-transport-bug-repro.test.ts` (F9).
 */
const CLI_SRC = path.resolve(fileURLToPath(new URL('../src', import.meta.url)));
const SANCTIONED_CALL_SITE = path.join(CLI_SRC, 'lib', 'loro', 'doc.ts');

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return await listTypeScriptFiles(full);
      }
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    })
  );
  return files.flat();
}

describe('repo.unloadDoc has a single CLI entry point', () => {
  it('is called only from LoroDocumentManager.unloadDocRoom', async () => {
    const files = await listTypeScriptFiles(CLI_SRC);
    const callSites: string[] = [];

    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        // Skip prose: only executable `.unloadDoc(` calls count.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
          return;
        }
        if (/\.unloadDoc\s*\(/.test(line)) {
          callSites.push(`${path.relative(CLI_SRC, file)}:${index + 1}`);
        }
      });
    }

    // Only the FILE is asserted, not the line. Comparing the line number
    // against a value re-derived by the same search would be tautological.
    expect(callSites).toHaveLength(1);
    expect(callSites[0]?.split(':')[0]).toBe(path.relative(CLI_SRC, SANCTIONED_CALL_SITE));

    // The pairing is the point: the call must sit inside `unloadDocRoom` with
    // the data-plane invalidation right behind it.
    const sanctioned = await fs.readFile(SANCTIONED_CALL_SITE, 'utf8');
    const lines = sanctioned.split('\n');
    // Skip the same comment shapes the scan above skips, or a `//` comment
    // mentioning `.unloadDoc(` would anchor this at the wrong line.
    const index = lines.findIndex((line) => {
      const trimmed = line.trim();
      return /\.unloadDoc\s*\(/.test(line) && !trimmed.startsWith('*') && !trimmed.startsWith('//');
    });
    expect(index).toBeGreaterThanOrEqual(0);
    expect(lines.slice(index + 1, index + 3).join('\n')).toContain('invalidateDocRoom');

    // And it must be reached through the injected unloader, never by a caller
    // holding the repo directly.
    expect(sanctioned).toContain('async unloadDocRoom(docId: string): Promise<void> {');
  });
});
