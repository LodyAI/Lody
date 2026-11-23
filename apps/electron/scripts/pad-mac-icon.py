#!/usr/bin/env python3

import argparse
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageChops
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        'Missing dependency: Pillow\n'
        'Install with: python3 -m pip install Pillow\n'
        f'Original error: {exc}'
    )


@dataclass(frozen=True)
class IconVariant:
    filename: str
    size: int


ICONSET_VARIANTS: tuple[IconVariant, ...] = (
    IconVariant('icon_16x16.png', 16),
    IconVariant('icon_16x16@2x.png', 32),
    IconVariant('icon_32x32.png', 32),
    IconVariant('icon_32x32@2x.png', 64),
    IconVariant('icon_128x128.png', 128),
    IconVariant('icon_128x128@2x.png', 256),
    IconVariant('icon_256x256.png', 256),
    IconVariant('icon_256x256@2x.png', 512),
    IconVariant('icon_512x512.png', 512),
    IconVariant('icon_512x512@2x.png', 1024),
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            'Shrink a macOS icon image to add transparent padding, then generate an .icns via iconutil.'
        )
    )

    parser.add_argument(
        '--input-png',
        default=str(Path(__file__).resolve().parents[1] / 'build' / 'icon-mac.png'),
        help='Path to a square PNG (ideally 1024x1024). Default: apps/electron/build/icon-mac.png',
    )
    parser.add_argument(
        '--output-icns',
        default=str(Path(__file__).resolve().parents[1] / 'build' / 'icon.icns'),
        help='Path to write the .icns. Default: apps/electron/build/icon.icns',
    )
    parser.add_argument(
        '--output-png',
        default=None,
        help='Optional path to write the padded master PNG (same dimensions as input).',
    )
    parser.add_argument(
        '--pad',
        type=float,
        default=0.10,
        help=(
            'Padding fraction per side (0.10 means ~10%% border on each side, icon shrinks to ~80%%). '
            'Suggested range: 0.08–0.12.'
        ),
    )
    parser.add_argument(
        '--mask-png',
        default=None,
        help='Optional same-size macOS icon whose alpha clips the padded output to its silhouette.',
    )

    return parser.parse_args()


def _load_square_rgba(path: Path) -> Image.Image:
    img = Image.open(path).convert('RGBA')
    width, height = img.size
    if width != height:
        raise SystemExit(
            f'Expected a square PNG, got {width}x{height}: {path}\n'
            'Tip: export a square 1024x1024 icon first.'
        )
    return img


def _shrink_with_padding(master: Image.Image, pad: float) -> Image.Image:
    if not (0.0 <= pad < 0.5):
        raise SystemExit(f'--pad must be in [0, 0.5), got {pad}')

    canvas_size = master.size[0]
    scale = 1.0 - 2.0 * pad
    target_size = max(1, int(round(canvas_size * scale)))

    if target_size == canvas_size:
        return master

    resample = (
        Image.Resampling.LANCZOS
        if hasattr(Image, 'Resampling')
        else Image.LANCZOS  # type: ignore[attr-defined]
    )
    resized = master.resize((target_size, target_size), resample)
    canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    offset = ((canvas_size - target_size) // 2, (canvas_size - target_size) // 2)
    canvas.paste(resized, offset, resized)
    return canvas


def _write_iconset(iconset_dir: Path, master: Image.Image) -> None:
    iconset_dir.mkdir(parents=True, exist_ok=True)
    resample = (
        Image.Resampling.LANCZOS
        if hasattr(Image, 'Resampling')
        else Image.LANCZOS  # type: ignore[attr-defined]
    )
    for variant in ICONSET_VARIANTS:
        out_path = iconset_dir / variant.filename
        img = master.resize((variant.size, variant.size), resample)
        img.save(out_path, format='PNG')


def _ensure_iconutil_exists() -> None:
    # iconutil is a macOS system tool (usually /usr/bin/iconutil).
    if shutil.which('iconutil'):
        return

    # Fallback for some environments where iconutil is discoverable via xcrun.
    if shutil.which('xcrun'):
        result = subprocess.run(['xcrun', '--find', 'iconutil'], capture_output=True, text=True)
        if result.returncode == 0:
            return

    raise SystemExit(
        'Could not find iconutil (macOS only).\n'
        'Make sure you are running on macOS and have the required system tools installed.'
    )


def _convert_iconset_to_icns(iconset_dir: Path, output_icns: Path) -> None:
    _ensure_iconutil_exists()
    output_icns.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ['iconutil', '--convert', 'icns', str(iconset_dir), '-o', str(output_icns)],
        check=True,
    )


def main() -> None:
    args = _parse_args()
    input_png = Path(args.input_png).resolve()
    output_icns = Path(args.output_icns).resolve()

    if not input_png.exists():
        raise SystemExit(f'Input PNG does not exist: {input_png}')

    master = _load_square_rgba(input_png)
    padded = _shrink_with_padding(master, pad=float(args.pad))
    if args.mask_png:
        mask = _load_square_rgba(Path(args.mask_png).resolve())
        if mask.size != padded.size:
            raise SystemExit('--mask-png must have the same dimensions as the input')
        padded.putalpha(ImageChops.multiply(padded.getchannel('A'), mask.getchannel('A')))

    if args.output_png:
        output_png = Path(args.output_png).resolve()
        output_png.parent.mkdir(parents=True, exist_ok=True)
        padded.save(output_png, format='PNG')

    with tempfile.TemporaryDirectory(prefix='lody-iconset-') as tmpdir:
        iconset_dir = Path(tmpdir) / 'icon.iconset'
        _write_iconset(iconset_dir, padded)
        _convert_iconset_to_icns(iconset_dir, output_icns)

    rel_out = os.path.relpath(output_icns, Path.cwd())
    print(f'Wrote: {rel_out}')


if __name__ == '__main__':
    main()
