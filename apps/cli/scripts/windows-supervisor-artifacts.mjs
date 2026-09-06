import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const windowsSupervisorArchitectures = ['x64', 'arm64'];
const machines = { x64: 0x8664, arm64: 0xaa64 };
const cliRoot = fileURLToPath(new URL('../', import.meta.url));

export function windowsSupervisorName(arch) {
  if (!windowsSupervisorArchitectures.includes(arch)) {
    throw new Error(`Unsupported Windows supervisor architecture: ${arch}`);
  }
  return `windows-process-supervisor-win32-${arch}.exe`;
}

export function assertWindowsSupervisorArtifacts({ directory, architectures }) {
  const launcher = path.join(directory, 'windows-process-launcher.js');
  if (!fs.existsSync(launcher) || !fs.statSync(launcher).isFile()) {
    throw new Error(`Missing flat Windows process launcher: ${launcher}. Build the CLI first.`);
  }
  for (const arch of architectures) {
    const binary = path.join(directory, windowsSupervisorName(arch));
    if (!fs.existsSync(binary)) {
      throw new Error(
        `Missing Windows supervisor: ${binary}. Build or download the ${arch} CI artifact before packaging.`
      );
    }
    const bytes = fs.readFileSync(binary);
    const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
    if (
      bytes.length < 64 ||
      bytes.readUInt16LE(0) !== 0x5a4d ||
      peOffset < 64 ||
      peOffset > bytes.length - 24 ||
      bytes.readUInt32LE(peOffset) !== 0x00004550 ||
      bytes.readUInt16LE(peOffset + 4) !== machines[arch]
    ) {
      throw new Error(`Invalid Windows supervisor PE architecture (expected ${arch}): ${binary}`);
    }
    const sectionCount = bytes.readUInt16LE(peOffset + 6);
    const optionalSize = bytes.readUInt16LE(peOffset + 20);
    const sectionTable = peOffset + 24 + optionalSize;
    if (
      sectionCount === 0 ||
      optionalSize < 112 ||
      sectionTable + sectionCount * 40 > bytes.length ||
      bytes.readUInt16LE(peOffset + 24) !== 0x20b ||
      (bytes.readUInt16LE(peOffset + 22) & 0x0002) === 0
    ) {
      throw new Error(`Invalid Windows supervisor PE executable: ${binary}`);
    }
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sectionTable + index * 40;
      const size = bytes.readUInt32LE(section + 16);
      const offset = bytes.readUInt32LE(section + 20);
      if (offset + size > bytes.length) {
        throw new Error(`Truncated Windows supervisor PE section: ${binary}`);
      }
    }
  }
}

export function buildWindowsSupervisor({
  directory,
  arch = process.arch,
  platform = process.platform,
}) {
  if (platform !== 'win32') return;
  windowsSupervisorName(arch);
  const result = spawnSync(
    process.execPath,
    [
      path.join(cliRoot, 'scripts', 'build-windows-process-supervisor.mjs'),
      '--arch',
      arch,
      '--out-dir',
      directory,
    ],
    { stdio: 'inherit', windowsHide: true, timeout: 150_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Windows supervisor build failed for ${arch}: ${result.error?.message ?? `exit ${result.status}`}`
    );
  }
  assertWindowsSupervisorArtifacts({ directory, architectures: [arch] });
}

export function stageWindowsSupervisor({ sourceDirectory, destinationDirectory, arch, platform }) {
  if (platform !== 'win32') return;
  // Windows hosts can cross-compile with the installed target toolchain. Other
  // hosts must ingest the corresponding CI artifact; never ship a host binary.
  buildWindowsSupervisor({ directory: sourceDirectory, arch });
  assertWindowsSupervisorArtifacts({ directory: sourceDirectory, architectures: [arch] });
  fs.mkdirSync(destinationDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(sourceDirectory, windowsSupervisorName(arch)),
    path.join(destinationDirectory, windowsSupervisorName(arch))
  );
  assertWindowsSupervisorArtifacts({ directory: destinationDirectory, architectures: [arch] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...extra] = process.argv.slice(2);
  if (command !== 'verify-package' || extra.length !== 0) {
    throw new Error('Usage: windows-supervisor-artifacts.mjs verify-package');
  }
  assertWindowsSupervisorArtifacts({
    directory: path.join(cliRoot, 'dist'),
    architectures: windowsSupervisorArchitectures,
  });
}
