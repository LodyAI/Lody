import { register } from 'tsx/esm/api';

// tsx's CLI preload does not register its ESM hooks inside Node 22 workers.
// Register in this worker before Node resolves the TypeScript fixture entry.
register();
