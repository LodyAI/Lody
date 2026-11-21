import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function assertIPhoneDuoSdk(version) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  if (!match || Number(match[1]) < 27 || (Number(match[1]) === 27 && Number(match[2]) < 1)) {
    throw new Error(
      `iPhone Duo full-display support requires iOS SDK 27.1 or later; selected SDK: ${version.trim()}. Select Xcode 27.1 or later with DEVELOPER_DIR or xcode-select.`
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version'], {
    encoding: 'utf8',
  });
  assertIPhoneDuoSdk(version);
  console.log(`iPhone Duo SDK verified: ${version.trim()}`);
}
