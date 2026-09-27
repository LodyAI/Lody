// React 19 ships useSyncExternalStore; Base UI and TanStack Router still import the
// CJS `use-sync-external-store/shim`, which the dev server cannot serve as ESM.
export { useSyncExternalStore } from 'react';
