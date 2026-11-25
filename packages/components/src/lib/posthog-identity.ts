import type { CurrentUser } from './current-user';

export function identifyPostHogUser(
  client: { identify: (id: string) => void } | null | undefined,
  user: CurrentUser | string | null | undefined
): void {
  const id = typeof user === 'string' ? user : user?.id;
  if (id && /^[a-zA-Z0-9_-]{1,128}$/.test(id)) client?.identify(id);
}
