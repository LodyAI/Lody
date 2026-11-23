import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';

const OPTIONAL_LANGUAGE_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  bat: () => import('monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js'),
  clojure: () => import('monaco-editor/esm/vs/basic-languages/clojure/clojure.contribution.js'),
  dart: () => import('monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js'),
  elixir: () => import('monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution.js'),
  fsharp: () => import('monaco-editor/esm/vs/basic-languages/fsharp/fsharp.contribution.js'),
  hcl: () => import('monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution.js'),
  julia: () => import('monaco-editor/esm/vs/basic-languages/julia/julia.contribution.js'),
  less: () => import('monaco-editor/esm/vs/basic-languages/less/less.contribution.js'),
  lua: () => import('monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js'),
  mdx: () => import('monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js'),
  'objective-c': () =>
    import('monaco-editor/esm/vs/basic-languages/objective-c/objective-c.contribution.js'),
  perl: () => import('monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js'),
  powershell: () =>
    import('monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js'),
  protobuf: () => import('monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js'),
  r: () => import('monaco-editor/esm/vs/basic-languages/r/r.contribution.js'),
  scala: () => import('monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js'),
  scss: () => import('monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js'),
  solidity: () => import('monaco-editor/esm/vs/basic-languages/solidity/solidity.contribution.js'),
  wgsl: () => import('monaco-editor/esm/vs/basic-languages/wgsl/wgsl.contribution.js'),
};

const languageLoads = new Map<string, Promise<void>>();

export function ensureSessionMonacoLanguages(
  language: string,
  extendedLanguagesEnabled: boolean
): Promise<void> {
  if (!extendedLanguagesEnabled) return Promise.resolve();
  const load = OPTIONAL_LANGUAGE_LOADERS[language];
  if (!load) return Promise.resolve();

  let languageLoad = languageLoads.get(language);
  if (!languageLoad) {
    languageLoad = load().then(
      () => undefined,
      (error: unknown) => {
        languageLoads.delete(language);
        throw error;
      }
    );
    languageLoads.set(language, languageLoad);
  }
  return languageLoad;
}
