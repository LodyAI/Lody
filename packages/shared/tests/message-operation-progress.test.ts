import { describe, expect, it } from 'vitest';

import { MessageContentSchema } from '../src/message-schemas';

describe('operation_progress message content schema', () => {
  it('accepts create operation progress cards', () => {
    expect(
      MessageContentSchema.parse({
        type: 'operation_progress',
        operationId: 'create-op.1',
        operationKind: 'session_create_many',
        items: [
          {
            target: { sessionId: 'session-1', userTurnId: 'turn-1' },
            label: 'first',
            status: 'created',
          },
          {
            target: { sessionId: 'session-2', userTurnId: 'turn-2' },
            status: 'running',
          },
          {
            target: { sessionId: 'session-3', userTurnId: 'turn-3' },
            status: 'succeeded',
          },
          {
            target: { sessionId: 'session-4', userTurnId: 'turn-4' },
            status: 'failed',
          },
          {
            target: { sessionId: 'session-5', userTurnId: 'turn-5' },
            status: 'cancelled',
          },
        ],
      })
    ).toMatchObject({ type: 'operation_progress' });
  });

  it('rejects progress for non-create operations', () => {
    expect(() =>
      MessageContentSchema.parse({
        type: 'operation_progress',
        operationId: 'chat-op',
        operationKind: 'session_chat',
        items: [{ target: { sessionId: 'session-1', userTurnId: 'turn-1' }, status: 'created' }],
      })
    ).toThrow();
  });

  it('accepts operation completion linked to an operation progress message', () => {
    expect(
      MessageContentSchema.parse({
        type: 'operation_completion',
        deliveryId: 'delivery-1',
        operationId: 'create-op.1',
        operationKind: 'session_create_many',
        progressMessageId: 'operation-progress:requester:create-op.1',
        completion: { type: 'result', value: { items: [] } },
      })
    ).toMatchObject({
      type: 'operation_completion',
      progressMessageId: 'operation-progress:requester:create-op.1',
    });
  });

  it('accepts an uncertain completion linked to progress', () => {
    expect(
      MessageContentSchema.parse({
        type: 'operation_completion',
        deliveryId: 'delivery-uncertain',
        operationId: 'create-op.uncertain',
        operationKind: 'session_create',
        progressMessageId: 'operation-progress:requester:create-op.uncertain',
        completion: { type: 'result', value: { items: [] } },
        continuation: {
          status: 'uncertain',
          reason: {
            code: 'DELIVERY_EXECUTION_UNCERTAIN',
            message: 'Execution may have started.',
          },
        },
      })
    ).toMatchObject({
      progressMessageId: 'operation-progress:requester:create-op.uncertain',
      continuation: { status: 'uncertain' },
    });
  });
});
