# Preserve docs title anchors with a single H1

Status: implemented
Translation: current

[中文](2026-10-10-docs-title-anchors.zh.md)

## Abstract

The MDX component map suppresses body H1s because the docs shell already renders
the page title, but the generated table of contents still links to those removed
headings. A local browser scan found missing title targets on 80 docs pages.
The visible title now adopts the existing generated H1 anchor, preserving links
without restoring a second H1 or changing content titles.

## Decision and evidence

`src/site-pages/docs.tsx` takes the first depth-1 TOC URL and decodes its fragment
for the `DocsTitle` ID. Pages without an MDX H1 keep an unanchored title; they must
not borrow an H2 ID and create a duplicate. Reusing the generated slug avoids
differences between frontmatter and body titles, such as Introduction versus Lody.
The title uses the same scroll margin as Fumadocs body headings.

Removing the title TOC entry would leave existing external fragments broken.
Recomputing the slug from frontmatter would change their target. This fix keeps
the existing content and navigation intent described in the
[static content Spec](../../../../specs/public-site-static-content.md).

## Verification

The existing static browser suite now checks every docs page for one H1 and
resolvable local fragments. Its anchor phase covers English and Chinese title
deep links and reloads on desktop/mobile, with and without JavaScript.
Production build, TypeScript checking, all 56 site tests, 258 production static
browser cases (256 published pages plus link-target and 404 checks), and all 20
anchor browser cases passed. The repository docs check reports 82 existing broken
links into absent ACP submodule files; neither new note has a link or metadata
error. Before submission, root formatting passed; `pnpm check` stopped in
`packages/ignore` because this checkout lacks its test/type dependencies. The
remaining root aggregate checks therefore did not complete.
