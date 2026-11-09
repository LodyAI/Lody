export const isLoroRepoDocDeleted = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    exists?: unknown;
    e?: unknown;
    deleted?: unknown;
  };

  if (typeof candidate.exists === 'boolean') {
    return !candidate.exists;
  }

  if (typeof candidate.e === 'boolean') {
    return !candidate.e;
  }

  if (typeof candidate.deleted === 'boolean') {
    return candidate.deleted;
  }

  return false;
};
