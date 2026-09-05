import { schema } from 'loro-mirror';

import type { ScheduleDefinition, ScheduleActivity } from './schedule-types';

export const scheduleDocSchema = schema({
  definition: schema.LoroMap({
    scheduleId: schema.String(),
    title: schema.String(),
    ownerId: schema.String(),
    machineId: schema.String(),
    enabled: schema.Boolean(),
    activationId: schema.String(),
    activeFrom: schema.Number(),
    trigger: schema.Any<ScheduleDefinition['trigger']>(),
    misfirePolicy: schema.Any<ScheduleDefinition['misfirePolicy']>(),
    overlapPolicy: schema.String<ScheduleDefinition['overlapPolicy']>(),
    agent: schema.Any<ScheduleDefinition['agent']>(),
    project: schema.Any<ScheduleDefinition['project']>(),
    retryPolicy: schema.Any<ScheduleDefinition['retryPolicy']>(),
    createdAt: schema.Number(),
    updatedAt: schema.Number(),
    createdBy: schema.String(),
  }),
  prompt: schema.LoroText(),
  timeline: schema.LoroList(
    schema.LoroMap({
      id: schema.String(),
      kind: schema.String<ScheduleActivity['kind']>(),
      actorId: schema.String(),
      requesterSessionId: schema.String({ required: false }),
      createdAt: schema.Number(),
    }),
    (item: { id: string }) => item.id
  ),
});
