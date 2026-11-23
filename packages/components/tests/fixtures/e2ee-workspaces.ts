export async function unexpectedE2eeWorkspaceOperation(): Promise<never> {
  throw new Error('unexpected encrypted workspace operation');
}
