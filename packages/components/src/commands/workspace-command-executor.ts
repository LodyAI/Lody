import { sessionCommandInputs as inputs } from '@lody/shared/commands/host-commands';
import type { SessionId } from '@lody/shared';
import type { SessionActions } from '../hooks/use-session-actions';

type Owners = Pick<
  SessionActions,
  'runStatusViewCommand' | 'updateSessionTitle' | 'markSessionRead' | 'markSessionUnread'
>;
export function createWorkspaceCommandExecutor(owner: Owners) {
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
          ...inputs[id].parse(input),
        });
        return;
      case 'sessionSnooze': {
        const opts = inputs[id].parse(input);
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
          includeOpened: inputs[id].parse(input)?.includeOpenedSessions === true,
        });
        return;
      case 'sessionMoveOrder': {
        const { to, beforeSessionId } = inputs[id].parse(input);
        await owner.runStatusViewCommand({
          type: 'move',
          sessionId,
          to,
          beforeId: beforeSessionId,
        });
        return;
      }
      case 'sessionMarkRead':
        inputs[id].parse(input);
        return owner.markSessionRead(sessionId, renderedLastMessageAt);
      case 'sessionMarkUnread':
        inputs[id].parse(input);
        return owner.markSessionUnread(sessionId);
      case 'sessionUpdateTitle':
        return owner.updateSessionTitle(sessionId, inputs[id].parse(input).title);
      default:
        throw Object.assign(new Error('Unsupported workspace command'), { code: 'unsupported' });
    }
  };
}
