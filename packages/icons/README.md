# `@lody/icons`

Lody's independent icon system. It owns the icon registry, SVG renderer, four
visual treatments, and stateful icons. Icons fill the box supplied by their
caller, inherit `currentColor`, and do not depend on `@lody/ui` or product
components.

The package is source-consumed in the workspace. Import the public surface from
`@lody/icons`; the subpath exports are intended for package tests and tooling.
