import { ProtocolError, INVALID_PARAMS, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { automationSkill } from './automations';
import { skillEntrySchema } from './catalog';

const bundles = [automationSkill];
const cache = { resultType: 'complete' as const, ttlMs: 300_000, cacheScope: 'public' as const };
const cacheSchema = z.object({
  resultType: z.literal('complete'),
  ttlMs: z.number(),
  cacheScope: z.literal('public'),
});
const metadata = z.record(z.string(), z.json()).optional();
export const LODY_SKILL_INSTRUCTIONS =
  'Automation guidance is available as a skill on this MCP server: skill://lody-automations/SKILL.md.';

/** Skill manifests and resource reads share the same immutable bundle. */
export function registerLodySkills(server: McpServer): void {
  server.server.registerCapabilities({
    resources: {},
    extensions: { 'io.modelcontextprotocol/skills': {} },
  });
  server.server.setRequestHandler(
    'skills/list',
    {
      params: z.object({ cursor: z.string().optional(), _meta: metadata }),
      result: cacheSchema.extend({ skills: z.array(skillEntrySchema) }),
    },
    (params) => {
      if (params.cursor !== undefined)
        throw new ProtocolError(INVALID_PARAMS, 'Unknown skill cursor');
      return { ...cache, skills: bundles.map(({ skill }) => skill) };
    }
  );
  server.server.setRequestHandler(
    'skills/get',
    {
      params: z.object({ uri: z.string(), _meta: metadata }),
      result: cacheSchema.extend({ skill: skillEntrySchema }),
    },
    ({ uri }) => {
      const bundle = bundles.find(({ skill }) => skill.uri === uri);
      if (!bundle) throw new ProtocolError(INVALID_PARAMS, 'Unknown Lody skill URI');
      return { ...cache, skill: bundle.skill };
    }
  );

  for (const bundle of bundles) {
    for (const file of bundle.files) {
      server.registerResource(
        file.uri === bundle.skill.uri ? bundle.skill.frontmatter.name : file.uri,
        file.uri,
        {
          mimeType: file.mimeType,
          description:
            file.uri === bundle.skill.uri ? bundle.skill.frontmatter.description : undefined,
          cacheHint: { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope },
        },
        () => ({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] })
      );
    }
  }
}
