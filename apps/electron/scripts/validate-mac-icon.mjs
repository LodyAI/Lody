#!/usr/bin/env node
/** Validates build/icon.icns: every PNG OSType chunk must carry the pixel size its slot requires, and all canonical retina chunks must be present (issue #2887). Regenerate with scripts/pad-mac-icon.py. Run: node scripts/validate-mac-icon.mjs [path] — exits non-zero on mismatch. */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../', import.meta.url))
const defaultIcns = path.join(appDir, 'build', 'icon.icns')

/** PNG OSType code -> [requiredW, requiredH]. ic11..ic14 are retina (@2x) of 16,32,128,256. */
const EXPECTED_PNG = {
  icp4: [16, 16],
  icp5: [32, 32],
  icp6: [64, 64],
  ic07: [128, 128],
  ic08: [256, 256],
  ic09: [512, 512],
  ic10: [1024, 1024],
  ic11: [32, 32],
  ic12: [64, 64],
  ic13: [256, 256],
  ic14: [512, 512]
}

/** iconutil's full-iconset chunks; all required so Finder list view + retina displays have correct art. */
const REQUIRED_CHUNKS = ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']

const PNG_MAGIC = 0x89504e47

function u32(buf, off) {
  return (buf[off] * 2 ** 24 + buf[off + 1] * 2 ** 16 + buf[off + 2] * 2 ** 8 + buf[off + 3]) >>> 0
}

/** Returns {w,h} if a PNG starts at off, else null. */
function pngDims(buf, off) {
  if (off + 24 > buf.length || u32(buf, off) !== PNG_MAGIC) return null
  return { w: u32(buf, off + 16), h: u32(buf, off + 20) }
}

export function validateIcns(icnsPath) {
  const buf = fs.readFileSync(icnsPath)
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') {
    return { problems: [`not an icns file (missing 'icns' magic): ${icnsPath}`], report: [] }
  }
  const problems = []
  const report = []
  const seen = new Set()
  let offset = 8
  while (offset + 8 <= buf.length) {
    const tag = buf.toString('ascii', offset, offset + 4)
    const len = u32(buf, offset + 4)
    if (len < 8 || offset + len > buf.length) {
      problems.push(
        `bad chunk '${JSON.stringify(tag)}' at offset ${offset}: length ${len} out of bounds (corrupt chunk table)`
      )
      report.push(`  ${JSON.stringify(tag)}  BAD LENGTH ${len} at offset ${offset}`)
      break
    }
    seen.add(tag)
    const body = offset + 8
    const dims = pngDims(buf, body)
    const expected = EXPECTED_PNG[tag]
    if (expected) {
      const [ew, eh] = expected
      if (!dims) {
        problems.push(
          `chunk ${tag} must contain a ${ew}x${eh} PNG, found non-PNG data (${len - 8}B)`
        )
        report.push(`  ${tag}  expected ${ew}x${eh} PNG -> NON-PNG DATA`)
      } else if (dims.w !== ew || dims.h !== eh) {
        problems.push(`chunk ${tag} must be ${ew}x${eh}, got ${dims.w}x${dims.h}`)
        report.push(`  ${tag}  expected ${ew}x${eh} -> got ${dims.w}x${dims.h}  MISMATCH`)
      } else {
        report.push(`  ${tag}  ${dims.w}x${dims.h}  ok`)
      }
    } else {
      report.push(
        dims
          ? `  ${tag}  ${dims.w}x${dims.h} (untracked type)`
          : `  ${tag}  raw ${len - 8}B (untracked type)`
      )
    }
    offset += len
  }
  for (const tag of REQUIRED_CHUNKS) {
    if (!seen.has(tag))
      problems.push(`missing required chunk ${tag} (${EXPECTED_PNG[tag].join('x')})`)
  }
  return { problems, report }
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedAs === fileURLToPath(import.meta.url)) {
  const icnsPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultIcns
  const { problems, report } = validateIcns(icnsPath)
  console.log(`[icon.icns] ${path.basename(icnsPath)}`)
  if (report.length) console.log(report.join('\n'))
  if (problems.length > 0) {
    console.error(`[icon.icns] FAILED: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('[icon.icns] all chunks valid')
}
