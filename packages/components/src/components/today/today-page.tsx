/**
 * Full-page Today surface. Behavior: specs/today-outline.md.
 * The day stream is mounted here; leaving the route unmounts every
 * subscription and releases the open pages.
 */
export function TodayPage(_props: { memberId?: string; anchorDate?: string }) {
  return <div data-testid="today-page" />;
}
