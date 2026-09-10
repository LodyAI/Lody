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
