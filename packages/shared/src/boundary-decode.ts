import { z } from 'zod';

/**
 * Sanitized diagnostic emitted when external data fails runtime schema validation.
 * Never includes raw values, tokens, emails, or other user content — only the
 * boundary name, counts, Zod issue codes, and normalized field paths.
 */
export type BoundaryDecodeDiagnostic = {
  boundary: string;
  kind: 'list_item_dropped' | 'invalid_payload';
  droppedCount?: number;
  totalCount?: number;
  issueCount: number;
  issueCodes: string[];
  paths: string[];
};

export type BoundaryDecodeOptions = {
  onDiagnostic?: (diagnostic: BoundaryDecodeDiagnostic) => void;
};

export type BoundaryDecodeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: BoundaryDecodeError };

export type BoundaryListDecodeResult<T> =
  | { ok: true; data: T[]; droppedCount: number }
  | { ok: false; error: BoundaryDecodeError };

const MAX_DIAGNOSTIC_ISSUES = 8;

function summarizeZodIssues(issues: readonly z.core.$ZodIssue[]): {
  issueCount: number;
  issueCodes: string[];
  paths: string[];
} {
  const issueCodes = new Set<string>();
  const paths = new Set<string>();
  for (const issue of issues) {
    if (issueCodes.size < MAX_DIAGNOSTIC_ISSUES) {
      issueCodes.add(issue.code);
    }
    if (paths.size < MAX_DIAGNOSTIC_ISSUES) {
      const formattedPath =
        issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '<root>';
      paths.add(formattedPath);
    }
  }
  return {
    issueCount: issues.length,
    issueCodes: [...issueCodes],
    paths: [...paths],
  };
}

export class BoundaryDecodeError extends Error {
  readonly boundary: string;
  readonly diagnostic: BoundaryDecodeDiagnostic;

  constructor(boundary: string, diagnostic: BoundaryDecodeDiagnostic) {
    const pathSuffix =
      diagnostic.paths.length > 0 ? ` (${diagnostic.paths.slice(0, 3).join(', ')})` : '';
    super(`Malformed external payload at ${boundary}${pathSuffix}`);
    this.name = 'BoundaryDecodeError';
    this.boundary = boundary;
    this.diagnostic = diagnostic;
  }
}

export function formatBoundaryDecodeDiagnostic(diagnostic: BoundaryDecodeDiagnostic): string {
  const parts = [`boundary=${diagnostic.boundary}`, `kind=${diagnostic.kind}`];
  if (diagnostic.droppedCount !== undefined && diagnostic.totalCount !== undefined) {
    parts.push(`dropped=${diagnostic.droppedCount}/${diagnostic.totalCount}`);
  }
  parts.push(`issues=${diagnostic.issueCount}`);
  if (diagnostic.issueCodes.length > 0) {
    parts.push(`codes=${diagnostic.issueCodes.join(',')}`);
  }
  if (diagnostic.paths.length > 0) {
    parts.push(`paths=${diagnostic.paths.join(',')}`);
  }
  return parts.join(' ');
}

/**
 * Decode a single external object with Zod `safeParse({ jitless: true })`.
 * Failures never leak half-parsed objects into application state; callers
 * receive a typed `BoundaryDecodeError` and a sanitized diagnostic callback.
 */
export function decodeExternalObject<T>(
  boundary: string,
  schema: z.ZodType<T>,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryDecodeResult<T> {
  const parsed = schema.safeParse(raw, { jitless: true });
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const summary = summarizeZodIssues(parsed.error.issues);
  const diagnostic: BoundaryDecodeDiagnostic = {
    boundary,
    kind: 'invalid_payload',
    ...summary,
  };
  options.onDiagnostic?.(diagnostic);
  return { ok: false, error: new BoundaryDecodeError(boundary, diagnostic) };
}

/**
 * Decode a nullable external object: `null` and `undefined` cleanly represent
 * absence, while any non-nullish value must satisfy `schema`.
 */
export function decodeNullableExternalObject<T>(
  boundary: string,
  schema: z.ZodType<T>,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryDecodeResult<T | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, data: null };
  }
  return decodeExternalObject(boundary, schema, raw, options);
}

/**
 * Decode a list of external items item-by-item: malformed or `null` elements
 * are dropped and reported via a sanitized diagnostic so a single orphaned or
 * corrupted record never crashes the list or page.
 *
 * Non-array inputs fail explicitly with `BoundaryDecodeError`.
 */
