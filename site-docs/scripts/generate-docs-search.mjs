import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { slugFromMdxFile } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = path.join(packageRoot, 'content', 'docs');
const outputPath = path.join(packageRoot, 'public', 'docs-search.json');

function listMdxFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listMdxFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.mdx') ? [entryPath] : [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function parseMdx(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source);
  if (!match) throw new Error(`Missing YAML frontmatter: ${path.relative(packageRoot, file)}`);

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`Invalid YAML frontmatter: ${path.relative(packageRoot, file)}`);
  }

  return { frontmatter, body: source.slice(match[0].length) };
}

function requireText(value, field, file) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field} in ${path.relative(packageRoot, file)}`);
  }
  return value.trim();
}

function searchableText(body) {
  return body
    .replace(/^import\s.+$/gmu, ' ')
    .replace(/```[^\n]*\n?/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~>#|{}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

const entries = ['en', 'zh'].flatMap((locale) => {
  const localeRoot = path.join(docsRoot, locale);
  return listMdxFiles(localeRoot).map((file) => {
    const { frontmatter, body } = parseMdx(file);
    const slug = slugFromMdxFile(file, localeRoot);
    const baseUrl = locale === 'zh' ? '/zh/docs' : '/docs';
    const url = slug.length === 0 ? baseUrl : `${baseUrl}/${slug}`;

    return {
      id: `${locale}:${slug || 'index'}`,
      locale,
      url,
      title: requireText(frontmatter.title, 'title', file),
      description: requireText(frontmatter.description, 'description', file),
      content: searchableText(body),
    };
  });
});

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(entries)}\n`, 'utf8');
process.stdout.write(`Generated public/docs-search.json from ${entries.length} docs\n`);
