import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse } from 'yaml';

export const skillEntrySchema = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }).catchall(z.json()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number().int() })),
});

export type SkillFile = {
  uri: string;
  mimeType: string;
  text: string;
  digest: string;
  size: number;
};

/** Built-in skills ship as text in the bundle; caller URIs never reach the filesystem. */
export function bundleSkill(files: Record<string, string>) {
  const entry = files['SKILL.md'];
  if (!entry) throw new Error('Bundled skill requires SKILL.md');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entry)?.[1];
  if (!header) throw new Error('Bundled skill requires frontmatter');
  const frontmatter = skillEntrySchema.shape.frontmatter.parse(parse(header));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name) || frontmatter.name.length > 64)
    throw new Error('Invalid bundled skill name');
  const root = `skill://${frontmatter.name}/`;
  const resources = Object.entries(files).map(([name, text]): SkillFile => {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) ||
      name.split('/').some((part) => part === '..' || part === '.')
    )
      throw new Error('Invalid bundled skill path');
    return {
      uri: `${root}${name}`,
      mimeType: name.endsWith('.json')
        ? 'application/json'
        : name.endsWith('.js')
          ? 'text/javascript'
          : 'text/markdown',
      text,
      digest: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
      size: Buffer.byteLength(text, 'utf8'),
    };
  });
  const skill = {
    uri: `${root}SKILL.md`,
    frontmatter,
    resources: resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
  return { skill, files: resources };
}
