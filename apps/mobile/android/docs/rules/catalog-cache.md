# Catalog cache and recovery (Android)

Read before changing the catalog repository, its stores, persistence or connection recovery. These rules bind every caller of the area, not only files in its directory.

- `CatalogRepository` owns the selected workspace, one runtime subscription and the typed display projection. Pages observe its StateFlow; they never own a WebView or parse cache JSON.

- `CatalogStore` / `AccountContextStore` are suspend ports. The current AtomicFile implementation stores bounded whole snapshots under noBackupFilesDir; a future database implementation can replace it when queries require it. No credentials, CRDT replicas, cursors or send intents belong in this cache.

- Cached account/workspace context is unverified. Grant requests require online account validation. Login switching, logout and credential revocation cancel owned work before clearing projections. Network failures retain cached display, never label it LIVE.

- Only a matching catalog + synced event pair may persist. Stamp `RuntimeEmission.generation` at native receipt before buffering; never infer the origin generation at collection time. Revisions restart per generation.

- Persist with a scope-owned conflated worker; disk latency must not backpressure cloud event delivery. Cancel and join the worker before clearing/switching its scope.

- RuntimeLifecycle owns one process-lifetime network subscription. Network validation is a recovery hint for an unavailable read lease, not proof of cloud liveness; backgrounding never registers another callback or starts recovery work.