export function decodeExternalList<T>(
  boundary: string,
  itemSchema: z.ZodType<T>,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryListDecodeResult<T> {
  if (!Array.isArray(raw)) {
    const diagnostic: BoundaryDecodeDiagnostic = {
      boundary,
      kind: 'invalid_payload',
      issueCount: 1,
      issueCodes: ['invalid_type'],
      paths: ['<root>'],
    };
    options.onDiagnostic?.(diagnostic);
    return { ok: false, error: new BoundaryDecodeError(boundary, diagnostic) };
  }

  const valid: T[] = [];
  let droppedCount = 0;
  let totalIssues = 0;
  const issueCodes = new Set<string>();
  const paths = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const parsed = itemSchema.safeParse(raw[index], { jitless: true });
    if (parsed.success) {
      valid.push(parsed.data);
      continue;
    }
    droppedCount += 1;
    totalIssues += parsed.error.issues.length;
    for (const issue of parsed.error.issues) {
      if (issueCodes.size < MAX_DIAGNOSTIC_ISSUES) {
        issueCodes.add(issue.code);
      }
      if (paths.size < MAX_DIAGNOSTIC_ISSUES) {
        const subPath =
          issue.path.length > 0 ? `.${issue.path.map((segment) => String(segment)).join('.')}` : '';
        paths.add(`[${index}]${subPath}`);
      }
    }
  }

  if (droppedCount > 0) {
    options.onDiagnostic?.({
      boundary,
      kind: 'list_item_dropped',
      droppedCount,
      totalCount: raw.length,
      issueCount: totalIssues,
      issueCodes: [...issueCodes],
      paths: [...paths],
    });
  }

  return { ok: true, data: valid, droppedCount };
}

/**
 * Better Auth boundary schemas.
 * All object schemas use `.passthrough()` so plugin-specific fields (e.g.
 * `contentMode`, `metadata`, `createdAt`) survive unchanged while required
 * structural invariants are enforced at runtime.
 */
export const BetterAuthUserSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

export type BetterAuthUserPayload = z.infer<typeof BetterAuthUserSchema>;

export const BetterAuthSessionRecordSchema = z
  .object({
    id: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
  })
  .passthrough();

export const BetterAuthSessionPayloadSchema = z
  .object({
    user: BetterAuthUserSchema,
    session: BetterAuthSessionRecordSchema.nullable().optional(),
  })
  .passthrough();

export type BetterAuthSessionPayload = z.infer<typeof BetterAuthSessionPayloadSchema>;

export const BetterAuthOrganizationMemberSchema = z
  .object({
    userId: z.string().min(1),
    role: z.string().min(1),
  })
  .passthrough();

export type BetterAuthOrganizationMemberPayload = z.infer<
  typeof BetterAuthOrganizationMemberSchema
>;

export const BetterAuthOrganizationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    slug: z.string().nullable().optional(),
  })
  .passthrough();

export type BetterAuthOrganizationPayload = z.infer<typeof BetterAuthOrganizationSchema>;

export function decodeBetterAuthSession(
  boundary: string,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryDecodeResult<BetterAuthSessionPayload | null> {
  return decodeNullableExternalObject(boundary, BetterAuthSessionPayloadSchema, raw, options);
}

export function decodeBetterAuthOrganizations(
  boundary: string,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryDecodeResult<BetterAuthOrganizationPayload[] | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, data: null };
  }
  const decoded = decodeExternalList(boundary, BetterAuthOrganizationSchema, raw, options);
  if (!decoded.ok) {
    return decoded;
  }
  return { ok: true, data: decoded.data };
}

export function decodeBetterAuthActiveOrganization(
  boundary: string,
  raw: unknown,
  options: BoundaryDecodeOptions = {}
): BoundaryDecodeResult<BetterAuthOrganizationPayload | null> {
  const decoded = decodeNullableExternalObject(boundary, BetterAuthOrganizationSchema, raw, options);
  if (!decoded.ok || decoded.data === null) {
    return decoded;
  }
  const org = decoded.data;
  if (Array.isArray(org.members)) {
    const membersDecoded = decodeExternalList(
      `${boundary}.members`,
      BetterAuthOrganizationMemberSchema,
      org.members,
      options
    );
    if (membersDecoded.ok && membersDecoded.droppedCount > 0) {
      return {
        ok: true,
        data: {
          ...org,
          members: membersDecoded.data,
        },
      };
    }
  }
  return { ok: true, data: org };
}
