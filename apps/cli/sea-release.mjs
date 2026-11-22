import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  makeMacSigningKeychainSearchable,
  requireAcceptedNotarization,
  selectMacSigningIdentity,
} from './sea-signing.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const scripts = path.join(repo, 'apps/cli/scripts/sea');
const run = (file, args, options = {}) =>
  execFileSync(file, args, { stdio: 'inherit', ...options });
const output = path.resolve('daemon-sea-work');
const configuration = path.join(output, 'build.json');
const phase = process.argv[2];
if (phase === 'stage') {
  fs.mkdirSync(output, { recursive: true });
  const version = JSON.parse(
    fs.readFileSync(path.join(repo, 'apps/cli/package.json'), 'utf8')
  ).version;
  const channel = process.env.LODY_DAEMON_CHANNEL;
  if (!['stable', 'next', 'nightly'].includes(channel)) throw new Error('Invalid daemon channel');
  if ((channel === 'nightly') !== /-nightly\.\d+$/.test(version))
    throw new Error('Version/channel mismatch');
  const config = {
    staging: path.join(output, 'staging'),
    dist: path.join(repo, 'apps/cli/dist'),
    cliRoot: path.join(repo, 'apps/cli'),
    output: path.join(output, process.platform === 'win32' ? 'daemon.exe' : 'daemon'),
    node: process.execPath,
    product: 'lody-cloud',
    distribution: channel === 'next' ? 'lody-cloud-next-daemon' : 'lody-cloud-daemon',
    version,
    channel,
    platform: `${process.platform}-${process.arch}`,
  };
  fs.writeFileSync(configuration, JSON.stringify(config));
  run(process.execPath, [path.join(scripts, 'stage.mjs'), configuration]);
} else if (phase === 'package') {
  const config = JSON.parse(fs.readFileSync(configuration, 'utf8'));
  let cleanup = () => {};
  let keychain;
  let signingIdentity;
  let removeSigningKeychainFromSearch = () => {};
  if (process.platform === 'darwin') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-sign-'));
    keychain = path.join(dir, 'sign.keychain-db');
    const certificate = path.join(dir, 'certificate.p12');
    const password = (await import('node:crypto')).randomUUID();
    cleanup = () => {
      try {
        execFileSync('security', ['delete-keychain', keychain], { stdio: 'pipe' });
      } finally {
        try {
          removeSigningKeychainFromSearch();
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    };
    try {
      for (const name of [
        'MACOS_CERTIFICATE_P12_BASE64',
        'MACOS_CERTIFICATE_PASSWORD',
        'CSC_NAME',
        'APPLE_API_KEY_P8',
        'APPLE_API_KEY_ID',
        'APPLE_API_ISSUER',
      ])
        if (!process.env[name]) throw new Error(`${name} is required`);
      fs.writeFileSync(
        certificate,
        Buffer.from(process.env.MACOS_CERTIFICATE_P12_BASE64, 'base64'),
        { mode: 0o600 }
      );
      execFileSync('security', ['create-keychain', '-p', password, keychain], { stdio: 'pipe' });
      removeSigningKeychainFromSearch = makeMacSigningKeychainSearchable(keychain, (args) =>
        execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      );
      execFileSync('security', ['unlock-keychain', '-p', password, keychain], { stdio: 'pipe' });
      execFileSync(
        'security',
        [
          'import',
          certificate,
          '-k',
          keychain,
          '-P',
          process.env.MACOS_CERTIFICATE_PASSWORD,
          '-T',
          '/usr/bin/codesign',
        ],
        { stdio: 'pipe' }
      );
      execFileSync(
        'security',
        [
          'set-key-partition-list',
          '-S',
          'apple-tool:,apple:,codesign:',
          '-s',
          '-k',
          password,
          keychain,
        ],
        { stdio: 'pipe' }
      );
      signingIdentity = selectMacSigningIdentity(
        execFileSync('security', ['find-identity', '-v', '-p', 'codesigning', keychain], {
          encoding: 'utf8',
        }),
        process.env.CSC_NAME
      );
      const signNative = (file) =>
        run('codesign', [
          '--force',
          '--timestamp',
          '--sign',
          signingIdentity,
          '--keychain',
          keychain,
          file,
        ]);
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(file);
          else {
            const fd = fs.openSync(file, 'r'),
              magic = Buffer.alloc(4);
            try {
              fs.readSync(fd, magic, 0, 4, 0);
            } finally {
              fs.closeSync(fd);
            }
            if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic.toString('hex')))
              signNative(file);
          }
        }
      }
      walk(config.staging);
    } catch (error) {
      cleanup();
      throw error;
    }
  }
  let windowsDir;
  const signWindows = (target) => {
    if (process.platform !== 'win32') return;
    if (!process.env.WINDOWS_CERTIFICATE_P12_BASE64) {
      if (process.env.WINDOWS_CERTIFICATE_PASSWORD)
        throw new Error('Windows signing password configured without a certificate');
      console.log('Windows Authenticode signing skipped: no certificate configured');
      return;
    }
    windowsDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-sign-'));
    const certificate = path.join(windowsDir, 'certificate.p12'),
      script = path.join(windowsDir, 'sign.ps1');
    fs.writeFileSync(
      certificate,
      Buffer.from(process.env.WINDOWS_CERTIFICATE_P12_BASE64, 'base64')
    );
    fs.writeFileSync(
      script,
      `param([string]$CertificatePath,[string]$TargetPath)
$ErrorActionPreference='Stop'
$flags=[System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$cert=[System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath,$env:WINDOWS_CERTIFICATE_PASSWORD,$flags)
try {
  $files=if(Test-Path -PathType Container $TargetPath){Get-ChildItem -LiteralPath $TargetPath -File -Recurse | Where-Object {$_.Extension -in '.node','.dll','.exe'}}else{Get-Item -LiteralPath $TargetPath}
  foreach($file in $files){
    $result=Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
    if($result.Status -ne 'Valid'){throw 'Authenticode signing failed'}
  }
} finally {$cert.Dispose()}
`
    );
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, certificate, target]);
  };
  try {
    signWindows(config.staging);
    run(process.execPath, [path.join(scripts, 'build.mjs'), configuration]);
    signWindows(config.output);
    if (process.platform === 'darwin') {
      const entitlements = path.join(output, 'entitlements.plist');
      fs.writeFileSync(
        entitlements,
        '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>'
      );
      run('codesign', [
        '--force',
        '--timestamp',
        '--options',
        'runtime',
        '--entitlements',
        entitlements,
        '--sign',
        signingIdentity,
        '--keychain',
        keychain,
        config.output,
      ]);
      run('codesign', ['--verify', '--strict', '-R=anchor apple generic', config.output]);
      const key = path.join(output, 'notary.p8'),
        zip = path.join(output, 'notary.zip');
      try {
        fs.writeFileSync(key, process.env.APPLE_API_KEY_P8, { mode: 0o600 });
        run('ditto', ['-c', '-k', '--keepParent', config.output, zip]);
        const notarization = run(
          'xcrun',
          [
            'notarytool',
            'submit',
            zip,
            '--key',
            key,
            '--key-id',
            process.env.APPLE_API_KEY_ID,
            '--issuer',
            process.env.APPLE_API_ISSUER,
            '--wait',
            '--output-format',
            'json',
          ],
          { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }
        );
        requireAcceptedNotarization(notarization);
      } finally {
        fs.rmSync(key, { force: true });
        fs.rmSync(zip, { force: true });
      }
    }
    const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-daemon-artifact-'));
    try {
      const nodeGzip = path.join(probeDirectory, 'node.gz');
      fs.writeFileSync(nodeGzip, gzipSync(fs.readFileSync(config.node)));
      const env = { ...process.env, LODY_DATA_DIR: path.join(probeDirectory, 'data') };
      run(config.output, ['__sea-install-node', nodeGzip], { env });
      run(config.output, ['--version'], { env });
      run(config.output, ['__sea-native-probe'], { env });
    } finally {
      fs.rmSync(probeDirectory, { recursive: true, force: true });
    }
    const final = {
      capsule: config.output,
      node: config.node,
      outputDir: path.join(output, 'release'),
      source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    };
    const finalConfig = path.join(output, 'finalize.json');
    fs.writeFileSync(finalConfig, JSON.stringify(final));
    run(process.execPath, [path.join(scripts, 'finalize.mjs'), finalConfig]);
    fs.writeFileSync(
      path.join(final.outputDir, 'identity.json'),
      JSON.stringify({
        version: config.version,
        source: final.source,
        platform: config.platform,
        channel: config.channel,
      })
    );
  } finally {
    cleanup();
    if (windowsDir) fs.rmSync(windowsDir, { recursive: true, force: true });
  }
} else throw new Error('Expected stage or package');
