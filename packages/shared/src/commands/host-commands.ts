import { z } from 'zod';

const opened = z.strictObject({ includeOpenedSessions: z.boolean().optional() });
export const sessionCommandInputs = {
  sessionSetPinned: z.strictObject({ pinned: z.boolean() }),
  sessionSettle: opened.optional(),
  sessionMoveToFocus: opened.optional(),
  sessionSnooze: opened.extend({ until: z.number().finite() }),
  sessionUpdateTitle: z.strictObject({ title: z.string() }),
  sessionMarkRead: z.undefined(),
  sessionMarkUnread: z.undefined(),
  sessionMoveOrder: z.strictObject({
    to: z.discriminatedUnion('area', [
      z.strictObject({ area: z.literal('focus') }),
      z.strictObject({ area: z.literal('pinned'), sectionId: z.string().nullable() }),
    ]),
    beforeSessionId: z.string().nullable(),
  }),
};

export const lifecycleCommandInputs = {
  sessionFork: z.strictObject({ fromTurnId: z.string().min(1).optional() }).optional(),
  sessionArchive: z.undefined(),
  sessionRestore: z.undefined(),
  sessionStop: z.undefined(),
  sessionRespondInteraction: z.strictObject({
    requestId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    outcome: z.discriminatedUnion('outcome', [
      z.strictObject({
        outcome: z.literal('cancelled'),
        _meta: z.record(z.string(), z.json()).nullable().optional(),
      }),
      z.strictObject({
        outcome: z.literal('selected'),
        optionId: z.string().min(1),
        _meta: z.record(z.string(), z.json()).nullable().optional(),
      }),
    ]),
  }),
  sessionSend: z.strictObject({
    prompt: z.string().min(1),
    delivery: z.enum(['queue', 'steer']).optional(),
    attachments: z.tuple([]).optional(),
  }),
};
export const scheduleCommandInputs = {
  scheduleSetEnabled: z.strictObject({ scheduleId: z.string().min(1), enabled: z.boolean() }),
  scheduleRunNow: z.strictObject({ scheduleId: z.string().min(1) }),
};

import type { SessionId } from '../ids';
import type { StatusViewCommand } from '../status-view/command';
type Owners = {
  runStatusViewCommand(command: StatusViewCommand): Promise<unknown>;
  updateSessionTitle(id: SessionId, title: string): Promise<void>;
  markSessionRead(id: SessionId, at?: number | null): Promise<void>;
  markSessionUnread(id: SessionId): Promise<void>;
};
export function bindSessionCommands(owner: Owners) {
  return async (
    sessionId: SessionId,
    id: string,
    input?: unknown,
    renderedLastMessageAt?: number | null
  ) => {
    switch (id) {
      case 'sessionSetPinned':
        await owner.runStatusViewCommand({
          type: 'setPinned',
          sessionId,
          ...sessionCommandInputs[id].parse(input),
        });
        return;
      case 'sessionSnooze': {
        const opts = sessionCommandInputs[id].parse(input);
        await owner.runStatusViewCommand({
          type: 'snooze',
          sessionId,
          until: opts.until,
          includeOpened: opts.includeOpenedSessions === true,
        });
        return;
      }
      case 'sessionSettle':
      case 'sessionMoveToFocus':
        await owner.runStatusViewCommand({
          type: id === 'sessionSettle' ? 'settle' : 'moveToFocus',
          sessionId,
          includeOpened: sessionCommandInputs[id].parse(input)?.includeOpenedSessions === true,
        });
        return;
      case 'sessionMoveOrder': {
        const { to, beforeSessionId } = sessionCommandInputs[id].parse(input);
        await owner.runStatusViewCommand({
          type: 'move',
          sessionId,
          to,
          beforeId: beforeSessionId,
        });
        return;
      }
      case 'sessionMarkRead':
        sessionCommandInputs[id].parse(input);
        return owner.markSessionRead(sessionId, renderedLastMessageAt);
      case 'sessionMarkUnread':
        sessionCommandInputs[id].parse(input);
        return owner.markSessionUnread(sessionId);
      case 'sessionUpdateTitle':
        return owner.updateSessionTitle(sessionId, sessionCommandInputs[id].parse(input).title);
      default:
        throw Object.assign(new Error('Unsupported workspace command'), { code: 'unsupported' });
    }
  };
}
