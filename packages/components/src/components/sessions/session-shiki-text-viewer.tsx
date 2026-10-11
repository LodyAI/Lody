import { File as ShikiFile, type FileProps } from '@pierre/diffs/react';
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { fileViewerWordWrapAtom } from '@/atoms/settings';
import { cn } from '@/lib/utils';
import { DEFAULT_VSCODE_DIFF_THEME_FALLBACK } from '@/lib/vscode-theme';
import { useActiveVSCodeDiffThemeName, useResolvedTheme } from '../../theme-provider';

/**
 * Read-only file rendering for languages that Shiki supports but Monaco does
 * not. The language is always explicit so @pierre/diffs cannot infer `.v` as
 * Verilog from the filename.
 */
export function SessionShikiTextViewer({
  path,
  text,
  language,
  className,
}: {
  readonly path: string;
  readonly text: string;
  readonly language: 'coq' | 'lean';
  readonly className?: string;
}) {
  const wordWrap = useAtomValue(fileViewerWordWrapAtom);
  const resolvedTheme = useResolvedTheme();
  const activeDiffThemeName = useActiveVSCodeDiffThemeName();
  const file = useMemo<FileProps<undefined>['file']>(
    () => ({ name: path, lang: language, contents: text }),
    [language, path, text]
  );
  const options = useMemo<FileProps<undefined>['options']>(
    () => ({
      disableFileHeader: true,
      overflow: wordWrap ? 'wrap' : 'scroll',
      theme: activeDiffThemeName ?? DEFAULT_VSCODE_DIFF_THEME_FALLBACK,
      themeType: resolvedTheme,
      tokenizeMaxLineLength: 20_000,
    }),
    [activeDiffThemeName, resolvedTheme, wordWrap]
  );

  return (
    <div className={cn('h-full min-h-[240px] w-full overflow-auto', className)}>
      <ShikiFile file={file} options={options} className="block min-h-full w-full" />
    </div>
  );
}
