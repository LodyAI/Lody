import type { ChatFailedReason } from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
} as const;

export type ParsedACPError = {
  code: number;
  message: string;
  data?: unknown;
};

const getStringField = (value: unknown, field: string): string | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : undefined;
};

const getACPErrorDataMessages = (data: unknown): string[] => {
  const messages: string[] = [];
  if (typeof data === 'string' && data.length > 0) {
    messages.push(data);
  }
  const details = getStringField(data, 'details');
  if (details) {
    messages.push(details);
  }
  const message = getStringField(data, 'message');
  if (message) {
    messages.push(message);
  }
  return messages;
};

const getACPDiagnosticText = (error: unknown, parsedError?: ParsedACPError | null): string => {
  const parsed = parsedError ?? parseACPError(error);
  if (parsed) {
    return [parsed.message, ...getACPErrorDataMessages(parsed.data)].join('\n');
  }
  return formatErrorMessage(error);
};

const AUTHENTICATION_REQUIRED_PATTERNS = [
  /\bnot logged in\b/i,
  /\bauthentication required\b/i,
  /\bplease run\s+\/login\b/i,
  /\bsession expired\b[\s\S]{0,160}\b(?:log|sign) in again\b/i,
  /\brefresh token\b[\s\S]{0,160}\b(?:already used|expired|revoked|cannot be refreshed|could not be refreshed)\b/i,
  /\baccess token\b[\s\S]{0,160}\bcould not be refreshed\b[\s\S]{0,160}\brefresh token\b/i,
] as const;

export const parseACPError = (error: unknown): ParsedACPError | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const errorObj = error as Record<string, unknown>;
  if (typeof errorObj.code === 'number' && typeof errorObj.message === 'string') {
    return {
      code: errorObj.code,
      message: errorObj.message,
      data: errorObj.data,
    };
  }

  return null;
};

export const getACPErrorUserMessage = (error: ParsedACPError): string => {
  const [firstDataMessage] = getACPErrorDataMessages(error.data);
  return firstDataMessage ?? error.message;
};

export const isUpstreamApiACPError = (error: ParsedACPError): boolean =>
  /API Error:\s*(?:500|502|503|529)\b/.test(getACPDiagnosticText(error, error));

export const isAgentDisconnectedError = (error: unknown): boolean => {
  const errorMessage = getACPDiagnosticText(error).toLowerCase();
  return (
    errorMessage.includes('connection is disposed') ||
    errorMessage.includes('acp connection closed') ||
    errorMessage.includes('not ready for writing') ||
    errorMessage.includes('processtransport') ||
    (errorMessage.includes('process') && errorMessage.includes('not ready'))
  );
};

export const isAcpSessionNotFoundError = (error: unknown): boolean => {
  const parsed = parseACPError(error);
  if (parsed?.code !== ACP_ERROR_CODES.INTERNAL_ERROR) {
    return false;
  }
  return /\bsession not found\b/i.test(getACPDiagnosticText(error, parsed));
};

/**
 * Some provider runtimes still wrap expired OAuth credentials in an ACP
 * internal error instead of using ACP's dedicated auth-required code. Keep the
 * compatibility match narrow and limited to provider-owned instructions that
 * explicitly require another login.
 */
export const isAuthenticationRequiredACPError = (error: unknown): boolean => {
  const parsed = parseACPError(error);
  if (parsed?.code === ACP_ERROR_CODES.AUTH_REQUIRED) {
    return true;
  }
  const diagnosticText = getACPDiagnosticText(error, parsed);
  return AUTHENTICATION_REQUIRED_PATTERNS.some((pattern) => pattern.test(diagnosticText));
};

export const mapACPErrorToFailureReason = (error: ParsedACPError): ChatFailedReason => {
  if (isAuthenticationRequiredACPError(error)) {
    return 'acp_auth_required';
  }
  switch (error.code) {
    case ACP_ERROR_CODES.INTERNAL_ERROR:
      // Some ACP adapters wrap a stale JSON-RPC transport as "-32603 Internal error".
      // Treat known transport-disposal text as a recoverable agent disconnect instead
      // of surfacing a generic "Agent internal error" to users.
      if (isAgentDisconnectedError(error) || isAcpSessionNotFoundError(error)) {
        return 'agent_disconnected';
      }
      if (isUpstreamApiACPError(error)) {
        return 'acp_upstream_api_error';
      }
      return 'acp_internal_error';
    case ACP_ERROR_CODES.RESOURCE_NOT_FOUND:
      return 'acp_resource_not_found';
    case ACP_ERROR_CODES.REQUEST_CANCELLED:
      return 'acp_request_cancelled';
    case ACP_ERROR_CODES.METHOD_NOT_FOUND:
      return 'acp_method_not_found';
    case ACP_ERROR_CODES.INVALID_PARAMS:
      return 'acp_invalid_params';
    case ACP_ERROR_CODES.INVALID_REQUEST:
      return 'acp_invalid_request';
    case ACP_ERROR_CODES.PARSE_ERROR:
      return 'acp_parse_error';
    default:
      return 'acp_unknown_error';
  }
};

export const shouldTerminateOnACPError = (
  error: ParsedACPError,
  failureReason: ChatFailedReason
): boolean => {
  if (failureReason === 'acp_auth_required') {
    return true;
  }
  if (failureReason === 'acp_upstream_api_error') {
    return false;
  }
  return error.code === ACP_ERROR_CODES.INTERNAL_ERROR;
};

export const shouldRecoverStaleACPConnectionPrompt = (args: {
  error: unknown;
  alreadyAttempted: boolean;
  hasPromptOutput: boolean;
}): boolean =>
  !args.alreadyAttempted &&
  !args.hasPromptOutput &&
  (isAgentDisconnectedError(args.error) || isAcpSessionNotFoundError(args.error));
