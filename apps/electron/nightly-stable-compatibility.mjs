/** This version is an operator attestation after packaged compatibility tests. */
export function parseCompatibleStableVersion(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/u.test(value)
  ) {
    throw new Error('Nightly requires a verified minimum Stable release version (x.y.z)')
  }
  return value.split('.').map(Number)
}

/** Verify that the attested support floor has actually been published. */
export async function verifyCompatibleStableRelease({
  minimumVersion,
  manifestUrl,
  request = fetch
}) {
  const minimum = parseCompatibleStableVersion(minimumVersion)
  let url
  try {
    url = new URL(manifestUrl)
  } catch {
    throw new Error('Invalid Stable release manifest URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/version.json') ||
    url.pathname.split('/').includes('nightly')
  ) {
    throw new Error('Invalid Stable release manifest URL')
  }
  const response = await request(url.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store'
  })
  if (!response.ok) throw new Error(`Stable release manifest unavailable: HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error('Stable release manifest is too large')
  const manifest = JSON.parse(text)
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest.channel !== undefined && manifest.channel !== 'stable')
  ) {
    throw new Error('Invalid Stable release manifest')
  }
  const available = parseCompatibleStableVersion(manifest.version)
  const difference =
    available.map((part, index) => part - minimum[index]).find((part) => part !== 0) ?? 0
  if (difference < 0)
    throw new Error(
      `Compatible Stable ${minimumVersion} must be published before Nightly (available: ${manifest.version})`
    )
  return minimumVersion
}
