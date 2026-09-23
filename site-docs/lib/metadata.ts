const SITE_URL = 'https://lody.ai';
const OG_IMAGE_PATH = '/og-image.png';
const DEFAULT_DESCRIPTION =
  'Lody is a team workspace for running AI coding agents in parallel with isolated Git worktrees, live diff review, GitHub integration, and mobile access.';

/** Append `| Lody` to a document head title unless it is already branded. */
export function brandTitle(title: string, brand = 'Lody'): string {
  if (!title) return brand;
  if (title.toLowerCase().includes(brand.toLowerCase())) return title;
  if (/(?:\| Lody|– Lody|- Lody)$/u.test(title)) return title;
  return `${title} | ${brand}`;
}

type Alternate = {
  lang: 'en-US' | 'zh-CN';
  path: string;
};

type Robots = {
  index?: boolean;
  follow?: boolean;
};

export type SiteHead = {
  meta: Array<Record<string, string>>;
  links: Array<Record<string, string>>;
  /** Optional raw <script> tags (e.g. JSON-LD) for the document head. */
  scripts?: Array<{ type?: string; children?: string }>;
};

function absoluteUrl(path: string): string {
  const url = new URL(path, SITE_URL);
  if (url.pathname !== '/' && !url.pathname.endsWith('/') && !/\.[^/]+$/u.test(url.pathname)) {
    url.pathname += '/';
  }
  return url.toString();
}

function robotsContent(robots: Robots | undefined): string | undefined {
  if (!robots) return undefined;
  const directives = [];
  directives.push(robots.index === false ? 'noindex' : 'index');
  directives.push(robots.follow === false ? 'nofollow' : 'follow');
  return directives.join(', ');
}

export function pageHead(args: {
  title: string;
  description?: string;
  path: string;
  locale: 'en-US' | 'zh-CN';
  type?: 'website' | 'article';
  publishedTime?: string;
  image?: string;
  alternates?: Alternate[];
  robots?: Robots;
  /** Extra <link> tags appended after canonical/alternates (e.g. RSS feeds). */
  links?: Array<Record<string, string>>;
  /** Serialized JSON-LD object (placed in head as application/ld+json). */
  jsonLd?: Record<string, unknown> | readonly Record<string, unknown>[];
}): SiteHead {
  const description = args.description ?? DEFAULT_DESCRIPTION;
  const canonical = absoluteUrl(args.path);
  const image = absoluteUrl(args.image ?? OG_IMAGE_PATH);
  const robots = robotsContent(args.robots);
  const jsonLdNodes = args.jsonLd ? (Array.isArray(args.jsonLd) ? args.jsonLd : [args.jsonLd]) : [];

  return {
    meta: [
      { title: args.title },
      { name: 'description', content: description },
      ...(robots ? [{ name: 'robots', content: robots }] : []),
      { property: 'og:title', content: args.title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: canonical },
      { property: 'og:site_name', content: 'Lody' },
      { property: 'og:locale', content: args.locale.replace('-', '_') },
      { property: 'og:type', content: args.type ?? 'website' },
      { property: 'og:image', content: image },
      ...(args.publishedTime
        ? [{ property: 'article:published_time', content: args.publishedTime }]
        : []),
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: args.title },
      { name: 'twitter:description', content: description },
      { name: 'twitter:image', content: image },
    ],
    links: [
      { rel: 'canonical', href: canonical },
      ...(args.alternates ?? []).map((alternate) => ({
        rel: 'alternate',
        hrefLang: alternate.lang,
        href: absoluteUrl(alternate.path),
      })),
      ...(args.alternates && args.alternates.length > 0
        ? [
            {
              rel: 'alternate',
              hrefLang: 'x-default',
              href: absoluteUrl(args.alternates[0]?.path ?? args.path),
            },
          ]
        : []),
      ...(args.links ?? []),
    ],
    scripts: jsonLdNodes.map((node) => ({
      type: 'application/ld+json',
      children: JSON.stringify(node),
    })),
  };
}
