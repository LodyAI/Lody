# Personal memory package

`CLAUDE.md` links here. Read [README.md](README.md) for implemented foundations,
implemented interfaces and the distinction between in-memory mutation and durability.

- The document core is platform-neutral and synchronous. The separate `./repo` adapter
  reuses LoroRepo storage/leases; hosts supply storage and optional local IPC only.
  No filesystem, cloud client, Git, credentials or cryptography belongs here.
  Hosts retain renderer/CLI authorship and persistence/transport ownership.
- Personal repositories never use workspace storage, metadata or Streams transports.
  Workspace + current user + memory ID form the logical identity; a Role selects a
  memory only through its `lody` binding, and only memories listed in the owner's
  catalog are opened for Agents. Renderer databases use
  `PERSONAL_MEMORY_DATABASE_PREFIX` and survive ordinary cache clearing.
- A memory's name and description live only in its MEMORY.md front matter; the
  catalog lists IDs, never a copy of the profile. Tool inputs never select a user,
  Role or memory. Stored identity is data, never authority.
  Check identity at open; the host preserves that binding, admits imports and
  generates unique change IDs. Do not repeat identity or change-ID checks per edit.
- Loro is the only memory state. Root containers are `meta` and `documents`;
  descriptions, bodies and provenance stay in the personal Doc, not global metadata.
- Relative Markdown paths are literal document Map keys. Use mergeable Map/Text/Map
  for each document/body/source map. Do not duplicate paths in stored fields.
  Reads/updates never ensure missing keys; explicit creation may reactivate them.
  Rename migrates visible content to a new path identity. Do not add tombstones.
- Description is optional and bounded. It may improve ranking but cannot exclude
  body-only matches. Only construct fixed JSONPath queries with escaped literals;
  do not accept arbitrary query expressions or use unimplemented `search()` functions.
- Markdown/wiki paths are logical names, not filesystem paths or execution grants.
- Do not present interfaces, Loro commit or snapshot export as local durable saves,
  authorized production sync, or E2EE. No fallback to plaintext sync.
- Keep proposed storage/ownership guarantees in the draft memory Spec until reviewed.

- Read and mutate the live Loro state. Do not add content hashes, expected revisions
  or snapshot-bound pagination. Bounded pages use offsets into current results.
  Expected input errors are results; broken internal structure throws a content-free
  error. Unexpected runtime defects propagate. Validate
  mutations before authoring any changes.
- Preserve the fixed MEMORY.md entry: clear its body instead of moving/deleting it.
  A visible move destination is not implicitly overwritten; concurrent same-key
  creation uses Loro merge semantics, not a separate path uniqueness mechanism.
