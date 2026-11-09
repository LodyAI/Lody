# GitHub icons

Unmodified 24 pt SVGs from [GitHub Octicons](https://github.com/primer/octicons/tree/d5d6d581a1f8ff88971979321e4953a23e08bbca/icons), pinned to commit d5d6d581a1f8ff88971979321e4953a23e08bbca.
MIT license: ../../licenses/Octicons-LICENSE.txt.

Xcode preserves the vectors and renders them as templates, so UIKit owns tint and appearance.
`project.yml` links this catalog to the application target so native toolbar image lookup can find it.
The lody- prefix avoids asset-name collisions with other libraries.

# Sign-in provider marks

`lody-login-github` is the Lucide `github` glyph the web sign-in page draws (ISC license:
../../../../packages/LodyAppearance/licenses/Lucide-LICENSE.txt). `lody-login-google` and
`lody-login-discord` are the same monochrome provider marks as web `login-page.tsx`, so the
native sign-in buttons match it. Apple uses the system `apple.logo` symbol.
