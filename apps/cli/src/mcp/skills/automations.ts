import { z } from 'zod';
import {
  automationCommandSchema,
  automationEmptyReadParametersSchema,
  automationEventReadParametersSchema,
  automationEventSchema,
  automationProgramContextSchema,
  automationReadResponseSchema,
  automationResultSchema,
} from '@lody/shared/automations';
import skill from './lody-automations/SKILL.md?raw';
import context from './lody-automations/references/context.md?raw';
import session from './lody-automations/references/session.md?raw';
import github from './lody-automations/references/github.md?raw';
import capacity from './lody-automations/references/capacity.md?raw';
import events from './lody-automations/references/events.md?raw';
import settings from './lody-automations/references/settings.md?raw';
import ci from '../../automations/examples/wait-for-ci.js?raw';
import { bundleSkill } from './catalog';

const schemaText = (schema: z.ZodType) =>
  `${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2)}\n`;

export const automationSkill = bundleSkill({
  'SKILL.md': skill,
  'references/context.md': context,
  'references/session.md': session,
  'references/github.md': github,
  'references/capacity.md': capacity,
  'references/events.md': events,
  'references/settings.md': settings,
  'examples/wait-for-ci.js': ci,
  'references/commands.schema.json': schemaText(automationCommandSchema),
  'references/context.schema.json': schemaText(
    z.object({
      context: automationProgramContextSchema,
      readParameters: z.object({
        session: automationEmptyReadParametersSchema,
        'session.group': automationEmptyReadParametersSchema,
        'github.pullRequests': automationEmptyReadParametersSchema,
        'github.workflowRuns': automationEmptyReadParametersSchema,
        'provider.capacity': automationEmptyReadParametersSchema,
        events: automationEventReadParametersSchema,
      }),
      readResponse: automationReadResponseSchema,
      result: automationResultSchema,
    })
  ),
  'references/events.schema.json': schemaText(automationEventSchema),
});
