# Bundled Geist and partitioned vivo Sans SC

Status: proposed
Translation: current

[中文](2026-10-03-interface-font-delivery.zh.md)

[Draft review](https://github.com/LodyAI/Lody/pull/1235)

## Abstract

The default interface needs coordinated Latin and Chinese type without a 44 MB
Chinese first-screen download. The review implementation embeds official Geist
and variable vivo Sans SC WOFF2 partitions: shipped interface copy first,
common Han second, remaining coverage on demand. It preserves text hierarchy,
mono stacks and original variable axes. The font build is reproducible and no
font binary is committed. vivo's agreement does not explicitly authorize
conversion/subsetting; the implementation's transport-only interpretation
remains uncertain and is not manufacturer authorization.

## Decision and boundaries

The [font module](../../../../packages/components/src/tailwind/interface-fonts/README.md)
owns acquisition, loading, original agreements and verification commands. The
shared default token changes; it does not replace saved family overrides or
resize/reweight neighboring controls. Renderer builds emit relative hashed font
assets and original licenses; runtime use is offline, with native fallback.
No experimental candidate packages, screenshots or font binaries enter this change.

The original SC variable font is 44,430,172 bytes. Delaying that entire download
does not address the first-screen loading boundary. A single WOFF2 retains the
same whole-font demand; mechanical equal-codepoint buckets tend to spread common
text across many packages. The selected recipe instead prioritizes all shipped
Chinese copy and remaining GB2312 level-one Han; only the tail uses 512-codepoint
buckets. The complete offline distribution is still larger than the initial
requests, and splitting introduces some repeated metadata/variation overhead.

§2.2 of the retained vivo agreement forbids adaptation/secondary development;
§2.3 distinguishes standalone redistribution from application works. Neither
explicitly settles lossless format conversion and coverage partitioning. Preserve
original outlines, axes, names, hinting and copyright; keep this uncertainty
visible in review. The OS/2 embedding bits and other projects' licenses cannot
grant legal permission. Do not publish these assets as a standalone font package.

This adds a build prerequisite: uv plus pinned fontTools/Brotli. Public downloads
occur at build time only, hashes fail closed, existing generated assets are reused
only after recipe/content/file verification, and the shared CI setup supplies uv.
No hosted product capabilities or telemetry are enabled.

Build integration also needs the pinned adapter manifests and root lockfile to
agree. Baseline `e5b7bde30` changed Codex/Core gitlinks without synchronizing the
Codex importer; main `9bdac2851` still had that mismatch. Synchronize only that
importer and its required peer snapshots, retaining unrelated resolutions.
pnpm 10.20 takes the first matching release-age name rule, so the already-selected
Codex versions and platform aliases share one exact-version union, not a wildcard.
No ACP source or submodule pin changes belong to this repair.

Built Storybook exposed two existing barrel cycles: chat selectors → shared
selectors → chat selectors, and Appearance → settings barrel → Appearance.
Use the same selector leaves and existing `settingsSurface.container` directly;
there is no new compatibility rewrite, configuration behavior or visual token.
The font notice import is relative so Electron's narrower type paths resolve it.

## Evidence and limits

[Browser regression](../../../../packages/components/tests/e2e/interface-typography.spec.ts)
checks actual platform glyph records rather than a computed family list, including
portals, font delay/failure, five settings tiers, palettes and narrow windows.
[Deterministic font checks](../../../../packages/components/scripts/test-interface-fonts.py)
verify disjoint complete mapped non-Latin coverage, notices, axes and sampled
decomposed outlines/advance widths at defaults and both axis extremes. Sampling
is not an exhaustive proof over every glyph and interpolation point.

The existing dense synthetic scene is retained locally for before/after captures
and cold/warm/rare-glyph measurements; its experiment controller is not production
code and is excluded from the change. The implementation budget is 3 MiB and at
most three first-screen Geist/vivo requests; cached bodies are reused and initial
CLS is below 0.05. Vite dev uses `no-store`, so built assets own the cache test.
macOS Chromium results do not prove rendering on every OS or desktop packaging.
Nine Chromium regressions pass against the complete built Storybook runtime,
including five tiers and portals; deterministic font checks pass. The complete
dense React scene measures 2,654,308 first-screen Geist/vivo bytes, zero warm
transferred bytes and one 318,716-byte rare-text request.
The same scene used 44,430,472 bytes for original TTF, 23,079,052 for one WOFF2,
and 20,493,224 across nine mechanical partitions. Initial CLS is 0.02886 versus
0.02861 before. The earlier frozen DOM result was transport-only and is superseded
for runtime acceptance. These are loopback HTTP measurements, not remote-network
or packaged-installer results. Full OSS desktop and Storybook builds, frozen
installation and public/platform boundary checks pass. The isolated real Electron
Appearance scenario passes, and its unit suite passes 199 tests.

The full repository check passes with `NODE_ENV=test` and
`NODE_OPTIONS=--no-experimental-webstorage` on Node 26.10.0. Plain Node 26 reproduces
the unchanged boot-shell storage-spy failure (one of 4,759 component tests);
disabling Node's experimental storage restores the browser/jsdom boundary without
changing product or test code. The installed Node 22 binary cannot start because
its Homebrew simdutf library is missing, so local Node 22 execution is unverified.
Docs check still reports six pre-existing links into uninitialized, root-excluded
Kimi/Pi checkouts; do not report that check as passed.
Related sizing decision: [interface typography](../../implemented/simplification/2026-10-03-interface-typography.md).
