import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const installer = fileURLToPath(new URL('./install.sh', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-shell-install-'));
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
    'sha256sum',
    'shasum',
    'openssl',
  ]) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
    if (found.status === 0) fs.symlinkSync(found.stdout.trim(), path.join(bin, name));
  }
  fs.writeFileSync(
    path.join(bin, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n',
    { mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
case "$1" in -o) out=$2; shift 2;; http*) url=$1; shift;; *) shift;; esac
done
printf '%s\\n' "$url" >> "$LODY_INSTALL_FIXTURE/requests"
case "$url" in */api/install/daemon/*) cp "$LODY_INSTALL_FIXTURE/meta" "$out";; */daemon.gz) cp "$LODY_INSTALL_FIXTURE/daemon.gz" "$out";; */node.gz) cp "$LODY_INSTALL_FIXTURE/node.gz" "$out";; *) exit 22;; esac
`,
    { mode: 0o700 }
  );
  const capsule = Buffer.from(`#!/bin/sh
if [ "$1" = __sea-install-node ]; then test -f "$2" || exit 1; else printf '%s\\0' "$@" > "$LODY_INSTALL_FIXTURE/invocation"; fi
`);
  const compressed = gzipSync(capsule);
  fs.writeFileSync(path.join(root, 'daemon.gz'), compressed);
  fs.writeFileSync(path.join(root, 'node.gz'), 'synthetic node archive');
  const lines = [
    'LODY-DAEMON-INSTALL-1',
    'lody-cloud',
    'lody-cloud-daemon',
    '1.2.3',
    'stable',
    'linux-x64',
    'daemon.gz',
    sha(compressed),
    String(compressed.length),
    sha(capsule),
    String(capsule.length),
  ];
  const save = () => fs.writeFileSync(path.join(root, 'meta'), lines.join('\n') + '\n');
  save();
  const run = (args = [], source = installer) =>
    spawnSync('/bin/sh', [source, ...args], {
      env: {
        PATH: bin,
        LODY_INSTALL_BASE_URL: 'http://127.0.0.1:12345',
        LODY_INSTALL_FIXTURE: root,
      },
      encoding: 'utf8',
    });
  return { root, bin, lines, save, run };
}
test(
  'standalone shell installs without Node/npm/jq and keeps pairing tokens out of download URLs and shell evaluation',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const auth = "lody_pair_synthetic'$(touch never-evaluate)";
      const result = f.run(['--auth', auth]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, 'invocation')).toString().split('\0').slice(0, -1),
        ['daemon', 'install', '--start', '--autostart', '--auth', auth]
      );
      assert.equal(fs.readFileSync(path.join(f.root, 'requests'), 'utf8').includes(auth), false);
      const offline = f.run(['--no-start']);
      assert.equal(offline.status, 0, offline.stderr);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, 'invocation')).toString().split('\0').slice(0, -1),
        ['daemon', 'install']
      );
      const noModifyPath = f.run(['--no-start', '--no-modify-path']);
      assert.equal(noModifyPath.status, 0, noModifyPath.stderr);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, 'invocation')).toString().split('\0').slice(0, -1),
        ['daemon', 'install', '--no-modify-path']
      );
      const replacing = f.run(['--replace']);
      assert.equal(replacing.status, 0, replacing.stderr);
      assert.deepEqual(
        fs.readFileSync(path.join(f.root, 'invocation')).toString().split('\0').slice(0, -1),
        ['daemon', 'install', '--start', '--autostart', '--replace']
      );
      fs.rmSync(path.join(f.root, 'requests'));
      const dropped = f.run(['--auth', 'synthetic', '--no-start']);
      assert.notEqual(dropped.status, 0);
      assert.match(dropped.stderr, /--no-start/);
      assert.equal(fs.existsSync(path.join(f.root, 'requests')), false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
);
test(
  'archive/raw checksum failures and foreign metadata never execute an installer or replace existing installation',
  { skip: process.platform === 'win32' },
  () => {
    for (const failure of ['archive', 'raw', 'platform', 'distribution', 'extra']) {
      const f = fixture();
      try {
        if (failure === 'archive') f.lines[7] = '0'.repeat(64);
        if (failure === 'raw') f.lines[9] = '0'.repeat(64);
        if (failure === 'platform') f.lines[5] = 'darwin-arm64';
        if (failure === 'distribution') f.lines[2] = 'lody-oss-daemon';
        if (failure === 'extra') f.lines.push('unexpected');
        f.save();
        fs.writeFileSync(path.join(f.root, 'existing-service'), 'retained');
        assert.notEqual(f.run(['--auth', 'synthetic']).status, 0, failure);
        assert.equal(fs.existsSync(path.join(f.root, 'invocation')), false);
        assert.equal(fs.readFileSync(path.join(f.root, 'existing-service'), 'utf8'), 'retained');
      } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    }
  }
);
test(
  'a truncated curl script never begins installation',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const partial = path.join(f.root, 'partial.sh');
      const source = fs.readFileSync(installer, 'utf8');
      fs.writeFileSync(partial, source.slice(0, source.lastIndexOf('main "$@"')));
      assert.equal(f.run([], partial).status, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'requests')), false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
);
