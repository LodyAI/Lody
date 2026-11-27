import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function extractFilesBlock(yamlText) {
  const lines = yamlText.replace(/\r\n/gu, '\n').split('\n');
  const start = lines.findIndex((line) => line === 'files:');
  if (start === -1) return [];
  const entries = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/u.test(line)) break;
    if (line.trim().length === 0) continue;
    entries.push(line);
  }
  return entries;
}

export function mergeMacUpdaterYaml(arm64Text, x64Text) {
  const baseLines = arm64Text.replace(/\r\n/gu, '\n').split('\n');
  const filesStart = baseLines.findIndex((line) => line === 'files:');
  if (filesStart === -1) return arm64Text;
  let filesEnd = filesStart + 1;
  while (filesEnd < baseLines.length && !/^\S/u.test(baseLines[filesEnd])) {
    filesEnd += 1;
  }
  const x64Entries = extractFilesBlock(x64Text);
  if (x64Entries.length === 0) return arm64Text;
  const merged = [
    ...baseLines.slice(0, filesEnd),
    ...x64Entries,
    ...baseLines.slice(filesEnd),
  ];
  return merged.join('\n');
}

export async function mergeMacUpdaterMetadataDir(dir) {
  for (const prefix of ['latest-mac', 'next-mac']) {
    const mergedPath = path.join(dir, `${prefix}.yml`);
    const arm64Path = path.join(dir, `${prefix}-arm64.yml`);
    const x64Path = path.join(dir, `${prefix}-x64.yml`);
    const [hasArm64, hasX64] = await Promise.all([
      fs.access(arm64Path).then(() => true, () => false),
      fs.access(x64Path).then(() => true, () => false),
    ]);
    if (!hasArm64 && !hasX64) continue;
    if (hasArm64 && hasX64) {
      const [arm64Text, x64Text] = await Promise.all([
        fs.readFile(arm64Path, 'utf8'),
        fs.readFile(x64Path, 'utf8'),
      ]);
      await fs.writeFile(mergedPath, mergeMacUpdaterYaml(arm64Text, x64Text), 'utf8');
      await Promise.all([fs.rm(arm64Path), fs.rm(x64Path)]);
    } else if (hasArm64) {
      await fs.rename(arm64Path, mergedPath);
    } else {
      await fs.rename(x64Path, mergedPath);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetDir = process.argv[2] ?? 'electron-release-assets';
  await mergeMacUpdaterMetadataDir(targetDir);
}
