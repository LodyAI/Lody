# Docs UI

This directory owns the public site's docs presentation in local StyleX. The
route adapter in [`docs.tsx`](../../src/site-pages/docs.tsx) supplies its layout
and page slots; [`mdx.tsx`](../mdx.tsx) supplies the article components.

| Area                  | Owner                                                                                                        | Behavior boundary                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Layout and navigation | `layout-*`, `page-container`, `page-breadcrumb`, `page-footer`                                               | Public layout/tree contexts, sidebar primitives and framework links retain navigation and state.                         |
| Contents and search   | `page-toc`, `search-parts`                                                                                   | Core scrollspy/item navigation, search contexts and keyboard-list behavior remain upstream; normal track state is local. |
| Article components    | `page-text`, `heading`, `codeblock`, `tabs`, `accordion`, `card`, `callout`, `steps`, `table`                | Local presentation composes with public Fumadocs or Base UI behavior primitives where needed.                            |
| Reading foundation    | [`app/reading-prose.css`](../../app/reading-prose.css), [`app/reading-code.css`](../../app/reading-code.css) | Semantic article typography and Shiki token/line integration.                                                            |

The site does not load Fumadocs' utility safelist or typography compiler. Each
styled part is owned here, either as a native element or as scoped styles on a
behavior primitive's semantic parts. Upstream utility class strings are not
parsed, mapped or made effective by a replacement utility stylesheet. New
physical overrides belong in typed owner composition, not class merge rules.

`DocsLayoutContainer` owns the grid. Public dimensions are written on that
ancestor from present semantic parts: the header below 48rem, sidebar from 48rem,
TOC from 80rem, and TOC disclosure below 80rem. A dimension set only on a child
cannot size the ancestor's grid. Preserve the provider, root, trigger and hook
together when changing the sidebar slot object, and preserve existing base slots
when adding a local slot. The layout also owns the physical skin of the semantic
`fd-page-tree-item-name` marker; it is not a retained utility hook.

The normal TOC track subscribes to the public core snapshot through
`useSyncExternalStore`, which rechecks updates between render and subscription.
Its local ResizeObserver retains the original item-offset and padding formula.
An effect-only listener could miss the initial active state and leave the track
invisible indefinitely. Clerk mode retains its upstream measurement behavior.

Article defaults use `reading-prose`; the `not-prose` integration hook excludes
component subtrees. Their `reading` layer precedes `site-stylex`, so a local card,
code block or callout can own its presentation without specificity patches. Theme
and normalization defaults remain ordinary CSS, not generated utility rules.
`DocsBody` owns heading-adjacent and first/last-child margin structure in StyleX;
keeping these rules out of the lower typography layer preserves the original
prose precedence over tab spacing.

Adapted Fumadocs 16.8.12 presentation and its typography/palette retain the
[Fumadocs MIT notice](LICENSE.fumadocs). The normalization and design scale derived
from the locked Tailwind foundation retain the [Tailwind MIT notice](LICENSE.tailwind).
Neither attribution requires retaining a compiler or runtime class-merging engine.

The workspace registers an exact
[`@fumadocs/base-ui@16.8.12` patch](../../../patches/@fumadocs__base-ui@16.8.12.patch)
that changes only `dist/utils/cn.js` from `twMerge` to `clsx`. Its version-scoped
workspace dependency rules remove `tailwind-merge` and `@fumadocs/tailwind` and
supply `clsx@2.1.1`. This patch joins classes; it does not transform utility
strings or alter Fumadocs state. Review the local skins and dependency rules when
updating Fumadocs rather than applying the patch to an unreviewed version.

Source conversion, type checks and builds do not establish visual equivalence.
The [migration note](../../../.agents/notes/implemented/architecture/2026-10-22-tailwind-to-stylex-migration.md)
owns recorded browser coverage and unresolved differences; historical failures
remain open until their actual state is qualified.
