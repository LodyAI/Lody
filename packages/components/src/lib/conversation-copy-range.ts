/** Copy exactly the selected history prefix; a missing boundary must never copy later turns. */
export function conversationCopyRange<T extends { id: string }>(
  history: readonly T[],
  throughMessageId?: string
): T[] {
  const end =
    throughMessageId === undefined
      ? history.length - 1
      : history.findIndex((entry) => entry.id === throughMessageId);
  if (throughMessageId !== undefined && end < 0) throw new Error('Copy boundary no longer exists');
  return history.slice(0, end + 1);
}
