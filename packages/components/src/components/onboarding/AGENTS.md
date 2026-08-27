# Desktop Onboarding

- Electron opens `/onboarding` in the primary product renderer. Do not add a second window, renderer entry, provider tree, or runtime lease for onboarding.
- The Electron main process owns the durable completion marker. Renderer storage owns only resumable phase and draft state; clear it after the completion IPC acknowledges success.
- Build the flow from platform capabilities. Local builds must not import or call cloud auth, workspace, or GitHub implementations.
- Provider and local-project selections carry exact IDs. The first session may start only when the selected provider and project belong to the same machine.
- Completion stays in the existing router and navigates to the created session when one exists. Reload recovery must target the normal product root after completion.
- Desktop onboarding owns the app theme for its whole route lifetime: enter and reload in `light`, and restore the persisted source to `system` only after completion succeeds or the route unmounts.
- `ceremony/intro-sequence.tsx` owns the four-beat illustrated intro. Keep its approved assets and direction in `intro-illustration-direction.md`; setup screens must not replace it with a generic welcome card.
- Setup screens use the real `TourStill` product composition. Its Browser beat includes the production Visual Annotation surfaces; do not replace the tour with a hand-built mock.
- Provider rows keep the last durable verification result separate from request-scoped activity. Runtime progress must come from the refresh request that owns the config, not the machine-and-agent global snapshot, and late results must not commit after edit, delete, replacement, or unmount. Active phases replace the compact status badge and determinate progress fills the Test button; do not add a second activity row. A failed result keeps its latest reason inspectable from the badge until success or a config mutation clears it.
