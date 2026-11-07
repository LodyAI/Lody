#!/usr/bin/env node
// Agent provider marks: converts the iOS agent SVGs (one source for both apps, imported from web's
// `agent-icon.tsx` assets) to Android VectorDrawables plus the `AgentLogos` name table.
// Dependency-free Node 22. Run after changing ../ios/apps/ios/Resources/AgentIcons.xcassets:
//   node android/scripts/agent-icons.mjs        (write)
//   node android/scripts/agent-icons.mjs --check (fail on stale output)
// Supported SVG: path / circle / ellipse / rect / line / polyline / polygon, nested <g>, fill / stroke
// (+ opacity, width, cap, join), fill-rule, and transforms without rotation or skew. Marks are
// monochrome and tinted at use, so every colour becomes opaque black.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '../ios/apps/ios/Resources/AgentIcons.xcassets');
const drawables = join(root, 'app/src/main/res/drawable');
const table = join(root, 'app/src/main/kotlin/app/lody/android/home/AgentLogos.generated.kt');
const check = process.argv.includes('--check');

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v, d = 0) => (v === undefined || v === '' ? d : parseFloat(v));
const fmt = (n) => String(Math.round(n * 1e4) / 1e4);
const sig = (n) => String(Number(n.toPrecision(7)));

/** `translate(x y) scale(s)` / `matrix(a 0 0 d e f)` → [sx, sy, tx, ty], applied scale first. */
function transform(value) {
  let m = [1, 0, 0, 1, 0, 0];
  const mul = (n) => { m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; };
  for (const [, fn, args] of (value ?? '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.trim().split(/[\s,]+/).map(Number);
    if (fn === 'translate') mul([1, 0, 0, 1, a[0], a[1] ?? 0]);
    else if (fn === 'scale') mul([a[0], 0, 0, a[1] ?? a[0], 0, 0]);
    else if (fn === 'matrix') mul(a);
    else throw Error(`unsupported transform ${fn}`);
  }
  if (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) throw Error('rotation/skew unsupported');
  return [m[0], m[3], m[4], m[5]];
}

function geometry(name, a) {
  switch (name) {
    case 'path': return a.d;
    case 'circle': case 'ellipse': {
      const cx = num(a.cx), cy = num(a.cy), rx = num(a.rx ?? a.r), ry = num(a.ry ?? a.r);
      return `M${fmt(cx - rx)},${fmt(cy)}a${fmt(rx)},${fmt(ry)} 0 1,0 ${fmt(2 * rx)},0a${fmt(rx)},${fmt(ry)} 0 1,0 ${fmt(-2 * rx)},0Z`;
    }
    case 'rect': {
      const x = num(a.x), y = num(a.y), w = num(a.width), h = num(a.height);
      const rx = Math.min(num(a.rx ?? a.ry), w / 2), ry = Math.min(num(a.ry ?? a.rx), h / 2);
      if (!rx) return `M${fmt(x)},${fmt(y)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}Z`;
      return `M${fmt(x + rx)},${fmt(y)}h${fmt(w - 2 * rx)}a${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(rx)},${fmt(ry)}v${fmt(h - 2 * ry)}a${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(-rx)},${fmt(ry)}h${fmt(-(w - 2 * rx))}a${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(-rx)},${fmt(-ry)}v${fmt(-(h - 2 * ry))}a${fmt(rx)},${fmt(ry)} 0 0 1 ${fmt(rx)},${fmt(-ry)}Z`;
    }
    case 'line': return `M${a.x1 ?? 0},${a.y1 ?? 0}L${a.x2 ?? 0},${a.y2 ?? 0}`;
    case 'polyline': case 'polygon': return `M${a.points.trim()}${name === 'polygon' ? 'Z' : ''}`;
  }
}

const SHAPES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const INHERITED = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'opacity'];

