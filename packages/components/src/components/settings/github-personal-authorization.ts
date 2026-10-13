/** Native clients hand off to the browser's authenticated workspace settings. */
export function getPersonalGitHubAuthorizationUrl(workspaceSlug: string): string {
  const siteUrl = import.meta.env.VITE_SITE_URL?.trim() || 'https://lody.ai';
  const url = new URL(`/${encodeURIComponent(workspaceSlug)}/settings/github`, siteUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid GitHub authorization site URL');
  }
  return url.toString();
}
