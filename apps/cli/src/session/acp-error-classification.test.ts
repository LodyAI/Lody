import { describe, expect, it } from 'vitest';
import {
  ACP_ERROR_CODES,
  getACPErrorUserMessage,
  isAuthenticationRequiredACPError,
  isAgentDisconnectedError,
  isAcpSessionNotFoundError,
  mapACPErrorToFailureReason,
  parseACPError,
  shouldRecoverStaleACPConnectionPrompt,
  shouldTerminateOnACPError,
} from './acp-error-classification';

describe('ACP error classification', () => {
  it('parses JSON-RPC ACP errors', () => {
    expect(
      parseACPError({
        code: ACP_ERROR_CODES.INTERNAL_ERROR,
        message: 'Internal error',
        data: { details: 'Connection is disposed.' },
      })
    ).toEqual({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Connection is disposed.' },
    });
  });

  it('maps disposed ACP connections to agent_disconnected', () => {
    const error = {
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Connection is disposed.' },
    };
    const parsed = parseACPError(error);

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(isAgentDisconnectedError(error)).toBe(true);
    expect(mapACPErrorToFailureReason(parsed)).toBe('agent_disconnected');
    expect(shouldTerminateOnACPError(parsed, 'agent_disconnected')).toBe(true);
  });

  it('maps missing ACP adapter sessions to agent_disconnected', () => {
    const error = {
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Session not found' },
    };
    const parsed = parseACPError(error);

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(isAcpSessionNotFoundError(error)).toBe(true);
    expect(mapACPErrorToFailureReason(parsed)).toBe('agent_disconnected');
    expect(shouldTerminateOnACPError(parsed, 'agent_disconnected')).toBe(true);
  });

  it('keeps upstream API failures retryable without terminating the session', () => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'API Error: 500 {"error":{"message":"overloaded"}}' },
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(mapACPErrorToFailureReason(parsed)).toBe('acp_upstream_api_error');
    expect(shouldTerminateOnACPError(parsed, 'acp_upstream_api_error')).toBe(false);
  });

  it('keeps ordinary internal errors classified as acp_internal_error', () => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Agent invariant failed' },
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(mapACPErrorToFailureReason(parsed)).toBe('acp_internal_error');
  });

  it.each([
    'Not logged in · Please run /login',
    'Session expired. Please run /login to sign in again.',
    'refresh token cannot be refreshed',
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
  ])('maps provider reauthentication errors to acp_auth_required: %s', (details) => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details },
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(isAuthenticationRequiredACPError(parsed)).toBe(true);
    expect(mapACPErrorToFailureReason(parsed)).toBe('acp_auth_required');
    expect(shouldTerminateOnACPError(parsed, 'acp_auth_required')).toBe(true);
  });

  it('does not treat unrelated token refresh errors as provider login failures', () => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Failed to refresh the model catalog cache token' },
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(isAuthenticationRequiredACPError(parsed)).toBe(false);
    expect(mapACPErrorToFailureReason(parsed)).toBe('acp_internal_error');
  });

  it('does not treat non-internal session-not-found errors as stale ACP sessions', () => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INVALID_PARAMS,
      message: 'Session not found',
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(isAcpSessionNotFoundError(parsed)).toBe(false);
    expect(mapACPErrorToFailureReason(parsed)).toBe('acp_invalid_params');
  });

  it('prefers ACP data details for user-facing diagnostics', () => {
    const parsed = parseACPError({
      code: ACP_ERROR_CODES.INVALID_PARAMS,
      message: 'Invalid params',
      data: { details: 'missing prompt' },
    });

    if (!parsed) {
      throw new Error('expected ACP error to parse');
    }
    expect(getACPErrorUserMessage(parsed)).toBe('missing prompt');
  });

  it('only retries stale prompt failures once and before prompt output', () => {
    const error = {
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Connection is disposed.' },
    };

    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: false,
        hasPromptOutput: false,
      })
    ).toBe(true);
    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: true,
        hasPromptOutput: false,
      })
    ).toBe(false);
    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: false,
        hasPromptOutput: true,
      })
    ).toBe(false);
  });

  it('retries missing ACP adapter sessions only once and before prompt output', () => {
    const error = {
      code: ACP_ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal error',
      data: { details: 'Session not found' },
    };

    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: false,
        hasPromptOutput: false,
      })
    ).toBe(true);
    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: true,
        hasPromptOutput: false,
      })
    ).toBe(false);
    expect(
      shouldRecoverStaleACPConnectionPrompt({
        error,
        alreadyAttempted: false,
        hasPromptOutput: true,
      })
    ).toBe(false);
  });
});
