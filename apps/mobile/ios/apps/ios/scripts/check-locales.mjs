import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const kit = path.resolve(root, '../../packages/LodyKit/Sources/LodyKit');
const problems = [];

function signature(value) {
  let next = 0;
  return [...value.matchAll(/%(?:(\d+)\$)?(@|lld|ld|d|%)/g)]
    .filter((match) => match[2] !== '%')
    .map((match) => `${match[1] ?? ++next}:${match[2]}`)
    .sort()
    .join(',');
}

function units(localization) {
  if (localization?.stringUnit) return [localization.stringUnit];
  const plural = localization?.variations?.plural;
  if (!plural?.other) return [];
  return Object.values(plural).map((entry) => entry.stringUnit);
}

function readCatalog(file) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [key, entry] of Object.entries(catalog.strings)) {
    const english = units(entry.localizations?.en);
    const chinese = units(entry.localizations?.['zh-Hans']);
    if (!english.length || !chinese.length) {
      problems.push(`${file}: ${key} needs English and Simplified Chinese`);
      continue;
    }
    const expected = signature(english[0].value);
    for (const unit of [...english, ...chinese]) {
      if (unit?.state !== 'translated' || typeof unit?.value !== 'string') {
        problems.push(`${file}: ${key} has an incomplete translation`);
      } else if (signature(unit.value) !== expected) {
        problems.push(`${file}: ${key} has incompatible format arguments`);
      }
    }
  }
  return catalog.strings;
}

const strings = readCatalog(path.join(kit, 'Resources/Localizable.xcstrings'));
const info = readCatalog(path.join(root, 'App/InfoPlist.xcstrings'));
for (const key of [
  'CFBundleDisplayName',
  'NSCameraUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSPhotoLibraryUsageDescription',
]) {
  if (!(key in info)) problems.push(`InfoPlist.xcstrings: missing ${key}`);
}

for (const base of [kit, path.join(root, 'Extensions')]) {
  for (const file of fs.globSync('**/*.swift', {
    cwd: base,
    exclude: (name) => name === 'debug',
  })) {
    const source = fs.readFileSync(path.join(base, file), 'utf8');
    for (const match of source.matchAll(/String\(localized: "([^"\\]+)"/g)) {
      if (!(match[1] in strings))
        problems.push(`${file}: missing catalog key ${match[1]}`);
    }
    source.split('\n').forEach((line, index) => {
      if (/[㐀-鿿豈-﫿！-｠]/.test(line))
        problems.push(`${file}:${index + 1}: hardcoded copy`);
    });
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
