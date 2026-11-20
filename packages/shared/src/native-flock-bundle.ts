import type { FlockRegisterEntry } from '@loro-dev/loro-repo-client';
import type { ExternalFlockDocsAdapter } from 'loro-repo';

/** Flock JSON export bundle, as the external owner contract defines it. */
export type FlockExportBundle = Parameters<Parameters<ExternalFlockDocsAdapter['open']>[1]>[0];

/** Changed registers as a Flock export bundle (clocks and metadata kept). */
export const registersToBundle = (registers: readonly FlockRegisterEntry[]): FlockExportBundle => ({
  version: 0,
  entries: Object.fromEntries(
    registers.map((register) => [
      JSON.stringify(register.key),
      {
        c: register.clockEncoded,
        ...(register.deleted ? {} : { d: register.value as never }),
        ...(register.metadata ? { m: register.metadata } : {}),
      },
    ])
  ),
});