function convert(svg) {
  const body = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<defs>[\s\S]*?<\/defs>/g, '');
  if (/<text\b|<use\b|<image\b|Gradient\b|<mask\b/.test(body)) throw Error('unsupported element');
  const top = attrs(body.match(/<svg\b[^>]*>/)[0]);
  const [, , vw, vh] = top.viewBox.trim().split(/[\s,]+/).map(Number);
  const out = [];
  const stack = [{ style: { fill: '#000', ...pick(top) }, indent: '    ' }];
  for (const [, close, name, raw, self] of body.matchAll(/<(\/?)(\w+)\b([^>]*?)(\/?)>/g)) {
    const parent = stack.at(-1);
    if (close) { if (name === 'g') { stack.pop(); out.push(`${stack.at(-1).indent}</group>`); } continue; }
    const a = attrs(raw);
    const style = { ...parent.style, ...pick(a) };
    if (name === 'g') {
      const [sx, sy, tx, ty] = transform(a.transform);
      out.push(`${parent.indent}<group android:scaleX="${sig(sx)}" android:scaleY="${sig(sy)}" android:translateX="${sig(tx)}" android:translateY="${sig(ty)}">`);
      if (self) out.push(`${parent.indent}</group>`); else stack.push({ style, indent: parent.indent + '    ' });
      continue;
    }
    if (!SHAPES.has(name)) continue;
    let indent = parent.indent, wrapped = false;
    if (a.transform) {
      const [sx, sy, tx, ty] = transform(a.transform);
      out.push(`${indent}<group android:scaleX="${sig(sx)}" android:scaleY="${sig(sy)}" android:translateX="${sig(tx)}" android:translateY="${sig(ty)}">`);
      indent += '    '; wrapped = true;
    }
    const opacity = num(style.opacity, 1);
    const fill = name !== 'line' && name !== 'polyline' && style.fill !== 'none';
    const stroke = style.stroke && style.stroke !== 'none';
    if (fill || stroke) {
      const lines = [`android:pathData="${geometry(name, a).replace(/\s+/g, ' ').trim()}"`];
      if (fill) {
        lines.push('android:fillColor="#FF000000"');
        const alpha = num(style['fill-opacity'], 1) * opacity;
        if (alpha < 1) lines.push(`android:fillAlpha="${fmt(alpha)}"`);
        if (style['fill-rule'] === 'evenodd') lines.push('android:fillType="evenOdd"');
      }
      if (stroke) {
        lines.push('android:strokeColor="#FF000000"', `android:strokeWidth="${fmt(num(style['stroke-width'], 1))}"`);
        const alpha = num(style['stroke-opacity'], 1) * opacity;
        if (alpha < 1) lines.push(`android:strokeAlpha="${fmt(alpha)}"`);
        if (style['stroke-linecap']) lines.push(`android:strokeLineCap="${style['stroke-linecap']}"`);
        if (style['stroke-linejoin']) lines.push(`android:strokeLineJoin="${style['stroke-linejoin']}"`);
      }
      out.push(`${indent}<path\n${lines.map((l) => `${indent}    ${l}`).join('\n')} />`);
    }
    if (wrapped) out.push(`${parent.indent}</group>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by android/scripts/agent-icons.mjs; do not edit. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="${fmt(vw)}"
    android:viewportHeight="${fmt(vh)}">
${out.join('\n')}
</vector>
`;
}

function pick(a) {
  const style = {};
  for (const key of INHERITED) if (a[key] !== undefined) style[key] = a[key];
  for (const decl of (a.style ?? '').split(';')) {
    const [k, v] = decl.split(':').map((s) => s?.trim());
    if (k && INHERITED.includes(k)) style[k] = v;
  }
  return style;
}

const names = readdirSync(source).filter((d) => d.startsWith('lody-agent-')).map((d) => d.slice('lody-agent-'.length, -'.imageset'.length)).sort();
const files = new Map();
for (const name of names) {
  const dir = join(source, `lody-agent-${name}.imageset`);
  const svg = readdirSync(dir).find((f) => f.endsWith('.svg'));
  files.set(join(drawables, `lody_agent_${name.replace(/-/g, '_')}.xml`), convert(readFileSync(join(dir, svg), 'utf8')));
}
files.set(table, `// Generated by android/scripts/agent-icons.mjs; do not edit.
package app.lody.android.home

import app.lody.android.R

/** Agent mark asset name (iOS \`lody-agent-<name>\`) → drawable. */
internal val AgentLogoDrawables: Map<String, Int> = mapOf(
${names.map((n) => `    "${n}" to R.drawable.lody_agent_${n.replace(/-/g, '_')},`).join('\n')}
)
`);
let stale = 0;
mkdirSync(drawables, { recursive: true });
for (const [path, text] of files) {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
  if (check) { console.error(`stale: ${path}`); stale++; } else writeFileSync(path, text);
}
for (const f of readdirSync(drawables)) if (f.startsWith('lody_agent_') && !files.has(join(drawables, f))) { console.error(`orphan: ${f}`); stale++; }
if (stale) process.exit(1);
console.log(`${names.length} agent marks ${check ? 'up to date' : 'written'}`);
