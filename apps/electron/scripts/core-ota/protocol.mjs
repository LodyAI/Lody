import { createHash, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = () => {
  throw new Error('Invalid Core OTA manifest')
}
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
    return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`
  return fail()
}
const keys = (v, names) => {
  if (
    !v ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Object.keys(v).sort().join() !== names.split(' ').sort().join()
  )
    fail()
}
const hash = (v) => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail()
}
const num = (v, max, min = 0) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail()
}
const token = (v) => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v)) fail()
}
function path(v) {
  if (typeof v !== 'string' || v.length > 1024 || v !== v.normalize('NFC')) fail()
  for (const p of v.split('/'))
    if (
      !p ||
      p === '.' ||
      p === '..' ||
      /[\\:<>"|?*\x00-\x1f\x7f]/.test(p) ||
      /[. ]$/.test(p) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
      /[\ud800-\udfff]/u.test(p)
    )
      fail()
}
export function validateManifest(m) {
  keys(
    m,
    'schemaVersion releaseId seq channel platform arch hostAbi tree packs objects patches signature'
  )
  if (m.schemaVersion !== 1) fail()
  for (const k of ['releaseId', 'channel', 'platform', 'arch', 'hostAbi']) token(m[k])
  num(m.seq, Number.MAX_SAFE_INTEGER)
  if (
    !Array.isArray(m.tree) ||
    !m.tree.length ||
    m.tree.length > 100000 ||
    !Array.isArray(m.packs) ||
    m.packs.length > 64 ||
    !Array.isArray(m.patches) ||
    m.patches.length > 100000
  )
    fail()
  const paths = new Set(),
    sizes = new Map(),
    packs = new Map(),
    ranges = new Map()
  for (const p of m.packs) {
    keys(p, 'sha256 path size')
    hash(p.sha256)
    path(p.path)
    num(p.size, 8 * 2 ** 30, 1)
    if (
      packs.has(p.sha256) ||
      [...packs.values()].some((x) => x.path.toLowerCase() === p.path.toLowerCase())
    )
      fail()
    packs.set(p.sha256, p)
  }
  let total = 0
  for (const f of m.tree) {
    keys(f, 'path sha256 size')
    path(f.path)
    hash(f.sha256)
    num(f.size, 256 * 2 ** 20)
    total += f.size
    if (total > 32 * 2 ** 30) fail()
    const n = f.path.toLowerCase()
    if (paths.has(n)) fail()
    paths.add(n)
    if (sizes.has(f.sha256) && sizes.get(f.sha256) !== f.size) fail()
    sizes.set(f.sha256, f.size)
  }
  for (const p of paths) {
    const parts = p.split('/')
    parts.pop()
    while (parts.length) {
      if (paths.has(parts.join('/'))) fail()
      parts.pop()
    }
  }
  const frame = (f) => {
    hash(f.packSha256)
    hash(f.compressedSha256)
    num(f.offset, 8 * 2 ** 30)
    num(f.length, 256 * 2 ** 20, 1)
    const p = packs.get(f.packSha256)
    if (!p || f.offset + f.length > p.size) fail()
    const r = ranges.get(f.packSha256) ?? []
    r.push([f.offset, f.offset + f.length])
    ranges.set(f.packSha256, r)
  }
  if (
    !m.objects ||
    Object.getPrototypeOf(m.objects) !== Object.prototype ||
    Object.keys(m.objects).length !== sizes.size
  )
    fail()
  for (const [h, f] of Object.entries(m.objects)) {
    hash(h)
    if (!sizes.has(h)) fail()
    keys(f, 'packSha256 offset length compressedSha256')
    frame(f)
  }
  const pairs = new Set()
  for (const p of m.patches) {
    keys(p, 'fromSha256 toSha256 packSha256 offset length compressedSha256')
    hash(p.fromSha256)
    hash(p.toSha256)
    if (
      !sizes.has(p.toSha256) ||
      p.fromSha256 === p.toSha256 ||
      pairs.has(p.fromSha256 + p.toSha256)
    )
      fail()
    pairs.add(p.fromSha256 + p.toSha256)
    frame(p)
  }
  for (const r of ranges.values()) {
    r.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < r.length; i++) if (r[i][0] < r[i - 1][1]) fail()
  }
  if (
    typeof m.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(m.signature) ||
    Buffer.from(m.signature, 'base64').toString('base64') !== m.signature
  )
    fail()
  return m
}
const payload = ({ signature, ...rest }) => Buffer.from(canonicalJson(rest))
export function signManifest(unsigned, privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') fail()
  const m = { ...unsigned, signature: sign(null, payload(unsigned), key).toString('base64') }
  validateManifest(m)
  return m
}
export function verifyManifest(m, publicKey) {
  validateManifest(m)
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(null, payload(m), key, Buffer.from(m.signature, 'base64'))
  )
    throw new Error('Core OTA signature verification failed')
  return m
}
