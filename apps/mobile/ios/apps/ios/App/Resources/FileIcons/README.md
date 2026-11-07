# Material file icons

Material Icon Theme 5.38.1, from
https://github.com/material-extensions/vscode-material-icon-theme (MIT).
License: `../licenses/MaterialIconTheme-LICENSE.txt`, also bundled with the app.

These are an offline subset of the package's `icons/*.svg`, rasterized without
color changes to 54px (18pt at 3x). No icon-theme runtime is installed. Unknown
extensions use `material-file`; `ChatFileLink.iconName(for:)` selects the others.

To regenerate an icon from the 5.38.1 npm tarball:

```sh
rsvg-convert --width 54 --height 54 --output material-markdown@3x.png icons/markdown.svg
```

`native:assets` copies the committed PNGs and license into the generated native
resources; no renderer or network is needed to build the app.
