export type InboxResourceIdentity = {
  platform: NodeJS.Platform;
  roots: readonly number[];
  /** False (including legacy absence) while resource acquisition is unaccounted for. */
  complete?: boolean;
};
