import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const OUTPUT_TS = resolve(
  REPO_ROOT,
  'packages/components/src/lib/open-source-attributions.generated.ts'
);
const OUTPUT_MD = resolve(REPO_ROOT, 'THIRD_PARTY_NOTICES.md');

const NO_ATTRIBUTION_LICENSE_TOKENS = new Set(['0BSD', 'CC0-1.0', 'UNLICENSE', 'WTFPL']);

const VENDORED_ATTRIBUTIONS = [
  {
    id: 'vendored-vscode-fuzzy-scorer',
    kind: 'vendored',
    scope: 'vendored-source',
    name: 'Visual Studio Code fuzzy scorer',
    license: 'MIT',
    homepage:
      'https://github.com/microsoft/vscode/blob/a92c2f9316d5454e35bb4c2958fdc0f23bc87d5d/src/vs/base/common/fuzzyScorer.ts',
    author: 'Microsoft Corporation',
    description: 'Vendored fuzzy scoring algorithm used for mention candidate matching.',
    assets: ['Fuzzy scorer'],
    noticePath: 'packages/components/src/components/mentions/vscode-fuzzy-score.LICENSE.txt',
  },
  {
    id: 'bundled-theme-vscode-defaults',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'VSCode Default Color Themes',
    license: 'MIT',
    homepage: 'https://github.com/microsoft/vscode',
    author: 'Microsoft',
    description: 'Bundled VSCode workbench themes used by Lody for theme adaptation.',
    assets: [
      'Dark 2026',
      'Light 2026',
      'Dark Modern',
      'Light Modern',
      'Dark+',
      'Light+',
      'Dark (Visual Studio)',
      'Light (Visual Studio)',
    ],
    noticePath:
      'packages/components/src/lib/vscode-theme/bundled/themes/vscode-defaults/LICENSE.txt',
  },
  {
    id: 'bundled-theme-vesper',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Vesper',
    license: 'MIT',
    homepage: 'https://github.com/raunofreiberg/vesper',
    author: 'Rauno Freiberg',
    description: 'Bundled VSCode color theme.',
    assets: ['Vesper'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/vesper/LICENSE.md',
  },
  {
    id: 'bundled-theme-github',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'GitHub Theme',
    license: 'MIT',
    homepage: 'https://github.com/primer/github-vscode-theme',
    author: 'GitHub',
    description: 'Bundled VSCode color themes.',
    assets: ['GitHub Light Default', 'GitHub Dark Default'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/github/LICENSE',
  },
  {
    id: 'bundled-theme-catppuccin',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Catppuccin for VSCode',
    license: 'MIT',
    homepage: 'https://github.com/catppuccin/vscode',
    author: 'Catppuccin',
    description: 'Bundled VSCode color themes.',
    assets: ['Catppuccin Mocha', 'Catppuccin Macchiato', 'Catppuccin Frappé', 'Catppuccin Latte'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/catppuccin/LICENSE',
  },
  {
    id: 'bundled-theme-tokyo-night',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Tokyo Night',
    license: 'MIT',
    homepage: 'https://github.com/enkia/tokyo-night-vscode-theme',
    author: 'Enkia',
    description: 'Bundled VSCode color themes.',
    assets: ['Tokyo Night', 'Tokyo Night Storm', 'Tokyo Night Light'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/tokyo-night/LICENSE.txt',
  },
  {
    id: 'bundled-theme-rose-pine',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Rosé Pine',
    license: 'MIT',
    homepage: 'https://github.com/rose-pine/vscode',
    author: 'Rosé Pine',
    description: 'Bundled VSCode color themes.',
    assets: [
      'Rosé Pine',
      'Rosé Pine (no italics)',
      'Rosé Pine Moon',
      'Rosé Pine Moon (no italics)',
      'Rosé Pine Dawn',
      'Rosé Pine Dawn (no italics)',
    ],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/rose-pine/LICENSE',
  },
  {
    id: 'bundled-theme-vitesse',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Vitesse Theme',
    license: 'MIT',
    homepage: 'https://github.com/antfu/vscode-theme-vitesse',
    author: 'Anthony Fu',
    description: 'Bundled VSCode color themes.',
    assets: [
      'Vitesse Light',
      'Vitesse Dark',
      'Vitesse Black',
      'Vitesse Light Soft',
      'Vitesse Dark Soft',
    ],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/vitesse/LICENSE.md',
  },
  {
    id: 'bundled-theme-night-owl',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Night Owl',
    license: 'MIT',
    homepage: 'https://github.com/sdras/night-owl-vscode-theme',
    author: 'Sarah Drasner',
    description: 'Bundled VSCode color themes.',
    assets: [
      'Night Owl',
      'Night Owl (No Italics)',
      'Night Owl Light',
      'Night Owl Light (No Italics)',
    ],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/night-owl/LICENSE.md',
  },
  {
    id: 'bundled-theme-dracula',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Dracula Theme Official',
    license: 'MIT',
    homepage: 'https://github.com/dracula/visual-studio-code',
    author: 'Dracula',
    description: 'Bundled VSCode color theme.',
    assets: ['Dracula Theme'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/dracula/LICENSE',
  },
  {
    id: 'bundled-theme-one-dark-pro',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'One Dark Pro',
    license: 'MIT',
    homepage: 'https://github.com/Binaryify/OneDark-Pro',
    author: 'Binaryify',
    description: 'Bundled VSCode color theme.',
    assets: ['One Dark Pro'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/one-dark-pro/LICENSE.txt',
  },
  {
    id: 'bundled-theme-ayu',
    kind: 'vendored',
    scope: 'bundled-theme',
    name: 'Ayu',
    license: 'MIT',
    homepage: 'https://github.com/ayu-theme/vscode-ayu',
    author: 'Ayu Theme',
    description: 'Bundled VSCode color themes.',
    assets: ['Ayu Light', 'Ayu Mirage', 'Ayu Dark'],
    noticePath: 'packages/components/src/lib/vscode-theme/bundled/themes/ayu/LICENSE',
  },
  {
    id: 'vendored-icons-vscode-symbols',
    kind: 'vendored',
    scope: 'vendored-icon-set',
    name: 'vscode-symbols',
    license: 'MIT',
    homepage: 'https://github.com/miguelsolorio/vscode-symbols',
    author: 'Miguel Solorio',
    description: 'Vendored file and folder icons used across Lody file views.',
    assets: ['File icons', 'Folder icons'],
    noticePath: 'packages/components/src/components/icons/file-icons/LICENSE',
  },
];

function main() {
  const dependencyEntries = resolvePackageAttributions();
  const vendoredEntries = VENDORED_ATTRIBUTIONS.toSorted((a, b) => a.name.localeCompare(b.name));
  const entries = [...vendoredEntries, ...dependencyEntries];
  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };

  writeGeneratedTypeScript(bundle);
  writeGeneratedMarkdown(bundle);
}

function resolvePackageAttributions() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  const byLicense = JSON.parse(raw);
  const aggregates = new Map();

  for (const [license, packages] of Object.entries(byLicense)) {
    if (!licenseRequiresAttribution(license)) {
      continue;
    }

    for (const pkg of packages) {
      if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string') {
        continue;
      }
      if (pkg.name.startsWith('@lody/') || pkg.name === 'lody-agent') {
        continue;
      }

      const key = `${pkg.name}::${license}`;
      const existing = aggregates.get(key);
      if (existing) {
        for (const version of toSortedStrings(pkg.versions)) {
          existing.versions.add(version);
        }
        continue;
      }

      const homepage = normalizeString(pkg.homepage) ?? `https://www.npmjs.com/package/${pkg.name}`;
      aggregates.set(key, {
        id: `pkg-${slugify(pkg.name)}-${slugify(license)}`,
        kind: 'package',
        scope: 'production-dependency',
        name: pkg.name,
        license,
        homepage,
        author: normalizeString(pkg.author),
        description: normalizeString(pkg.description),
        versions: new Set(toSortedStrings(pkg.versions)),
      });
    }
  }

  return [...aggregates.values()]
    .map((entry) => ({
      ...entry,
      versions: [...entry.versions].sort(compareLooseVersions),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

function licenseRequiresAttribution(licenseExpression) {
  const tokens = licenseExpression
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && token !== 'AND' && token !== 'OR' && token !== 'WITH');

  return tokens.some((token) => !NO_ATTRIBUTION_LICENSE_TOKENS.has(token.toUpperCase()));
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toSortedStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .sort(compareLooseVersions);
}

function compareLooseVersions(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function writeGeneratedTypeScript(bundle) {
  mkdirSync(dirname(OUTPUT_TS), { recursive: true });
  const contents = `import type { OpenSourceAttributionBundle } from './open-source-attributions';

// This file is generated by scripts/generate-open-source-attributions.mjs.
// Do not edit manually.
export const OPEN_SOURCE_ATTRIBUTION_BUNDLE: OpenSourceAttributionBundle = ${JSON.stringify(bundle, null, 2)};
`;
  writeFileSync(OUTPUT_TS, contents);
}

function writeGeneratedMarkdown(bundle) {
  mkdirSync(dirname(OUTPUT_MD), { recursive: true });
  const vendored = bundle.entries.filter((entry) => entry.kind === 'vendored');
  const dependencies = bundle.entries.filter((entry) => entry.kind === 'package');
  const dependenciesByLicense = groupBy(dependencies, (entry) => entry.license);
  const markdown = [
    '# Open Source Attributions',
    '',
    'This file is generated by `node scripts/generate-open-source-attributions.mjs`.',
    '',
    `Generated at: \`${bundle.generatedAt}\``,
    '',
    'This list covers shipped production dependencies plus vendored third-party assets bundled in the repository.',
    '',
    '## Summary',
    '',
    `- Bundled assets: ${vendored.length}`,
    `- Production dependencies: ${dependencies.length}`,
    `- Unique license expressions: ${Object.keys(dependenciesByLicense).length}`,
    '',
    '## Bundled Assets',
    '',
    ...vendored.flatMap((entry) => renderVendoredMarkdown(entry)),
    '## Production Dependencies',
    '',
    ...Object.entries(dependenciesByLicense)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([license, entries]) => renderDependencyLicenseGroupMarkdown(license, entries)),
  ].join('\n');

  writeFileSync(OUTPUT_MD, markdown);
}

function renderVendoredMarkdown(entry) {
  return [
    `### ${entry.name}`,
    '',
    `- License: ${entry.license}`,
    entry.author ? `- Author: ${entry.author}` : null,
    entry.homepage ? `- Source: ${entry.homepage}` : null,
    entry.assets?.length ? `- Assets: ${entry.assets.join(', ')}` : null,
    entry.noticePath ? `- Notice file: \`${entry.noticePath}\`` : null,
    entry.description ? `- Notes: ${entry.description}` : null,
    '',
  ].filter(Boolean);
}

function renderDependencyLicenseGroupMarkdown(license, entries) {
  const lines = [`### ${license} (${entries.length})`, ''];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const versionText = entry.versions?.length ? ` @ ${entry.versions.join(', ')}` : '';
    const linkText = entry.homepage ? ` — ${entry.homepage}` : '';
    lines.push(`- \`${entry.name}${versionText}\`${linkText}`);
    if (entry.author) {
      lines.push(`  - Author: ${entry.author}`);
    }
    if (entry.description) {
      lines.push(`  - Description: ${entry.description}`);
    }
  }

  lines.push('');
  return lines;
}

function groupBy(items, getKey) {
  const groups = {};
  for (const item of items) {
    const key = getKey(item);
    groups[key] ??= [];
    groups[key].push(item);
  }
  return groups;
}

main();
