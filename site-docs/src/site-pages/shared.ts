/**
 * Route/page adapter primitives shared by every `src/site-pages/*` module.
 *
 * This module must stay FREE of page-component imports. The sibling modules are
 * split per domain precisely so that a route only pulls in the pages it renders;
 * anything imported here lands in the common chunk that every route pays for.
 *
 * The route-data types live here rather than beside their page modules so the
 * server-fn loaders (`src/docs-loader.ts`, `src/changelog-loader.ts`) can name
 * them without importing a module that drags in Fumadocs' docs layout. Today
 * those loaders use `import type`, which erases — keeping the types here means
 * the boundary survives someone dropping the `type` keyword later.
 */

import type { ChangelogEntry } from '@site/lib/changelog';
import type { SerializedPageTree } from 'fumadocs-core/source/client';
import type { TOCItemType } from 'fumadocs-core/toc';

export type SiteLocale = 'en' | 'zh';

export type SerializedTocItem = Omit<TOCItemType, 'title'> & {
  title: string;
};

export type DocsRouteData = {
  title: string;
  description?: string;
  path: string;
  docPath: string;
  pageTree: SerializedPageTree;
  toc: SerializedTocItem[];
  slug?: string[];
};

export type ChangelogPostRouteData = {
  entry: ChangelogEntry;
  newer?: ChangelogEntry;
  older?: ChangelogEntry;
};

export function localeCode(locale: SiteLocale) {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}
