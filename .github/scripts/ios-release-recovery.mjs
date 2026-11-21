import { sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const origin = 'https://api.appstoreconnect.apple.com';
const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function check(value, message) {
  if (!value) throw new Error(message);
}
// Use only Apple's fixed origin, including pagination; never forward the JWT
// through redirects or an endpoint supplied by the environment/API response.
export async function validateIosRecovery({ version, token, fetchImpl = fetch }) {
  check(typeof version === 'string' && stable.test(version), 'Invalid recovery version');
  check(typeof token === 'string' && token.length > 0, 'Missing App Store authentication');
  async function collect(path) {
    let url = new URL(path, origin);
    const seen = new Set();
    const items = [];
    while (url) {
      check(
        url.origin === origin && !url.username && !url.password && url.pathname.startsWith('/v1/'),
        'Unsafe App Store pagination URL'
      );
      check(!seen.has(url.href) && seen.size < 1000, 'Invalid App Store pagination');
      seen.add(url.href);
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      check(response.ok, `App Store admission read failed (HTTP ${response.status})`);
      const body = await response.json();
      check(
        Array.isArray(body.data) &&
          body.links &&
          (body.links.next == null || typeof body.links.next === 'string'),
        'Malformed App Store response'
      );
      items.push(...body.data);
      url = body.links.next ? new URL(body.links.next, origin) : null;
    }
    return items;
  }
  const apps = await collect('/v1/apps?filter%5BbundleId%5D=ai.lody.mobile&limit=200');
  check(
    apps.length === 1 &&
      /^[0-9]+$/.test(apps[0].id) &&
      apps[0].attributes?.bundleId === 'ai.lody.mobile',
    'Ambiguous App Store application'
  );
  const id = apps[0].id;
  // Query only the target version. Historical TestFlight versions (such as 1.0)
  // are not evidence of a newer stable release. The GitHub guard separately pins
  // the release tip and newest stable tags. Any matching record blocks replay,
  // including incomplete uploads and empty prerelease-version records.
  const queries = [
    [
      '/v1/preReleaseVersions',
      { 'filter[app]': id, 'filter[platform]': 'IOS', 'filter[version]': version },
    ],
    [
      `/v1/apps/${id}/buildUploads`,
      { 'filter[platform]': 'IOS', 'filter[cfBundleShortVersionString]': version },
    ],
  ];
  for (const [path, filters] of queries) {
    const query = new URLSearchParams({ ...filters, limit: '200' });
    const records = await collect(`${path}?${query}`);
    check(
      records.length === 0,
      'iOS target version or upload already exists; audit instead of uploading'
    );
  }
  return { appId: id, version, buildNumber: '1' };
}

function jwt(env) {
  for (const name of ['APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_API_KEY_P8']) {
    check(env[name], `Missing ${name}`);
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'ES256', kid: env.APPLE_API_KEY_ID, typ: 'JWT' })}.${encode({
    iss: env.APPLE_API_ISSUER,
    aud: 'appstoreconnect-v1',
    iat: now,
    exp: now + 1200,
  })}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: env.APPLE_API_KEY_P8,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${input}.${signature}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validateIosRecovery({
      version: process.env.EXPECTED_VERSION,
      token: jwt(process.env),
    });
    console.log(`iOS admission passed: ${result.version} build ${result.buildNumber}`);
  } catch (error) {
    // API response bodies and JWT/key material must never enter Actions logs.
    console.error(error instanceof Error ? error.message : 'iOS admission failed');
    process.exitCode = 1;
  }
}
