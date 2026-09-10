/**
 * Branch name generator - converts session titles or task descriptions to valid git branch names.
 */

/**
 * Convert a title or task description to a valid git branch name.
 *
 * Rules:
 * - Converts to lowercase kebab-case
 * - Removes special characters
 * - Limits length to 50 characters (git best practice)
 * - Adds appropriate prefix (fix/, feat/, chore/, etc.)
 */
export const titleToBranchName = (title: string): string => {
  if (!title || typeof title !== 'string') {
    return '';
  }

  const normalized = title.trim().toLowerCase();

  // Detect prefix based on common patterns
  const prefix = detectBranchPrefix(normalized);

  // Remove the detected prefix pattern from the title for cleaner branch name
  const withoutPrefixPattern = removeKnownPrefixPatterns(normalized);

  // Convert to kebab-case
  const kebab = withoutPrefixPattern
    // Replace spaces and underscores with hyphens
    .replace(/[\s_]+/g, '-')
    // Remove all characters that are not alphanumeric or hyphens
    .replace(/[^a-z0-9-]/g, '')
    // Replace multiple consecutive hyphens with single hyphen
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '');

  if (!kebab) {
    return '';
  }

  // Limit length (50 chars for branch name is a good practice)
  // Account for prefix length
  const maxKebabLength = 50 - prefix.length;
  const truncated = kebab.slice(0, maxKebabLength).replace(/-+$/, '');

  return `${prefix}${truncated}`;
};

/**
 * Detect the appropriate branch prefix based on the task/title content.
 */
const detectBranchPrefix = (text: string): string => {
  const lowerText = text.toLowerCase();

  // Fix-related patterns
  if (/\b(fix|bug|issue|error|crash|broken|repair|resolve)\b/.test(lowerText)) {
    return 'fix/';
  }

  // Feature-related patterns
  if (/\b(add|implement|create|new|feature|introduce|support)\b/.test(lowerText)) {
    return 'feat/';
  }

  // Refactor-related patterns
  if (/\b(refactor|restructure|reorganize|improve|optimize|clean)\b/.test(lowerText)) {
    return 'refactor/';
  }

  // Documentation-related patterns
  if (/\b(doc|document|readme|comment)\b/.test(lowerText)) {
    return 'docs/';
  }

  // Test-related patterns
  if (/\b(test|spec|coverage)\b/.test(lowerText)) {
    return 'test/';
  }

  // Chore-related patterns
  if (/\b(chore|update|upgrade|bump|dependency|deps)\b/.test(lowerText)) {
    return 'chore/';
  }

  // Default to feat/ for general tasks
  return 'feat/';
};

/**
 * Remove known prefix patterns that would be redundant with the branch prefix.
 */
const removeKnownPrefixPatterns = (text: string): string => {
  return text
    .replace(
      /^(fix|bug|feature|feat|add|implement|create|refactor|docs?|test|chore|update)[:\s-]+/i,
      ''
    )
    .trim();
};

/**
 * Validate if a string is a valid git branch name.
 */
export const isValidGitBranchName = (name: string): boolean => {
  if (!name || typeof name !== 'string') {
    return false;
  }

  // Git branch name rules:
  // - Cannot start with a dot
  // - Cannot contain consecutive dots
  // - Cannot end with .lock
  // - Cannot contain control characters, space, ~, ^, :, ?, *, [, \
  // - Cannot contain @{

  if (name.startsWith('.') || name.startsWith('-')) {
    return false;
  }

  if (name.endsWith('.lock') || name.endsWith('.') || name.endsWith('/')) {
    return false;
  }

  if (/\.\./.test(name)) {
    return false;
  }

  if (/@\{/.test(name)) {
    return false;
  }

  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name)) {
    return false;
  }

  return true;
};

/**
 * Convert a title or prompt into a valid branch name, or null when it yields none.
 *
 * Kebab conversion drops every non-ASCII character, so a prompt written entirely
 * in another script has no name to give. Callers are expected to leave the
 * existing branch alone in that case rather than invent a meaningless one.
 */
export const tryBranchName = (base: string): string | null => {
  const candidate = titleToBranchName(base);
  return candidate && isValidGitBranchName(candidate) ? candidate : null;
};
