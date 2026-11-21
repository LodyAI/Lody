import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const installerPlatforms = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

/** New connection UI may ship only after its public installation path works. */
export async function checkSourceDaemonInstaller({
  sourceRoot,
  channel,
  expectedVersion,
  baseUrl,
  fetchImpl = fetch,
}) {
  if (!['stable', 'next', 'nightly'].includes(channel))
    throw new Error('Invalid installer channel');
  if (!fs.existsSync(path.join(sourceRoot, 'packages/components/src/lib/daemon-installation.ts')))
    return { status: 'legacy' };
  const origin =
    baseUrl ??
    (
      await import(
        pathToFileURL(path.join(sourceRoot, 'packages/platform/src/runtime-artifacts.ts')).href
      )
    ).DEFAULT_RUNTIME_ARTIFACTS_BASE_URL;
  const distribution = channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon';
  const get = async (pathname, method = 'GET') => {
    const response = await fetchImpl(new URL(pathname, origin), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    });
    if (response.status !== 200)
      throw new Error(`Installer not ready: ${pathname} (${response.status})`);
    return response;
  };
  await Promise.all(
    ['/install.sh', '/install.ps1'].map(async (pathname) => {
      const response = await get(pathname, 'HEAD');
      if (!response.headers.get('content-type')?.startsWith('text/plain'))
        throw new Error('Installer script is not served as text');
    })
  );
  await Promise.all(
    installerPlatforms.map(async (platform) => {
      const response = await get(`/api/install/daemon/${channel}/${platform}`);
      const body = await response.text();
      if (body.length > 131072) throw new Error('Oversized installer metadata');
      const fields = body.replace(/\n$/, '').split('\n');
      const [
        format,
        product,
        selectedDistribution,
        version,
        selectedChannel,
        selectedPlatform,
        filename,
        archiveHash,
        archiveSize,
        rawHash,
        rawSize,
      ] = fields;
      if (
        fields.length !== 11 ||
        format !== 'LODY-DAEMON-INSTALL-1' ||
        product !== 'lody-cloud' ||
        selectedDistribution !== distribution ||
        selectedChannel !== channel ||
        selectedPlatform !== platform ||
        filename !== 'daemon.gz' ||
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) ||
        (expectedVersion && version !== expectedVersion)
      )
        throw new Error(`Installer release identity mismatch: ${platform}`);
      if (
        ![archiveHash, rawHash].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
        ![archiveSize, rawSize].every(
          (value) => /^[1-9][0-9]*$/.test(value) && Number(value) <= 1073741824
        )
      )
        throw new Error('Invalid installer artifact identity');
      const prefix = `/api/runtimes/${distribution}/${version}/${platform}`;
      const capsule = await get(`${prefix}/daemon.gz`, 'HEAD');
      if (capsule.headers.get('content-length') !== archiveSize)
        throw new Error('Installer capsule size mismatch');
      const node = await get(`${prefix}/node.gz`, 'HEAD');
      const nodeSize = Number(node.headers.get('content-length'));
      if (!Number.isSafeInteger(nodeSize) || nodeSize <= 0 || nodeSize > 536870912)
        throw new Error('Installer Node is unavailable');
    })
  );
  return { status: 'ready', channel };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceRoot = path.resolve(process.argv[2] ?? '.');
  const expected =
    process.argv[4] === 'auto'
      ? JSON.parse(fs.readFileSync(path.join(sourceRoot, 'apps/cli/package.json'), 'utf8')).version
      : process.argv[4] || undefined;
  console.log(
    await checkSourceDaemonInstaller({
      sourceRoot,
      channel: process.argv[3],
      expectedVersion: expected,
    })
  );
}
