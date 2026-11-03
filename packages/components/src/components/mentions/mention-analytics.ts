import { GitHubAuthError, hashAnalyticsId } from '@lody/shared';

import { capturePostHogEvent, type PostHogAnalyticsClient } from '@/lib/posthog-analytics';

/**
 * Surface where a mention menu is rendered. Threaded from the composer so
 * issue/PR and file mention funnels can be split by entry point (spec §8e).
 */
export type MentionSurface = 'chat_landing' | 'session_chat' | 'unknown';

/**
 * Where the @file suggestions come from. `worktree` is a local source backed by
 * a live session worktree rather than a registered local project (spec §8e).
 */
export type MentionFileSourceKind = 'github' | 'local' | 'worktree';

/**
 * Normalized GitHub fetch error codes (file paths + issue/PR). Free-text error
 * messages are PII-risky and unbreakable down for breakdowns, so we map to a
 * small enum and never send the raw message (spec §2.3 — `error`/`error_message`
 * are denylisted anyway, but we avoid passing them at all).
 */
export type MentionGithubFetchErrorCode =
  | 'offline'
  | 'auth_failed'
  | 'rate_limited'
  | 'not_found'
  | 'forbidden'
  | 'server_error'
  | 'network_error'
  | 'aborted'
  | 'unknown';

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function normalizeGithubFetchErrorCode(err: unknown): MentionGithubFetchErrorCode {
  if (err instanceof GitHubAuthError) return 'auth_failed';
  const message = toMessage(err).toLowerCase();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';

  // Surface HTTP status when the fetch layer encodes it in the message.
  const statusMatch = message.match(/\b(4\d\d|5\d\d)\b/);
  const status = statusMatch ? Number.parseInt(statusMatch[1] ?? '', 10) : null;
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth_failed';
  if (status === 403) return message.includes('rate') ? 'rate_limited' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status != null && status >= 500) return 'server_error';

  if (message.includes('rate limit')) return 'rate_limited';
  if (message.includes('unauthorized') || message.includes('token')) return 'auth_failed';
  if (message.includes('forbidden')) return 'forbidden';
  if (message.includes('not found')) return 'not_found';
  if (message.includes('abort')) return 'aborted';
  if (
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('load failed')
  ) {
    return 'network_error';
  }

  return 'unknown';
}

/**
 * Non-PII repo surrogate. Public repos can be sent as-is (already public on
 * GitHub); private repos are hashed so we can still group by repo without
 * leaking the org/name (spec §2.3).
 */
export function getRepoMentionAnalyticsId(
  repoFullName: string | null | undefined,
  isPublic: boolean | undefined
): string | null {
  if (!repoFullName) return null;
  if (isPublic) return repoFullName;
  return `private:${hashAnalyticsId(repoFullName.toLowerCase())}`;
}

type MentionAnalyticsBaseProps = {
  workspaceId?: string | null;
  surface?: MentionSurface;
};

function withBase(
  props: Record<string, unknown>,
  base: MentionAnalyticsBaseProps
): Record<string, unknown> {
  return {
    workspace_id: base.workspaceId ?? null,
    surface: base.surface ?? 'unknown',
    ...props,
  };
}

export function captureMentionMenuOpen(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: MentionAnalyticsBaseProps,
  props: { level: string; categoryCount: number }
): void {
  capturePostHogEvent(
    postHog,
    'mention/menu_open',
    withBase({ level: props.level, category_count: props.categoryCount }, base)
  );
}

export function captureMentionCategoryEnter(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: MentionAnalyticsBaseProps,
  props: { category: string; termLength: number }
): void {
  capturePostHogEvent(
    postHog,
    'mention/category_enter',
    withBase({ category: props.category, term_length: props.termLength }, base)
  );
}

export function captureMentionSelect(
  postHog: PostHogAnalyticsClient | null | undefined,
  base: MentionAnalyticsBaseProps,
  props: { category: string; level: string; rank: number; termLength: number }
): void {
  capturePostHogEvent(
    postHog,
    'mention/select',
    withBase(
      {
        category: props.category,
        level: props.level,
        rank: props.rank,
        term_length: props.termLength,
      },
      base
    )
  );
}
