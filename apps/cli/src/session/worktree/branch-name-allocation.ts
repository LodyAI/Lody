const DEFAULT_MAX_CANDIDATES = 1_000;

export type AvailableBranchNameOptions = {
  maxLength?: number;
  maxCandidates?: number;
};

const normalizeBranchNameForLength = (branchName: string, maxLength?: number): string => {
  const trimmed = branchName.trim();
  if (!trimmed) {
    throw new Error('Branch name is required');
  }
  if (maxLength === undefined || trimmed.length <= maxLength) {
    return trimmed;
  }
  const shortened = trimmed.slice(0, maxLength).replace(/[-./]+$/g, '');
  if (!shortened) {
    throw new Error(`Branch name cannot fit within ${maxLength} characters`);
  }
  return shortened;
};

const appendBranchNameSuffix = (
  baseName: string,
  candidateNumber: number,
  maxLength?: number,
  blockingAncestor?: string
): string => {
  if (candidateNumber === 1) {
    return normalizeBranchNameForLength(baseName, maxLength);
  }
  const suffix = `-${candidateNumber}`;
  if (blockingAncestor) {
    return normalizeBranchNameForLength(
      `${blockingAncestor}${suffix}${baseName.slice(blockingAncestor.length)}`,
      maxLength
    );
  }
  const maxBaseLength = maxLength === undefined ? undefined : maxLength - suffix.length;
  if (maxBaseLength !== undefined && maxBaseLength < 1) {
    throw new Error(`Branch suffix ${suffix} cannot fit within ${maxLength} characters`);
  }
  return `${normalizeBranchNameForLength(baseName, maxBaseLength)}${suffix}`;
};

export const hasLocalBranchNameConflict = (
  candidate: string,
  existingBranchNames: Iterable<string>
): boolean => {
  for (const existing of existingBranchNames) {
    if (
      existing === candidate ||
      existing.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${existing}/`)
    ) {
      return true;
    }
  }
  return false;
};

export const resolveAvailableBranchName = (
  desiredBranchName: string,
  existingBranchNames: Iterable<string>,
  options: AvailableBranchNameOptions = {}
): string => {
  const existing = Array.from(existingBranchNames, (branchName) => branchName.trim()).filter(
    Boolean
  );
  const normalizedDesired = normalizeBranchNameForLength(desiredBranchName, options.maxLength);
  const blockingAncestor = existing
    .filter((branchName) => normalizedDesired.startsWith(`${branchName}/`))
    .sort((left, right) => right.length - left.length)[0];
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  for (let candidateNumber = 1; candidateNumber <= maxCandidates; candidateNumber += 1) {
    const candidate = appendBranchNameSuffix(
      normalizedDesired,
      candidateNumber,
      options.maxLength,
      blockingAncestor
    );
    if (!hasLocalBranchNameConflict(candidate, existing)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find an available branch name for ${desiredBranchName}`);
};

/** The allocation scheme is shared by creation and first-task prompt eligibility. */
export const getAllocatedSessionBranchName = (sessionId: string, localShared: boolean): string => {
  if (!localShared) return `session/${sessionId.slice(0, 8)}`;
  const shortId = sessionId
    .slice(0, 12)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 12);
  return `lody/${shortId || sessionId.slice(0, 8)}`;
};

const matchesAllocatedPart = (actual: string, allocated: string): boolean => {
  if (actual === allocated) return true;
  if (!actual.startsWith(`${allocated}-`)) return false;
  const suffix = actual.slice(allocated.length + 1);
  return /^[1-9]\d*$/.test(suffix) && Number(suffix) >= 2;
};

export const isAllocatedSessionBranchName = (branchName: string, sessionId: string): boolean => {
  const parts = branchName.split('/');
  const [actualNamespace, actualName] = parts;
  if (parts.length !== 2 || !actualNamespace || !actualName) return false;
  return [false, true].some((localShared) => {
    const [namespace, name] = getAllocatedSessionBranchName(sessionId, localShared).split('/');
    return (
      namespace !== undefined &&
      name !== undefined &&
      matchesAllocatedPart(actualNamespace, namespace) &&
      matchesAllocatedPart(actualName, name)
    );
  });
};
