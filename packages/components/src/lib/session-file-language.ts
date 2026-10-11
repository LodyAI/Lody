const BASENAME_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ['.bashrc', 'shell'],
  ['.env', 'ini'],
  ['.env.example', 'ini'],
  ['.eslintrc', 'json'],
  ['.gitignore', 'plaintext'],
  ['.npmrc', 'ini'],
  ['.prettierrc', 'json'],
  ['Dockerfile', 'dockerfile'],
  ['Makefile', 'plaintext'],
  ['Rakefile', 'ruby'],
]);

const EXTENSION_LANGUAGE_IDS: ReadonlyMap<string, string> = new Map([
  ['astro', 'html'],
  ['bash', 'shell'],
  ['bat', 'bat'],
  ['c', 'c'],
  ['cc', 'cpp'],
  ['cjs', 'javascript'],
  ['clj', 'clojure'],
  ['cljs', 'clojure'],
  ['cmd', 'bat'],
  ['coq', 'coq'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['css', 'css'],
  ['cts', 'typescript'],
  ['dart', 'dart'],
  ['dockerfile', 'dockerfile'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['fish', 'shell'],
  ['fs', 'fsharp'],
  ['fsi', 'fsharp'],
  ['fsx', 'fsharp'],
  ['go', 'go'],
  ['graphql', 'graphql'],
  ['h', 'c'],
  ['hcl', 'hcl'],
  ['hpp', 'cpp'],
  ['html', 'html'],
  ['ini', 'ini'],
  ['java', 'java'],
  ['jl', 'julia'],
  ['js', 'javascript'],
  ['json', 'json'],
  ['json5', 'json'],
  ['jsonc', 'json'],
  ['jsx', 'javascript'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['lean', 'lean'],
  ['less', 'less'],
  ['lua', 'lua'],
  ['m', 'objective-c'],
  ['markdown', 'markdown'],
  ['md', 'markdown'],
  ['mdx', 'mdx'],
  ['mm', 'objective-c'],
  ['mjs', 'javascript'],
  ['mts', 'typescript'],
  ['mysql', 'sql'],
  ['pgsql', 'sql'],
  ['php', 'php'],
  ['pl', 'perl'],
  ['ps1', 'powershell'],
  ['prisma', 'graphql'],
  ['proto', 'protobuf'],
  ['py', 'python'],
  ['r', 'r'],
  ['rb', 'ruby'],
  ['rocq', 'coq'],
  ['rs', 'rust'],
  ['scala', 'scala'],
  ['scss', 'scss'],
  ['sh', 'shell'],
  ['sql', 'sql'],
  ['sol', 'solidity'],
  ['svelte', 'html'],
  ['swift', 'swift'],
  ['tf', 'hcl'],
  ['tfvars', 'hcl'],
  ['toml', 'ini'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['v', 'coq'],
  ['vue', 'html'],
  ['wgsl', 'wgsl'],
  ['xml', 'xml'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['zsh', 'shell'],
]);

// These mappings are available only after the optional language pack is
// enabled. Keeping the gate here means file previews and Markdown fences share
// the same opt-in boundary instead of silently loading extra grammars.
const EXTENDED_SESSION_FILE_EXTENSIONS = new Set([
  'astro',
  'bat',
  'clj',
  'cljs',
  'cmd',
  'coq',
  'dart',
  'ex',
  'exs',
  'fish',
  'fs',
  'fsi',
  'fsx',
  'hcl',
  'jl',
  'less',
  'lean',
  'lua',
  'm',
  'mdx',
  'mm',
  'mysql',
  'pgsql',
  'pl',
  'proto',
  'ps1',
  'r',
  'scala',
  'scss',
  'sol',
  'svelte',
  'tf',
  'tfvars',
  'vue',
  'v',
  'wgsl',
  'rocq',
]);

// Monaco has no basic-language contribution for these grammars. Read-only
// previews use the Shiki-backed file viewer instead; editable provider files
// intentionally remain plaintext in Monaco.
export type SessionFileShikiLanguage = 'coq' | 'lean';

const SHIKI_ONLY_SESSION_FILE_LANGUAGES = new Set<string>(['coq', 'lean']);

export const getSessionFileBasename = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
};

export const getSessionFileExtension = (filePath: string): string | null => {
  const basename = getSessionFileBasename(filePath);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return null;
  }
  return basename.slice(dotIndex + 1).toLowerCase();
};

// Markdown is plain text, so it is shown in the code viewer by default but can
// be toggled to a rendered preview (mirrors the SVG code/rendered toggle).
// `mdx` is intentionally excluded: its JSX would render as literal/garbled
// markup in the prose renderer, which is worse than just showing the source.
export const isSessionMarkdownPath = (filePath: string): boolean => {
  const extension = getSessionFileExtension(filePath);
  return extension === 'md' || extension === 'markdown';
};

export const getSessionFileLanguageId = (
  filePath: string,
  extendedLanguagesEnabled = false
): string => {
  const basename = getSessionFileBasename(filePath);
  if (basename.startsWith('.env.')) {
    return 'ini';
  }
  const basenameMatch = BASENAME_LANGUAGE_IDS.get(basename);
  if (basenameMatch) {
    return basenameMatch;
  }

  const extension = getSessionFileExtension(filePath);
  if (!extension) {
    return 'plaintext';
  }
  if (!extendedLanguagesEnabled && EXTENDED_SESSION_FILE_EXTENSIONS.has(extension)) {
    return 'plaintext';
  }
  return EXTENSION_LANGUAGE_IDS.get(extension) ?? 'plaintext';
};

export const isSessionFileShikiLanguage = (
  languageId: string
): languageId is SessionFileShikiLanguage => SHIKI_ONLY_SESSION_FILE_LANGUAGES.has(languageId);

export const getSessionFileMonacoLanguageId = (
  filePath: string,
  extendedLanguagesEnabled = false
): string => {
  const language = getSessionFileLanguageId(filePath, extendedLanguagesEnabled);
  return isSessionFileShikiLanguage(language) ? 'plaintext' : language;
};
