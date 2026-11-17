/** Typed, handled Shortcut result failures have one operation-owned diagnostic. */
export const HANDLED_SHORTCUT_TOKEN_ERROR = 'LodyShortcutTokenFailure';

export const MISSING_EMAIL_DOMAIN = 'missing-email.lody.invalid';
export const MISSING_EMAIL_PREFIX = 'missing-email';

export const CONVEX_AUTH_ERROR_CODE = {
  unauthenticated: 'unauthenticated',
} as const;
export const CONVEX_AUTH_ERROR_KIND = 'lody.auth' as const;

export type ConvexAuthErrorCode =
  (typeof CONVEX_AUTH_ERROR_CODE)[keyof typeof CONVEX_AUTH_ERROR_CODE];

export type ConvexAuthErrorData = {
  kind: typeof CONVEX_AUTH_ERROR_KIND;
  code: ConvexAuthErrorCode;
};

const CONVEX_ERROR_IDENTIFYING_FIELD = Symbol.for('ConvexError');

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

export const isConvexAuthErrorData = (value: unknown): value is ConvexAuthErrorData =>
  isRecord(value) &&
  value.kind === CONVEX_AUTH_ERROR_KIND &&
  value.code === CONVEX_AUTH_ERROR_CODE.unauthenticated;

export const isConvexError = (error: unknown): boolean =>
  isRecord(error) && error.name === 'ConvexError' && error[CONVEX_ERROR_IDENTIFYING_FIELD] === true;

export const getConvexAuthErrorCode = (error: unknown): ConvexAuthErrorCode | null => {
  if (!isConvexError(error) || !isConvexAuthErrorData((error as { data?: unknown }).data)) {
    return null;
  }
  return (error as { data: ConvexAuthErrorData }).data.code;
};

export const isConvexUnauthenticatedError = (error: unknown): boolean =>
  getConvexAuthErrorCode(error) === CONVEX_AUTH_ERROR_CODE.unauthenticated;

const sanitizeIdentifier = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '') || 'unknown';

export const buildMissingEmail = (providerId: string, providerUserId: string | number) => {
  const safeProvider = sanitizeIdentifier(providerId);
  const safeId = sanitizeIdentifier(String(providerUserId));
  return `${MISSING_EMAIL_PREFIX}+${safeProvider}-${safeId}@${MISSING_EMAIL_DOMAIN}`;
};

export const isMissingEmail = (email?: string | null) =>
  Boolean(email) && email!.endsWith(`@${MISSING_EMAIL_DOMAIN}`);
