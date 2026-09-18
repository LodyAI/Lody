import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type AssistantEditedFileEntry = {
  readonly filePath: string;
  readonly add?: number;
  readonly del?: number;
};

export interface AssistantEditedFilesProps {
  files: readonly AssistantEditedFileEntry[];
  onFileClick?: (filePath: string) => void;
  className?: string;
}

const DEFAULT_VISIBLE_FILE_COUNT = 4;

const getMergedFiles = (files: readonly AssistantEditedFileEntry[]): AssistantEditedFileEntry[] => {
  const filesByPath = new Map<string, AssistantEditedFileEntry>();

  for (const file of files) {
    if (!file.filePath) continue;
    const existing = filesByPath.get(file.filePath);
    if (!existing) {
      filesByPath.set(file.filePath, file);
      continue;
    }
    filesByPath.set(file.filePath, {
      filePath: file.filePath,
      add:
        existing.add === undefined && file.add === undefined
          ? undefined
          : (existing.add ?? 0) + (file.add ?? 0),
      del:
        existing.del === undefined && file.del === undefined
          ? undefined
          : (existing.del ?? 0) + (file.del ?? 0),
    });
  }

  return [...filesByPath.values()];
};

const splitFilePath = (filePath: string): { directory: string; name: string } => {
  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex === -1) return { directory: '', name: normalized };
  return {
    directory: normalized.slice(0, separatorIndex),
    name: normalized.slice(separatorIndex + 1),
  };
};

const DiffStats = ({ add, del }: { add?: number; del?: number }) => (
  <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
    <span className={add === undefined ? 'text-muted-foreground/60' : 'text-code-added'}>
      +{add ?? '—'}
    </span>
    <span className={del === undefined ? 'text-muted-foreground/60' : 'text-code-removed'}>
      -{del ?? '—'}
    </span>
  </span>
);

export function AssistantEditedFiles({ files, onFileClick, className }: AssistantEditedFilesProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const uniqueFiles = useMemo(() => getMergedFiles(files), [files]);

  if (uniqueFiles.length === 0) return null;

  const hiddenFileCount = Math.max(0, uniqueFiles.length - DEFAULT_VISIBLE_FILE_COUNT);
  const visibleFiles = expanded ? uniqueFiles : uniqueFiles.slice(0, DEFAULT_VISIBLE_FILE_COUNT);
  const hasCompleteStats = uniqueFiles.every(
    (file) => file.add !== undefined && file.del !== undefined
  );
  const totals = hasCompleteStats
    ? uniqueFiles.reduce(
        (result, file) => ({
          add: result.add + (file.add ?? 0),
          del: result.del + (file.del ?? 0),
        }),
        { add: 0, del: 0 }
      )
    : null;

  const isSingleFile = uniqueFiles.length === 1;

  return (
    <div className={cn('w-full text-left', className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-background">
        {/* Multi-file only: summary bar. Single-file cards skip it so we
            don't stack "Edited 1 file" on top of the lone file row. */}
        {!isSingleFile ? (
          <div className="flex min-h-8 items-center gap-3 bg-muted/30 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 text-xs font-medium text-foreground/80">
              {t('sessions.editedFiles.summary', {
                count: uniqueFiles.length,
                defaultValue: 'Edited {{count}} files',
              })}
            </span>
            {totals ? <DiffStats add={totals.add} del={totals.del} /> : null}
          </div>
        ) : null}
        <div
          className={cn(
            'divide-y divide-border/70',
            !isSingleFile && 'border-t border-border/70'
          )}
        >
          {visibleFiles.map((file) => {
            const { directory, name } = splitFilePath(file.filePath);
            const content = (
              <>
                <span className="min-w-0 flex-1 truncate text-[length:var(--markdown-body-font-size,1em)] leading-[1.75]">
                  <span className="text-foreground/90">{name}</span>
                  {directory ? (
                    <span className="ml-1.5 text-muted-foreground/70">{directory}</span>
                  ) : null}
                </span>
                <DiffStats add={file.add} del={file.del} />
              </>
            );
            const rowClassName = cn(
              'flex w-full min-w-0 items-center gap-2 px-2.5 text-left',
              isSingleFile ? 'min-h-10 py-2' : 'min-h-9 py-1.5',
              onFileClick &&
                'cursor-pointer transition-colors hover:bg-hover/45 focus-visible:bg-hover/45 focus-visible:outline-none'
            );

            return onFileClick ? (
              <button
                key={file.filePath}
                type="button"
                className={rowClassName}
                title={file.filePath}
                onClick={() => onFileClick(file.filePath)}
              >
                {content}
              </button>
            ) : (
              <div key={file.filePath} className={rowClassName} title={file.filePath}>
                {content}
              </div>
            );
          })}
        </div>

        {hiddenFileCount > 0 ? (
          <button
            type="button"
            className="flex h-8 w-full items-center justify-center gap-1 border-t border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-hover/45 hover:text-foreground focus-visible:bg-hover/45 focus-visible:text-foreground focus-visible:outline-none"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown className={cn('size-3 transition-transform', expanded && 'rotate-180')} />
            {expanded
              ? t('sessions.editedFiles.showLess', 'Show less')
              : t('sessions.editedFiles.showMore', {
                  count: hiddenFileCount,
                  defaultValue: 'Show {{count}} more',
                })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
