/// <reference path="./semver.d.ts" />
import satisfies from 'semver/functions/satisfies.js';
import sdkPackage from '../../../plugin-sdk/package.json' with { type: 'json' };
import { z } from 'zod';

const text = z.string().min(1);
const opt = z.string().optional();
export const pluginIdSchema = text.max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const descriptorIdSchema = text.max(96).regex(/^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/);
const relativePath = text
  .transform((p) => (p.startsWith('./') ? p.slice(2) : p))
  .refine(
    (p) =>
      !/[\\:\x00-\x1f]/.test(p) && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
const paths = relativePath.array().optional();
const keys = text.array().optional();
const obj = z.strictObject;
const meta = { label: text, description: opt, required: z.boolean().optional() };
const field = { ...meta, scope: z.enum(['client', 'machine', 'project', 'both']).optional() };
const num = z.number().optional();
const configField = z.discriminatedUnion('type', [
  obj({ ...field, type: z.literal('string'), default: opt, placeholder: opt }),
  obj({
    ...meta,
    type: z.literal('secret'),
    scope: z.literal('machine').optional(),
    placeholder: opt,
  }),
  obj({ ...field, type: z.literal('number'), default: num, min: num, max: num, step: num }),
  obj({ ...field, type: z.literal('boolean'), default: z.boolean().optional() }),
  obj({
    ...field,
    type: z.literal('select'),
    options: obj({ value: text, label: text, description: opt }).array().min(1),
    default: opt,
  }),
]);
const contribution = {
  id: descriptorIdSchema,
  title: text,
  description: opt,
  entry: relativePath,
  envKeys: keys,
};
const theme = {
  id: descriptorIdSchema,
  label: text,
  appearance: z.enum(['dark', 'light']),
  tokens: obj({
    fontSans: opt,
    fontMono: opt,
    radius: opt,
    density: z.enum(['compact', 'comfortable', 'spacious']).optional(),
  }).optional(),
};
export const pluginManifestSchema = obj({
  id: pluginIdSchema,
  version: z
    .string()
    .regex(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[\da-zA-Z-]*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[\da-zA-Z-]*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/
    ),
  permissions: z
    .array(
      z.enum(['workflow.autonomous', 'sessions.write', 'sessions.approve', 'unstable.rawState'])
    )
    .optional(),
  sdk: text
    .max(512)
    .refine(
      (range) => Boolean(range.trim()) && satisfies(sdkPackage.version, range),
      `SDK range must include host version ${sdkPackage.version}`
    ),
  title: text,
  description: opt,
  client: relativePath.optional(),
  machine: relativePath.optional(),
  config: z.record(text, configField).optional(),
  onboarding: obj({ title: text, summary: opt, fields: text.array() }).optional(),
  skills: descriptorIdSchema.array().optional(),
  agentRoles: obj({
    id: descriptorIdSchema,
    name: text,
    description: opt,
    emoji: opt,
    promptPath: relativePath,
    skills: keys,
    mcpServers: keys,
    defaultProvider: opt,
  })
    .array()
    .optional(),
  mcpServers: obj({ ...contribution, transport: z.enum(['stdio', 'http']), args: keys })
    .array()
    .optional(),
  acpProviders: obj({
    ...contribution,
    capabilities: obj({
      loadSession: z.boolean().optional(),
      subagentEvents: z.boolean().optional(),
      configOptions: z.boolean().optional(),
    }).optional(),
  })
    .array()
    .optional(),
  themes: z
    .union([
      obj({ ...theme, path: relativePath }),
      obj({
        ...theme,
        seed: obj({
          bg: text,
          fg: text,
          accent: text,
          surface: opt,
          border: opt,
          muted: opt,
          success: opt,
          warning: opt,
          danger: opt,
        }),
      }),
    ])
    .array()
    .optional(),
  styles: paths,
  assets: paths,
})
  .refine(
    (m) =>
      Boolean(
        m.client ||
        m.machine ||
        [m.skills, m.agentRoles, m.mcpServers, m.acpProviders, m.themes, m.styles].some(
          (a) => a?.length
        )
      ),
    'Expected a plugin contribution'
  )
  .refine(
    (m) => m.onboarding?.fields.every((k) => Object.hasOwn(m.config ?? {}, k)) ?? true,
    'Unknown onboarding field'
  )
  .refine(
    (m) =>
      [...(m.mcpServers ?? []), ...(m.acpProviders ?? [])].every((c) =>
        (c.envKeys ?? []).every((k) => {
          const f = m.config?.[k];
          return (
            f?.type === 'secret' ||
            (f?.type === 'string' && f.scope !== 'project' && f.scope !== 'client')
          );
        })
      ),
    'Environment keys must reference string or secret configuration fields'
  );
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
