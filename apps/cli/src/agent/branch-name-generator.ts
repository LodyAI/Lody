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
 * Signals that a prompt is carrying a credential.
 *
 * A branch name is a ref: it is written to `.git`, shown in the UI, and pushed to
 * the remote as soon as the session opens a PR. Naming a branch after a prompt
 * therefore publishes whatever the prompt held, and "rotate the key before Friday"
 * is an ordinary thing to ask an agent.
 *
 * This list cannot be complete, and is not meant to be: a secret has no reliable
 * shape, since `hunter2` is both a password and an ordinary word. It recognizes
 * the *syntax* that carries secrets rather than the secrets themselves, and the
 * boundary fails closed on a hit — the session keeps its `session/<id>` branch
 * instead of getting a name derived from that prompt. A false positive costs one
 * branch name, so the list leans deliberately wide.
 */
const CREDENTIAL_SIGNAL = new RegExp(
  [
    // A value assigned to a sensitive name: DB_PASSWORD=…, "api key: …".
    '(?:api[_-]?key|auth|bearer|credential|passwd|password|secret|token)\\w*\\s*[:=]\\s*\\S',
    // URL userinfo: https://alice:hunter2@example.com
    '[a-zA-Z][a-zA-Z0-9+.-]*://[^/\\s@]*:[^/\\s@]*@',
    // Whole PEM block first, so a short body cannot escape between the markers.
    '-----BEGIN[\\s\\S]*?-----END[\\s\\S]*?-----',
    '-----BEGIN[\\s\\S]*?-----',
    // Known credential prefixes.
    '\\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|glpat|shpat|xox[abprs])[-_][A-Za-z0-9_-]{6,}',
    '\\bgithub_pat_[A-Za-z0-9_]{10,}',
    '\\b(?:AKIA|ASIA|AIza)[A-Za-z0-9]{6,}',
    // Unprefixed high-entropy run: 20+ alphanumerics mixing letters and digits.
    // English prose has no such runs; hex and base62 credentials do.
    '\\b(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,}\\b',
  ].join('|'),
  // Case-insensitive: DB_PASSWORD and AWS_SECRET_ACCESS_KEY are how these appear.
  'i'
);

export const tryBranchName = (base: string): string | null => {
  if (CREDENTIAL_SIGNAL.test(base)) {
    return null;
  }
  const candidate = titleToBranchName(base);
  return candidate && isValidGitBranchName(candidate) ? candidate : null;
};
