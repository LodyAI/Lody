import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';

import { evidenceSurface } from './surface';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const CHANGED_CLASS = stylex.props(evidenceSurface.subtitle).className;
const FIGURE_CLASS = stylex.props(evidenceSurface.figure).className;
const FIGURE_UNKNOWN_CLASS = stylex.props(evidenceSurface.figureUnknown).className;
const NAME_CLASS = stylex.props(evidenceSurface.name).className;
const DETAIL_CLASS = stylex.props(evidenceSurface.detail).className;
const CAPTION_CLASS = stylex.props(evidenceSurface.caption).className;
const ACTION_CLASS = stylex.props(evidenceSurface.action).className;

const styles = stylex.create({
  root: {
    width: '100%',
    textAlign: 'left',
  },
  changed: {
    marginLeft: 'auto',
    flexShrink: 0,
  },
  figures: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    fontFamily:
      'JetBrains Mono, SF Mono, Monaco, Inconsolata, Fira Code, Droid Sans Mono, Source Code Pro, monospace',
    fontVariantNumeric: 'tabular-nums',
  },
  addition: { color: themeColors.githubAddition },
  deletion: { color: themeColors.githubDeletion },
  card: {
    overflow: 'hidden',
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: themeColors.border,
    backgroundColor: themeColors.background,
  },
  summary: {
    display: 'flex',
    minHeight: themeSpace[8],
    alignItems: 'center',
    gap: themeSpace[3],
    backgroundColor: 'hsl(var(--muted) / 0.3)',
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[1.5],
  },
  summaryText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  rows: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.7)',
  },
  name: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  directory: { marginLeft: themeSpace[1.5] },
  row: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[2.5],
    textAlign: 'left',
  },
  rowTall: {
    minHeight: themeSpace[10],
    paddingBlock: themeSpace[2],
  },
  rowShort: {
    minHeight: themeSpace[9],
    paddingBlock: themeSpace[1.5],
  },
  rowInteractive: {
    cursor: 'pointer',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    backgroundColor: {
      '@media (hover: hover)': { ':hover': 'hsl(var(--hover) / 0.45)' },
      ':focus-visible': 'hsl(var(--hover) / 0.45)',
    },
  },
  expand: {
    display: 'flex',
    height: themeSpace[8],
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[1],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.7)',
    paddingInline: themeSpace[2.5],
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    backgroundColor: {
      '@media (hover: hover)': { ':hover': 'hsl(var(--hover) / 0.45)' },
      ':focus-visible': 'hsl(var(--hover) / 0.45)',
    },
  },
  chevron: {
    width: themeSpace[3],
    height: themeSpace[3],
    transitionProperty: 'transform',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  chevronOpen: { transform: 'rotate(180deg)' },
});

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

const DiffStats = ({ add, del }: { add?: number; del?: number }) => {
  const { t } = useTranslation();

  if (add === 0 && del === 0) {
    return (
      <span className={clsx(stylex.props(styles.changed).className, CHANGED_CLASS)}>
        {t('sessions.editedFiles.changed', 'Changed')}
      </span>
    );
  }

  return (
    <span className={clsx(stylex.props(styles.figures).className, FIGURE_CLASS)}>
      <span
        className={
          add === undefined
            ? FIGURE_UNKNOWN_CLASS
            : stylex.props(styles.addition).className
        }
      >
        +{add ?? '—'}
      </span>
      <span
        className={
          del === undefined
            ? FIGURE_UNKNOWN_CLASS
            : stylex.props(styles.deletion).className
        }
      >
        -{del ?? '—'}
      </span>
    </span>
  );
};

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
    <div className={clsx(stylex.props(styles.root).className, className)}>
      <div {...stylex.props(styles.card)}>
        {/* Multi-file only: summary bar. Single-file cards skip it so we
            don't stack "Edited 1 file" on top of the lone file row. */}
        {!isSingleFile ? (
          <div {...stylex.props(styles.summary)}>
            <span className={clsx(stylex.props(styles.summaryText).className, CAPTION_CLASS)}>
              {t('sessions.editedFiles.summary', {
                count: uniqueFiles.length,
                defaultValue: 'Edited {{count}} files',
              })}
            </span>
            {totals ? <DiffStats add={totals.add} del={totals.del} /> : null}
          </div>
        ) : null}
        <div
          className={clsx(
            // The rule between the rows is a descendant rule, which StyleX
            // cannot express, so it stays a Tailwind class on this element.
            'divide-y divide-border/70',
            !isSingleFile && stylex.props(styles.rows).className
          )}
        >
          {visibleFiles.map((file) => {
            const { directory, name } = splitFilePath(file.filePath);
            const content = (
              <>
                <span className={clsx(stylex.props(styles.name).className, NAME_CLASS)}>
                  <span>{name}</span>
                  {directory ? (
                    <span className={clsx(stylex.props(styles.directory).className, DETAIL_CLASS)}>
                      {directory}
                    </span>
                  ) : null}
                </span>
                <DiffStats add={file.add} del={file.del} />
              </>
            );
            const rowClassName = stylex.props(
              styles.row,
              isSingleFile ? styles.rowTall : styles.rowShort,
              onFileClick && styles.rowInteractive
            ).className;

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
            className={clsx(
              // The ink of the button belongs to the evidence surface, so its
              // hover and focus colours stay Tailwind classes on this element.
              'hover:text-foreground',
              'focus-visible:text-foreground',
              stylex.props(styles.expand).className,
              ACTION_CLASS
            )}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown
              {...stylex.props(styles.chevron, expanded && styles.chevronOpen)}
            />
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
