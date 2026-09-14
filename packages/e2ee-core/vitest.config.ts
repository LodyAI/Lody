import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));
const siblingStreamsCrdt = resolve(
  process.env.LORO_STREAMS_CRDT ?? resolve(here, '../../../loro-streams/packages/streams-crdt')
);
const useSibling = existsSync(resolve(siblingStreamsCrdt, 'src/index.ts'));
const localLoro = resolve(here, 'node_modules/loro-crdt');

export default defineConfig({
  resolve: useSibling
    ? {
        alias: {
          '@loro-dev/streams-crdt/loro': resolve(siblingStreamsCrdt, 'src/loro.ts'),
          '@loro-dev/streams-crdt/flock': resolve(siblingStreamsCrdt, 'src/flock.ts'),
          '@loro-dev/streams-crdt': resolve(siblingStreamsCrdt, 'src/index.ts'),
          ...(existsSync(localLoro) ? { 'loro-crdt': localLoro } : {}),
        },
      }
    : undefined,
});
