# Composer file search responsiveness

Status: draft
Translation: current

[简体中文](composer-file-search.zh.md)

When a user types a file keyword after `@` in a large project, the composer must
remain editable while suggestions are calculated. A large file index must not
make the renderer synchronously build and rank all search candidates.

## Search and lifetime

The file menu delegates index construction and ranking to a dedicated Worker.
The renderer receives bounded suggestions and displays loading or failure state.
A failed Worker must not trigger synchronous full-index search. Reopening the
menu retries. Bare `@` and queries scoped to other categories do not start file
search. Closing the menu, leaving file search, changing its source entry, or
unmounting releases its Worker and index.

Only results for the current entry and query may be displayed or selected. New
input supersedes pending queries and can interrupt a running search between
candidate batches. Old responses must not overwrite newer text or another
project's candidates.

## Compatibility and limits

Preserve existing fuzzy scores, path ordering, directory navigation, insertion
text, lazy directories, and result limits. File discovery, ignore rules, file
access permissions, and draft hydration are unchanged. This does not promise
instant results: broad searches still inspect many paths, and transferring an
index has a cost. Responsiveness measurements must distinguish query completion
latency from renderer blocking and identify the fixture and environment.

## Evidence

- [Implementation map](../packages/components/src/components/mentions/README.md)
- [Behavior tests](../packages/components/tests/mention-file-search.test.ts)
- [Benchmark and measured limits](../.agents/notes/implemented/bug-fix/2026-09-20-composer-file-search-worker.md)
