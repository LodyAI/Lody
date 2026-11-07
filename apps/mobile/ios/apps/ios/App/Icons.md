# Aqua

`Aqua.icon` is an alternate iOS Icon Composer icon. Its transparent character
foreground comes from the supplied `Weixin Image_20260920210657_818_478.png`;
Icon Composer supplies the background, lighting, shadow and Liquid Glass effects.
Open the package in Icon Composer to edit it. `project.yml` includes it in
Xcode; the primary icon remains `App/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`.

The foreground was extracted with the built-in imagegen tool using this prompt:

> Use case: background-extraction. Edit target: provided square blue-haired
> character image. Remove only the black background and make it genuinely
> transparent (PNG alpha), including black gaps beside hair. Preserve the exact
> original illustration, face, colors, hair silhouette, scale and square cropping;
> do not redraw or invent details, do not add shadows, glass effects, borders or
> text. This will be the foreground layer in Apple Icon Composer; glass rendering
> happens there. Output 1024x1024 transparent PNG.

The generated foreground was downscaled to 1024 × 1024 and quantized with
`pngquant --nofs`; Xcode stores the Composer renders losslessly, so dithering
noise or extra source pixels grow `Assets.car` without a visible gain. Keep the
layer scale at 1 for a 1024 px image. The `.icon` package is the source asset,
not a flattened preview.

## Settings previews

The app-icon grid and Settings thumbnail share `AppIconPreview-*` image sets in
the app's `Icons.xcassets`. Aqua previews include the actual Composer background,
lighting and glass, with separate Default and Dark renditions. Regenerate them
after editing `Aqua.icon` (from the repository root):

```sh
icon_tool="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"
preview_dir=apps/ios/App/Icons.xcassets
"$icon_tool" apps/ios/App/Aqua.icon --export-image --output-file "$preview_dir/AppIconPreview-Aqua.imageset/default.png" --platform iOS --rendition Default --width 256 --height 256 --scale 1
"$icon_tool" apps/ios/App/Aqua.icon --export-image --output-file "$preview_dir/AppIconPreview-Aqua.imageset/dark.png" --platform iOS --rendition Dark --width 256 --height 256 --scale 1
cp apps/ios/App/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png "$preview_dir/AppIconPreview-default.imageset/default.png"
```
