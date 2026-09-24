import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The public site must not render the app's own components: every app refactor
 * used to be able to blank the landing. The product demo is a site-owned replica
 * (`components/landing-replica/`), so no site source may reach into the app.
 */
const SOURCE_DIRS = ['components', 'app', 'src', 'lib'];
const ROOT_FILES = ['vite.config.ts', 'source.config.ts'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.css']);
const FORBIDDEN_PACKAGES = ['@lody/components', '@lody/shared'];

const RULES = [
  {
    // `import … from '@/…'`, `import('@/…')`, `export … from '@/…'`
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]@\//gu,
    message: 'imports the app through the `@/*` alias',
  },
  {
    pattern:
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]@lody\/(?:components|shared)(?:\/[^'"]*)?['"]/gu,
    message: 'imports an app workspace package',
  },
  {
    // Only build inputs: demo copy legitimately names app file paths.
    pattern: /packages\/components\/src/gu,
    message: 'points at `packages/components/src` (alias, Tailwind @source, or path)',
    appliesTo: (file) => file.endsWith('.css') || ROOT_FILES.includes(path.basename(file)),
  },
];

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) {
    const full = path.join(root, dir);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // Directory absent in this tree.
    }
  }
  for (const file of ROOT_FILES) {
    const full = path.join(root, file);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      // File absent in this tree.
    }
  }
  return files;
}

/** Violations of the site ↔ app boundary under `root` (a site-docs checkout). */
export function findAppBoundaryViolations(root) {
  const violations = [];
  for (const file of listSourceFiles(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        if (rule.appliesTo && !rule.appliesTo(file)) continue;
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(line)) {
          violations.push(`${path.relative(root, file)}:${index + 1} ${rule.message}`);
        }
      }
    });
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of FORBIDDEN_PACKAGES) {
      if (manifest[field]?.[name]) {
        violations.push(`package.json ${field} depends on ${name}`);
      }
    }
  }
  return violations;
}
