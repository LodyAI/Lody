import { normalizeWorktreePath } from './worktree-path';

const normalizePathSeparators = (value: string): string => value.replace(/\\/g, '/');
const HIERARCHICAL_URI_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const SPECIAL_URI_SCHEME_PATTERN = /^(?:mailto|tel|data|blob|file):/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(?:\.{1,2}[\\/])/;
const FILE_LIKE_PATH_PATTERN = /(?:^|[\\/])(?:\.[^/\\]+|[^/\\]+\.[^/\\]+)$/;
const GITHUB_LINE_SUFFIX_PATTERN = /#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?$/i;
const VSCODE_LINE_SUFFIX_PATTERN = /:L(\d+)(?:C(\d+))?$/i;
const COLON_LINE_SUFFIX_PATTERN = /:(\d+)(?::(\d+))?$/;

const trimTrailingPathSlash = (value: string): string => {
  if (value === '/') {
    return value;
  }

  return value.replace(/\/+$/g, '') || value;
};

const decodeMarkdownFilePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export type MarkdownAgentFileLinkTarget = {
  filePath: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  lineSuffixFormat?: 'github' | 'colon' | 'vscode';
};

const isUriWithScheme = (value: string): boolean =>
  (HIERARCHICAL_URI_PATTERN.test(value) || SPECIAL_URI_SCHEME_PATTERN.test(value)) &&
  !WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);

const isFileLikeMarkdownHref = (value: string, isWindowsUncPath: boolean): boolean => {
  if (
    !value ||
    value.startsWith('#') ||
    (value.startsWith('//') && !isWindowsUncPath) ||
    isUriWithScheme(value)
  ) {
    return false;
  }

  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) ||
    RELATIVE_PATH_PREFIX_PATTERN.test(value)
  ) {
    return true;
  }

  return value.includes('/') || value.includes('\\') || FILE_LIKE_PATH_PATTERN.test(value);
};

const parseLineNumber = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export function parseMarkdownAgentFileHref(
  href: string | undefined
): MarkdownAgentFileLinkTarget | null {
  if (!href) {
    return null;
  }

  const trimmedHref = href.trim();
  const isWindowsUncPath = WINDOWS_UNC_PATH_PATTERN.test(trimmedHref);
  const normalizedHref = normalizePathSeparators(trimmedHref);
  if (!normalizedHref) {
    return null;
  }

  const githubLineSuffix = normalizedHref.match(GITHUB_LINE_SUFFIX_PATTERN);
  const vscodeLineSuffix =
    githubLineSuffix == null ? normalizedHref.match(VSCODE_LINE_SUFFIX_PATTERN) : null;
  const colonLineSuffix =
    githubLineSuffix == null && vscodeLineSuffix == null
      ? normalizedHref.match(COLON_LINE_SUFFIX_PATTERN)
      : null;
  const basePath = githubLineSuffix
    ? normalizedHref.slice(0, -githubLineSuffix[0].length)
    : vscodeLineSuffix
      ? normalizedHref.slice(0, -vscodeLineSuffix[0].length)
      : colonLineSuffix
        ? normalizedHref.slice(0, -colonLineSuffix[0].length)
        : normalizedHref;

  if (
    githubLineSuffix == null &&
    vscodeLineSuffix == null &&
    colonLineSuffix == null &&
    (basePath.includes('#') || basePath.includes('?'))
  ) {
    return null;
  }

  if (!isFileLikeMarkdownHref(basePath, isWindowsUncPath)) {
    return null;
  }

  const startLine = parseLineNumber(
    githubLineSuffix?.[1] ?? vscodeLineSuffix?.[1] ?? colonLineSuffix?.[1]
  );
  const startColumn = parseLineNumber(githubLineSuffix?.[2] ?? vscodeLineSuffix?.[2]);
  const endLine = parseLineNumber(githubLineSuffix?.[3] ?? colonLineSuffix?.[2]);
  const endColumn = parseLineNumber(githubLineSuffix?.[4]);

  if (
    (githubLineSuffix != null || vscodeLineSuffix != null || colonLineSuffix != null) &&
    startLine == null
  ) {
    return null;
  }

  return {
    filePath: basePath,
    startLine,
    ...(startColumn === undefined ? {} : { startColumn }),
    endLine,
    ...(endColumn === undefined ? {} : { endColumn }),
    lineSuffixFormat: githubLineSuffix
      ? 'github'
      : vscodeLineSuffix
        ? 'vscode'
        : colonLineSuffix
          ? 'colon'
          : undefined,
  };
}

const formatMarkdownAgentFileHref = (target: MarkdownAgentFileLinkTarget): string => {
  if (target.startLine == null) {
    return target.filePath;
  }

  if (target.lineSuffixFormat === 'github') {
    const startColumnSuffix = target.startColumn != null ? `C${target.startColumn}` : '';
    const rangeSuffix =
      target.endLine != null && target.endLine !== target.startLine
        ? `-L${target.endLine}${target.endColumn != null ? `C${target.endColumn}` : ''}`
        : '';
    return `${target.filePath}#L${target.startLine}${startColumnSuffix}${rangeSuffix}`;
  }

  if (target.lineSuffixFormat === 'vscode') {
    const startColumnSuffix = target.startColumn != null ? `C${target.startColumn}` : '';
    return `${target.filePath}:L${target.startLine}${startColumnSuffix}`;
  }

  const endLineSuffix =
    target.endLine != null && target.endLine !== target.startLine ? `:${target.endLine}` : '';
  return `${target.filePath}:${target.startLine}${endLineSuffix}`;
};

export function isMarkdownAgentFileHref(href: string | undefined): href is string {
  return parseMarkdownAgentFileHref(href) != null;
}

export function normalizeMarkdownAgentFilePath(
  href: string,
  localProjectRootPath?: string | null,
  preserveWorktreePath = false
): string {
  const parsedTarget = parseMarkdownAgentFileHref(href);
  const normalizedHref = decodeMarkdownFilePath(
    normalizePathSeparators(parsedTarget?.filePath ?? href)
  );
  const localRoot = localProjectRootPath?.trim();

  let normalizedFilePath = normalizedHref;

  if (localRoot) {
    const normalizedRoot = trimTrailingPathSlash(normalizePathSeparators(localRoot));
    const useCaseInsensitiveComparison =
      WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedHref) ||
      WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedRoot) ||
      normalizedHref.startsWith('//') ||
      normalizedRoot.startsWith('//');
    const comparableHref = useCaseInsensitiveComparison
      ? normalizedHref.toLowerCase()
      : normalizedHref;
    const comparableRoot = useCaseInsensitiveComparison
      ? normalizedRoot.toLowerCase()
      : normalizedRoot;
    if (comparableHref === comparableRoot) {
      normalizedFilePath = '.';
    } else {
      const rootPrefix = comparableRoot === '/' ? '/' : `${comparableRoot}/`;
      if (comparableHref.startsWith(rootPrefix)) {
        normalizedFilePath = normalizedHref.slice(rootPrefix.length) || '.';
      }
    }
  }

  if (normalizedFilePath === normalizedHref && !preserveWorktreePath) {
    normalizedFilePath = normalizeWorktreePath(normalizedHref);
  }

  if (!parsedTarget) {
    return normalizedFilePath;
  }

  return formatMarkdownAgentFileHref({
    ...parsedTarget,
    filePath: normalizedFilePath,
  });
}
