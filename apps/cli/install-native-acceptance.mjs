import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-installer-native-'));
const hash = (b) => createHash('sha256').update(b).digest('hex');
try {
  for (const file of ['daemon.gz', 'node.gz'])
    fs.copyFileSync(path.join(directory, file), path.join(root, file));
  const raw = gunzipSync(fs.readFileSync(path.join(root, 'daemon.gz')), {
    maxOutputLength: manifest.capsule.contentSize,
  });
  if (hash(raw) !== manifest.capsule.contentSha256)
    throw new Error('Native acceptance capsule mismatch');
  const probe = path.join(root, process.platform === 'win32' ? 'probe.exe' : 'probe');
  fs.writeFileSync(probe, raw, { mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'metadata'),
    [
      'LODY-DAEMON-INSTALL-1',
      manifest.product,
      manifest.distribution,
      manifest.version,
      manifest.channel,
      manifest.platform,
      manifest.capsule.file,
      manifest.capsule.sha256,
      manifest.capsule.size,
      manifest.capsule.contentSha256,
      manifest.capsule.contentSize,
    ].join('\n') + '\n'
  );
  const data = path.join(root, 'isolated data');
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => {
    portProbe.once('error', reject);
    portProbe.listen(0, '127.0.0.1', resolve);
  });
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const isolatedHome = path.join(root, 'home');
  fs.mkdirSync(isolatedHome);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    LODY_NO_MODIFY_PATH: '1',
    LODY_DATA_DIR: data,
    LODY_E2E: '1',
    LODY_E2E_LOCAL_CLI_HOST_PORT: String(port),
    LODY_E2E_LOCAL_CLI_HOST_PIPE: `\\\\.\\pipe\\lody-e2e-${randomUUID()}`,
    LODY_INSTALL_BASE_URL: 'http://127.0.0.1:12345',
    LODY_NATIVE_INSTALL_CHANNEL: manifest.channel,
  };
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(scripts, 'install-native-acceptance.ps1'),
        '-Fixture',
        root,
        '-Installer',
        path.join(scripts, 'install.ps1'),
        '-Probe',
        probe,
      ],
      { env, stdio: 'inherit', timeout: 240000 }
    );
  } else {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const name of [
      'awk',
      'cat',
      'chmod',
      'cp',
      'gzip',
      'mktemp',
      'rm',
      'tr',
      'wc',
      'uname',
      'sha256sum',
      'shasum',
      'openssl',
    ]) {
      const found = spawnSync('/bin/sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
      if (found.status === 0) fs.symlinkSync(found.stdout.trim(), path.join(bin, name));
    }
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
case "$1" in -o) out=$2; shift 2;; http*) url=$1; shift;; *) shift;; esac
done
case "$url" in */api/install/daemon/*) cp "$LODY_INSTALL_FIXTURE/metadata" "$out";; */daemon.gz) cp "$LODY_INSTALL_FIXTURE/daemon.gz" "$out";; */node.gz) cp "$LODY_INSTALL_FIXTURE/node.gz" "$out";; *) exit 22;; esac
`,
      { mode: 0o700 }
    );
    execFileSync(
      '/bin/sh',
      [path.join(scripts, 'install.sh'), '--channel', manifest.channel, '--no-start'],
      { env: { ...env, PATH: bin, LODY_INSTALL_FIXTURE: root }, stdio: 'inherit', timeout: 240000 }
    );
  }
  const service = path.join(
    data,
    'daemon-managed',
    process.platform === 'win32' ? 'service.exe' : 'service'
  );
  if (hash(fs.readFileSync(service)) !== manifest.capsule.contentSha256)
    throw new Error('Installer did not select the exact frozen capsule');
  console.log(
    JSON.stringify({
      result: 'PASS',
      platform: manifest.platform,
      scope:
        'native standalone installation, offline verified Node, fixed entry; no credential/pairing or live daemon acceptance',
    })
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
