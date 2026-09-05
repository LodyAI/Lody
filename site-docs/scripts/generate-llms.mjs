import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { LLMS_ANSWERS } from './llms-answers.mjs';
import { absoluteSiteUrl, slugFromMdxFile } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(packageRoot, 'public');
const docsRoot = path.join(packageRoot, 'content', 'docs');
const blogRoot = path.join(packageRoot, 'content', 'blog', 'en');

const PRODUCT_DESCRIPTION =
  'Lody is a team workspace for running AI coding agents in parallel with isolated Git worktrees, live diff review, GitHub integration, and mobile access.';

function listMdxFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMdxFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.mdx')) {
      files.push(entryPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function parseMdxFile(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source);
  if (!match) {
    throw new Error(`Missing YAML frontmatter: ${path.relative(packageRoot, file)}`);
  }

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`Invalid YAML frontmatter: ${path.relative(packageRoot, file)}`);
  }

  return {
    frontmatter,
    body: source.slice(match[0].length).trim(),
  };
}

function requireString(value, field, file) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing ${field} in ${path.relative(packageRoot, file)}`);
  }
  return value.trim();
}

function orderedDocsFiles(dir) {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!Array.isArray(meta.pages)) {
    throw new Error(`${path.relative(packageRoot, metaPath)} must contain a pages array`);
  }

  return meta.pages.flatMap((item) => {
    if (typeof item !== 'string' || item.startsWith('---')) return [];

    const itemPath = path.join(dir, item);
    if (statSync(itemPath, { throwIfNoEntry: false })?.isDirectory()) {
      return orderedDocsFiles(itemPath);
    }

    const file = `${itemPath}.mdx`;
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing docs page or folder: ${path.relative(packageRoot, itemPath)}`);
    }

    return [file];
  });
}

function validateDocsMetadata() {
  for (const locale of ['en', 'zh']) {
    const localeRoot = path.join(docsRoot, locale);
    for (const file of listMdxFiles(localeRoot)) {
      const { frontmatter } = parseMdxFile(file);
      requireString(frontmatter.title, 'title', file);
      requireString(frontmatter.description, 'description', file);
    }
  }
}

function docsEntries() {
  const localeRoot = path.join(docsRoot, 'en');
  return orderedDocsFiles(localeRoot).map((file) => {
    const { frontmatter, body } = parseMdxFile(file);
    const title = requireString(frontmatter.title, 'title', file);
    const description = requireString(frontmatter.description, 'description', file);
    const slug = slugFromMdxFile(file, localeRoot);
    const sitePath = slug.length === 0 ? '/docs' : `/docs/${slug}`;
    return { title, description, sitePath, body };
  });
}

function blogEntries() {
  return listMdxFiles(blogRoot)
    .map((file) => {
      const { frontmatter, body } = parseMdxFile(file);
      if (frontmatter.draft === true) return null;
      const slug = path.basename(file, '.mdx');
      return {
        title: requireString(frontmatter.title, 'title', file),
        description: requireString(frontmatter.description, 'description', file),
        sitePath: `/blog/${slug}`,
        body,
      };
    })
    .filter(Boolean);
}

function normalizeMdx(body) {
  return body
    .replace(/^# .+\r?\n+/u, '')
    .replace(/^(#{2,5})(?=\s)/gmu, '#$1')
    .replace(/<Callout\b[^>]*>\s*/gu, '')
    .replace(/\s*<\/Callout>/gu, '')
    .replace(/\]\((\/[^)\s]+)\)/gu, (_match, href) => `](${absoluteSiteUrl(href)})`)
    .replace(/src="(\/[^"]+)"/gu, (_match, href) => `src="${absoluteSiteUrl(href)}"`)
    .replace(/https:\/\/lody\.ai\/[A-Za-z0-9%_./#-]*/gu, (href) => {
      const url = new URL(href);
      return absoluteSiteUrl(`${url.pathname}${url.search}${url.hash}`);
    })
    .trim();
}

function renderLink(entry) {
  return `- [${entry.title}](${absoluteSiteUrl(entry.sitePath)}) - ${entry.description}`;
}

function renderAnswer(block) {
  const links = block.links
    .map((link) => `- [${link.title}](${absoluteSiteUrl(link.sitePath)})`)
    .join('\n');
  return `### ${block.question}

${block.answer}

${links}`;
}

function assertAnswerLinksExist(docs) {
  const known = new Set(docs.map((entry) => entry.sitePath));
  for (const block of LLMS_ANSWERS) {
    for (const link of block.links) {
      if (!known.has(link.sitePath)) {
        throw new Error(
          `llms answer link is not a current English docs path: ${link.sitePath} (from “${block.question}”)`
        );
      }
    }
  }
}

validateDocsMetadata();
const docs = docsEntries();
const blog = blogEntries();
assertAnswerLinksExist(docs);

const llms = `# Lody

> ${PRODUCT_DESCRIPTION}

Lody keeps coding-agent sessions, file changes, live diffs, previews, pull requests, CI state, notifications, and team context synchronized across desktop, web, and mobile.

For the complete English documentation in one file, read [llms-full.txt](${absoluteSiteUrl('/llms-full.txt')}).

## Product

- [Home](${absoluteSiteUrl('/')}) - Product overview and supported workflows.
- [Download](${absoluteSiteUrl('/download')}) - Desktop, mobile, and browser clients.
- [Pricing](${absoluteSiteUrl('/price')}) - Free, Plus, and Enterprise plans.
- [Changelog](${absoluteSiteUrl('/changelog')}) - Product updates and fixes.
- [Blog](${absoluteSiteUrl('/blog')}) - Product announcements and engineering posts.
- [Support](${absoluteSiteUrl('/support')}) - Documentation and contact options.

## Documentation

${docs.map(renderLink).join('\n')}

## Answers

${LLMS_ANSWERS.map(renderAnswer).join('\n\n')}

## Blog Posts

${blog.map(renderLink).join('\n')}

## External Links

- [GitHub](https://github.com/LodyAI/Lody) - Open-source CLI and local desktop.
- [Discord](https://discord.gg/E8mZtMu38s) - Community and support.
- [X](https://x.com/lody_ai) - Product updates.
- [Loro](https://loro.dev) - Local-first technology used by Lody.
- [ACP Registry](https://agentclientprotocol.com/get-started/registry) - Compatible coding-agent runtimes.
`;

const fullSections = [...docs, ...blog]
  .map(
    (entry) => `## ${entry.title}

Source: ${absoluteSiteUrl(entry.sitePath)}

${normalizeMdx(entry.body)}`
  )
  .join('\n\n');

const llmsFull = `# Lody Full Context

> ${PRODUCT_DESCRIPTION}

This file is generated from the current English Lody documentation and public blog content. Use [llms.txt](${absoluteSiteUrl('/llms.txt')}) for the shorter index.

${fullSections}
`;

mkdirSync(publicDir, { recursive: true });
writeFileSync(path.join(publicDir, 'llms.txt'), llms, 'utf8');
writeFileSync(path.join(publicDir, 'llms-full.txt'), llmsFull, 'utf8');

process.stdout.write(
  `Generated public/llms.txt and public/llms-full.txt from ${docs.length} docs and ${blog.length} blog posts\n`
);
