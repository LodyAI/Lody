import {
  defineCollections,
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from 'fumadocs-mdx/config';
import { z } from 'zod';

const docsSchema = frontmatterSchema.extend({
  title: z.string(),
  description: z.string().optional(),
});

const changelogSchema = z.object({
  title: z.string(),
  version: z.string(),
  date: z.union([z.string(), z.date()]).optional(),
  description: z.string().optional(),
  draft: z.boolean().optional(),
});

const blogSchema = z.object({
  title: z.string(),
  date: z.union([z.string(), z.date()]).optional(),
  author: z.string().optional(),
  authorLink: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  tag: z.string().optional(),
  draft: z.boolean().optional(),
});

export const docsEn = defineDocs({
  dir: 'content/docs/en',
  docs: {
    schema: docsSchema,
  },
});

export const docsZh = defineDocs({
  dir: 'content/docs/zh',
  docs: {
    schema: docsSchema,
  },
});

export const docsZhHant = defineDocs({
  dir: 'content/docs/zh-hant',
  docs: {
    schema: docsSchema,
  },
});

export const docsJa = defineDocs({
  dir: 'content/docs/ja',
  docs: {
    schema: docsSchema,
  },
});

export const docsKo = defineDocs({
  dir: 'content/docs/ko',
  docs: {
    schema: docsSchema,
  },
});

export const docsEs = defineDocs({
  dir: 'content/docs/es',
  docs: {
    schema: docsSchema,
  },
});

export const docsFr = defineDocs({
  dir: 'content/docs/fr',
  docs: {
    schema: docsSchema,
  },
});

export const docsRu = defineDocs({
  dir: 'content/docs/ru',
  docs: {
    schema: docsSchema,
  },
});

export const changelogEn = defineCollections({
  type: 'doc',
  dir: 'content/changelog/en',
  schema: changelogSchema,
});

export const changelogZh = defineCollections({
  type: 'doc',
  dir: 'content/changelog/zh',
  schema: changelogSchema,
});

export const changelogZhHant = defineCollections({
  type: 'doc',
  dir: 'content/changelog/zh-hant',
  schema: changelogSchema,
});

export const changelogJa = defineCollections({
  type: 'doc',
  dir: 'content/changelog/ja',
  schema: changelogSchema,
});

export const changelogKo = defineCollections({
  type: 'doc',
  dir: 'content/changelog/ko',
  schema: changelogSchema,
});

export const changelogEs = defineCollections({
  type: 'doc',
  dir: 'content/changelog/es',
  schema: changelogSchema,
});

export const changelogFr = defineCollections({
  type: 'doc',
  dir: 'content/changelog/fr',
  schema: changelogSchema,
});

export const changelogRu = defineCollections({
  type: 'doc',
  dir: 'content/changelog/ru',
  schema: changelogSchema,
});

export const blogEn = defineCollections({
  type: 'doc',
  dir: 'content/blog/en',
  schema: blogSchema,
});

export const blogZh = defineCollections({
  type: 'doc',
  dir: 'content/blog/zh',
  schema: blogSchema,
});

export const blogZhHant = defineCollections({
  type: 'doc',
  dir: 'content/blog/zh-hant',
  schema: blogSchema,
});

export const blogJa = defineCollections({
  type: 'doc',
  dir: 'content/blog/ja',
  schema: blogSchema,
});

export const blogKo = defineCollections({
  type: 'doc',
  dir: 'content/blog/ko',
  schema: blogSchema,
});

export const blogEs = defineCollections({
  type: 'doc',
  dir: 'content/blog/es',
  schema: blogSchema,
});

export const blogFr = defineCollections({
  type: 'doc',
  dir: 'content/blog/fr',
  schema: blogSchema,
});

export const blogRu = defineCollections({
  type: 'doc',
  dir: 'content/blog/ru',
  schema: blogSchema,
});

const pageSchema = frontmatterSchema.extend({
  title: z.string(),
  description: z.string().optional(),
});

export const pagesEn = defineCollections({
  type: 'doc',
  dir: 'content/pages/en',
  schema: pageSchema,
});

export const pagesZh = defineCollections({
  type: 'doc',
  dir: 'content/pages/zh',
  schema: pageSchema,
});

export const pagesZhHant = defineCollections({
  type: 'doc',
  dir: 'content/pages/zh-hant',
  schema: pageSchema,
});

export const pagesJa = defineCollections({
  type: 'doc',
  dir: 'content/pages/ja',
  schema: pageSchema,
});

export const pagesKo = defineCollections({
  type: 'doc',
  dir: 'content/pages/ko',
  schema: pageSchema,
});

export const pagesEs = defineCollections({
  type: 'doc',
  dir: 'content/pages/es',
  schema: pageSchema,
});

export const pagesFr = defineCollections({
  type: 'doc',
  dir: 'content/pages/fr',
  schema: pageSchema,
});

export const pagesRu = defineCollections({
  type: 'doc',
  dir: 'content/pages/ru',
  schema: pageSchema,
});

export default defineConfig({});
