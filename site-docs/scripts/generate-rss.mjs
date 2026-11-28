import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { absoluteSiteUrl } from './site-paths.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(packageRoot, 'public');

const FEEDS = [
  {
    locale: 'en',
    file: 'rss.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'en'),
    base: '/blog',
    language: 'en-US',
    title: 'Lody Blog',
    description:
      'Engineering guides, product updates, and team workflows for running Claude Code, Codex, and ACP AI coding agents in parallel with Lody.',
  },
  {
    locale: 'zh',
    file: 'rss-zh.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'zh'),
    base: '/zh/blog',
    language: 'zh-CN',
    title: 'Lody 博客',
    description:
      '来自 Lody 团队的 AI 编程 Agent 工程实践、Claude Code / Codex 并行协作指南与产品发布故事。',
  },
  {
    locale: 'zh-hant',
    file: 'rss-zh-hant.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'zh-hant'),
    base: '/zh-hant/blog',
    language: 'zh-Hant',
    title: 'Lody 部落格',
    description:
      '來自 Lody 團隊的 AI 程式設計 Agent 工程實踐、Claude Code / Codex 並行協作指南與產品發布故事。',
  },
  {
    locale: 'ja',
    file: 'rss-ja.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'ja'),
    base: '/ja/blog',
    language: 'ja',
    title: 'Lody ブログ',
    description:
      'Lody チームによる Claude Code・Codex 並列開発ワークフロー、エンジニアリングノート、製品アップデートの記事一覧。',
  },
  {
    locale: 'ko',
    file: 'rss-ko.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'ko'),
    base: '/ko/blog',
    language: 'ko',
    title: 'Lody 블로그',
    description:
      'Lody 팀의 Claude Code·Codex 병렬 개발 워크플로, 엔지니어링 노트, 제품 출시 소식을 확인하세요.',
  },
  {
    locale: 'es',
    file: 'rss-es.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'es'),
    base: '/es/blog',
    language: 'es',
    title: 'Blog de Lody',
    description:
      'Guías prácticas, notas de ingeniería y lanzamientos del equipo de Lody sobre Claude Code, Codex y agentes de código IA en paralelo.',
  },
  {
    locale: 'fr',
    file: 'rss-fr.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'fr'),
    base: '/fr/blog',
    language: 'fr',
    title: 'Blog Lody',
    description:
      'Guides pratiques, notes d’ingénierie et annonces produit de l’équipe Lody autour de Claude Code, Codex et des agents de code IA en parallèle.',
  },
  {
    locale: 'ru',
    file: 'rss-ru.xml',
    dir: path.join(packageRoot, 'content', 'blog', 'ru'),
    base: '/ru/blog',
    language: 'ru',
    title: 'Блог Lody',
    description:
      'Практические руководства, инженерные заметки и анонсы команды Lody о параллельной работе с Claude Code, Codex и ACP ИИ-агентами.',
  },
];

function escapeXml(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function parseFrontmatter(file) {
  const source = readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(source);
  if (!match) throw new Error(`Missing YAML frontmatter: ${path.relative(packageRoot, file)}`);

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error(`Invalid YAML frontmatter: ${path.relative(packageRoot, file)}`);
  }
  return frontmatter;
}

/** Normalize `2026-08-26` or a YAML-parsed Date into an RFC 822 timestamp. */
function toRfc822(value) {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date.toUTCString() : undefined;
}

function sortKey(value) {
  if (value === undefined || value === null) return 0;
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function collectPosts(feed) {
  if (!statSync(feed.dir, { throwIfNoEntry: false })?.isDirectory()) return [];

  return readdirSync(feed.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdx'))
    .map((entry) => ({ file: path.join(feed.dir, entry.name), slug: entry.name.slice(0, -4) }))
    .map(({ file, slug }) => ({ slug, frontmatter: parseFrontmatter(file) }))
    .filter(({ frontmatter }) => frontmatter.draft !== true)
    .sort((a, b) => sortKey(b.frontmatter.date) - sortKey(a.frontmatter.date));
}

function renderItem(feed, { slug, frontmatter }) {
  const url = absoluteSiteUrl(`${feed.base}/${slug}`);
  const pubDate = toRfc822(frontmatter.date);

  return [
    '    <item>',
    `      <title>${escapeXml(String(frontmatter.title ?? slug))}</title>`,
    `      <link>${escapeXml(url)}</link>`,
    `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
    ...(typeof frontmatter.description === 'string'
      ? [`      <description>${escapeXml(frontmatter.description)}</description>`]
      : []),
    ...(pubDate ? [`      <pubDate>${pubDate}</pubDate>`] : []),
    ...(typeof frontmatter.author === 'string'
      ? [`      <dc:creator>${escapeXml(frontmatter.author)}</dc:creator>`]
      : []),
    ...(typeof frontmatter.tag === 'string'
      ? [`      <category>${escapeXml(frontmatter.tag)}</category>`]
      : []),
    '    </item>',
  ].join('\n');
}

let total = 0;
for (const feed of FEEDS) {
  const posts = collectPosts(feed);
  total += posts.length;
  const selfUrl = absoluteSiteUrl(`/${feed.file}`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(absoluteSiteUrl(feed.base))}</link>
    <description>${escapeXml(feed.description)}</description>
    <language>${feed.language}</language>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml"/>
${posts.map((post) => renderItem(feed, post)).join('\n')}
  </channel>
</rss>
`;

  writeFileSync(path.join(publicDir, feed.file), xml, 'utf8');
}

process.stdout.write(
  `Generated ${FEEDS.map((feed) => `public/${feed.file}`).join(', ')} from ${total} blog posts\n`
);
