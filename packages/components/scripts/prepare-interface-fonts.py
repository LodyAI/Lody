"""Reproduce licensed interface transport subsets; never edit the input fonts."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import urllib.request
import zipfile

import fontTools
import brotli
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "packages/components/src/tailwind/interface-fonts/generated"
VIVO_URL = "https://developersstatic.vivo.com/developers/1cdcaef3b39848f290bf90346642ed1d/20241022/vivo%20Sans.zip"
VIVO_ARCHIVE_SHA = "aba516deb1f7dc4da451e443e284cdf888b7ea4ee61158e928a4ffb6c24eaa11"
VIVO_FONT_SHA = "abffd2d811975e0ac0ded020be5ecb8d82e11985044ed71267f68ddb7ce9ca6e"
VIVO_LICENSE_SHA = "0f31f382d760f6c285f33bf54cf10b3e123bd0374e4ed0c8401421291fe9ebd3"
GEIST_URL = "https://registry.npmjs.org/geist/-/geist-1.7.2.tgz"
GEIST_SHA1 = "96f6e5d2b3305fd27eacbd5ae4dcfbc5a15e6939"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def acquire(url, env, cache, expected, algorithm="sha256"):
    path = Path(os.environ.get(env, ROOT / ".cache/interface-fonts" / cache))
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        if hashlib.new(algorithm, data).hexdigest() != expected:
            raise ValueError(f"Official archive hash mismatch: {url}")
        path.write_bytes(data)
    data = path.read_bytes()
    if hashlib.new(algorithm, data).hexdigest() != expected:
        raise ValueError(f"Archive hash mismatch: {path}")
    return data


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def unicode_ranges(points):
    ranges = []
    for point in sorted(points):
        if ranges and point == ranges[-1][1] + 1:
            ranges[-1][1] = point
        else:
            ranges.append([point, point])
    return ",".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in ranges)


def partition(cmap, ui):
    # Two useful tiers, not equal codepoint buckets: all shipped interface copy,
    # then GB2312 level-one common Han. Only the remaining long tail is chunked.
    latin = set(range(0x250))
    eligible = set(cmap) - latin
    base = eligible & ui
    common = set()
    for first in range(0xB0, 0xD8):
        for second in range(0xA1, 0xFF):
            try:
                common.add(ord(bytes([first, second]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    common = (common & eligible) - base
    tail = sorted(eligible - base - common)
    return [("ui", sorted(base)), ("common", sorted(common))] + [
        (f"tail-{i // 512:02d}", tail[i:i + 512]) for i in range(0, len(tail), 512)
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if fontTools.__version__ != "4.61.1" or brotli.__version__ != "1.2.0":
        raise ValueError("Use fonttools[woff]==4.61.1 and brotli==1.2.0")
    ui_text = "".join(strings(json.loads((ROOT / "locales/zh_CN.json").read_text())))
    ui = {ord(c) for c in ui_text}
    notices = b"".join((OUT.parent / name).read_bytes() for name in ["vivo-LICENSE.txt", "Geist-LICENSE.txt"])
    signature = digest((ui_text + fontTools.__version__ + brotli.__version__ + Path(__file__).read_text()).encode() + notices)
    manifest_path = OUT / "manifest.json"
    if manifest_path.exists() and not args.force:
        previous = json.loads(manifest_path.read_text())
        if previous.get("recipeSha256") == signature and all(
            (OUT / name).exists() and digest((OUT / name).read_bytes()) == sha
            for name, sha in previous["files"].items()
        ):
            print("Interface fonts: verified existing generated assets")
            return
    vivo_zip = zipfile.ZipFile(io.BytesIO(acquire(VIVO_URL, "VIVO_FONT_ARCHIVE", "vivo-Sans.zip", VIVO_ARCHIVE_SHA)))
    font_data = vivo_zip.read("vivo Sans/OS/Chinese/Simplified Chinese/vivo Sans SC/vivoSansSCVF.ttf")
    license_entries = [n for n in vivo_zip.namelist() if n.startswith("vivo Sans/") and n.endswith(".txt")]
    if len(license_entries) != 1:
        raise ValueError("Ambiguous original vivo license")
    license_data = vivo_zip.read(license_entries[0])
    if digest(font_data) != VIVO_FONT_SHA or digest(license_data) != VIVO_LICENSE_SHA:
        raise ValueError("Original vivo font/license hash mismatch")
    geist_tar = tarfile.open(fileobj=io.BytesIO(acquire(GEIST_URL, "GEIST_FONT_ARCHIVE", "geist-1.7.2.tgz", GEIST_SHA1, "sha1")))
    geist_license = geist_tar.extractfile("package/LICENSE.txt").read()
    if (OUT.parent / "vivo-LICENSE.txt").read_bytes() != license_data or (OUT.parent / "Geist-LICENSE.txt").read_bytes() != geist_license:
        raise ValueError("Committed notices differ from the original official agreements")
    OUT.mkdir(parents=True, exist_ok=True)
    outputs = {}

    def write(name, data):
        (OUT / name).write_bytes(data)
        outputs[name] = digest(data)

    write("vivo-LICENSE.txt", license_data)
    write("Geist-LICENSE.txt", geist_license)
    css = ["/* Generated by prepare-interface-fonts.py. Notices accompany every build. */"]
    for name, member, style in [
        ("Geist.woff2", "Geist-Variable.woff2", "normal"),
        ("Geist-Italic.woff2", "Geist-Italic[wght].woff2", "italic"),
    ]:
        write(name, geist_tar.extractfile(f"package/dist/fonts/geist-sans/{member}").read())
        css.append(f"@font-face {{font-family:Geist;src:url('./{name}') format('woff2');font-weight:100 900;font-style:{style};font-display:swap;}}")
    source = TTFont(io.BytesIO(font_data), recalcTimestamp=False)
    cmap = source.getBestCmap()
    if source["OS/2"].fsType & (0x0002 | 0x0100 | 0x0200):
        raise ValueError(f"Embedding/subsetting restriction in OS/2 fsType: {source['OS/2'].fsType:#x}")
    axes = [[a.axisTag, a.minValue, a.defaultValue, a.maxValue] for a in source["fvar"].axes]
    records = []
    for name, points in partition(cmap, ui):
        if not points:
            continue
        font = TTFont(io.BytesIO(font_data), recalcTimestamp=False)
        options = subset.Options()
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.name_legacy = True
        options.layout_features = ["*"]
        options.hinting = True
        options.recalc_timestamp = False
        worker = subset.Subsetter(options=options)
        worker.populate(unicodes=points)
        worker.subset(font)
        if axes != [[a.axisTag, a.minValue, a.defaultValue, a.maxValue] for a in font["fvar"].axes]:
            raise ValueError("Variable axes changed during subsetting")
        font.flavor = "woff2"
        buffer = io.BytesIO()
        font.save(buffer)
        file = f"vivo-{name}.woff2"
        data = buffer.getvalue()
        write(file, data)
        ranges = unicode_ranges(points)
        css.append(f"@font-face {{font-family:'vivo Sans SC';src:url('./{file}') format('woff2');font-weight:100 850;font-style:normal;font-display:swap;unicode-range:{ranges};}}")
        records.append({"file": file, "bytes": len(data), "codepoints": points, "unicodeRange": ranges})
        print(f"{file}: {len(points)} codepoints, {len(data)} bytes", flush=True)
    write("index.css", ("\n".join(css) + "\n").encode())
    manifest = {"recipeSha256": signature, "sourceSha256": VIVO_FONT_SHA, "fonttools": fontTools.__version__, "brotli": "1.2.0", "axes": axes, "files": outputs, "subsets": records}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
