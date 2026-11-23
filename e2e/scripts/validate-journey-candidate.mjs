import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateMain } from './run-journey-author.mjs';

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await validateMain();
}
