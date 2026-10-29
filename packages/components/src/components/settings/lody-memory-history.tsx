import { lazy, Suspense, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { MEMORY_LIMITS, type MemoryDocument, type MemoryProvenance } from '@lody/memory';
import type { SessionId } from '@lody/shared';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { settingsDialogOpenAtom } from '@/atoms/settings';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

// The diff renderer is heavy; only the history view needs it.
const DiffViewer = lazy(() =>
  import('@/ui/diff-viewer/diff-viewer').then((module) => ({ default: module.DiffViewer }))
);

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '48px',
    paddingInline: space[3],
    // The close and history controls sit in the panel's corner.
    paddingInlineEnd: '96px',
    borderBottom: `1px solid ${colors.separator}`,
  },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 600,
    fontSize: text.bodySize,
  },
  layout: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    '@media (max-width: 600px)': { flexDirection: 'column' },
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '300px',
    overflowY: 'auto',
    padding: space[2],
    boxSizing: 'border-box',
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderInlineEnd: `1px solid ${colors.separator}`,
    '@media (max-width: 600px)': {
      width: '100%',
      maxHeight: '40%',
      borderInlineEnd: 'none',
      borderBottom: `1px solid ${colors.separator}`,
    },
  },
  entry: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space[1],
    height: 'auto',
    paddingBlock: space[2],
    textAlign: 'start',
  },
  entryLine: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
  },
  who: { fontWeight: 600 },
  session: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
  },
  sessionTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  diff: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' },
  note: { padding: space[6], fontSize: text.footnoteSize, color: colors.secondaryLabel },
});

/** Consecutive edits by the same author and turn within this window read as one change. */
const GROUP_WINDOW_MS = 2 * 60 * 1000;
type HistoryEntry = {
  key: string;
  /** Oldest first: the diff runs from the first change's "before" to the last change's "after". */
  changes: MemoryProvenance[];
};
const sameSource = (a: MemoryProvenance, b: MemoryProvenance) =>
  a.source.actor === b.source.actor &&
  a.source.turn?.sessionId === b.source.turn?.sessionId &&
  a.source.turn?.turnId === b.source.turn?.turnId;

function readHistory(memory: MemoryDocument, path: string): HistoryEntry[] {
  const records: MemoryProvenance[] = [];
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const page = memory.provenance(path, { offset, limit: MEMORY_LIMITS.pageSize });
    if (!page.ok) break;
    records.push(...page.value.items);
    offset = page.value.nextOffset;
  }
  records.sort((a, b) => a.recordedAt - b.recordedAt || (a.changeId < b.changeId ? -1 : 1));
  const groups: HistoryEntry[] = [];
  for (const record of records) {
    const last = groups.at(-1);
    const previous = last?.changes.at(-1);
    if (
      last &&
      previous &&
      record.kind === 'edit' &&
      previous.kind === 'edit' &&
      sameSource(previous, record) &&
      record.recordedAt - previous.recordedAt <= GROUP_WINDOW_MS
    )
      last.changes.push(record);
    else groups.push({ key: record.changeId, changes: [record] });
  }
  return groups.reverse();
}

export function LodyMemoryHistory({
  memory,
  path,
  revision,
  onBack,
}: {
  memory: MemoryDocument;
  path: string;
  /** Changes in the Doc's history; recomputed when the memory changes. */
  revision: number;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const sessions = useAtomValue(sessionMetaCacheAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const setSettingsOpen = useSetAtom(settingsDialogOpenAtom);
  const navigate = useNavigate();
  // `revision` invalidates the history when the memory changes underneath the view.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => readHistory(memory, path), [memory, path, revision]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0];
  const diff = useMemo(() => {
    if (!selected) return undefined;
    const first = memory.revision(path, selected.changes[0]!.changeId);
    const last = memory.revision(path, selected.changes.at(-1)!.changeId);
    if (!first.ok || !last.ok) return null;
    // Memory bodies rarely end in a newline; without one every edit to the last line
    // would also read as an end-of-file change.
    const line = (body = '') => (body && !body.endsWith('\n') ? `${body}\n` : body);
    return { before: line(first.value.before), after: line(last.value.after) };
  }, [memory, path, selected]);
  const time = new Intl.DateTimeFormat(i18n.language === 'zh_CN' ? 'zh-CN' : i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const openSession = (sessionId: string) => {
    if (!workspaceSlug) return;
    setSettingsOpen(false);
    void navigate({
      to: '/$workspaceName/sessions/$sessionId',
      params: { workspaceName: workspaceSlug, sessionId: sessionId as SessionId },
    });
  };
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.bar)}>
        <Button type="button" size="small" variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          {t('settings.memory.history.back')}
        </Button>
        <span {...stylex.props(styles.title)}>{t('settings.memory.history.title', { path })}</span>
      </div>
      <div {...stylex.props(styles.layout)}>
        <div
          role="listbox"
          aria-label={t('settings.memory.history.list')}
          {...stylex.props(styles.list)}
        >
          {entries.length === 0 ? (
            <p {...stylex.props(catalog.meta)}>{t('settings.memory.history.empty')}</p>
          ) : null}
          {entries.map((entry) => {
            const latest = entry.changes.at(-1)!;
            const turn = latest.source.turn;
            const session = turn
              ? Object.values(sessions).find((meta) => meta.id === turn.sessionId)
              : undefined;
            const active = entry === selected;
            return (
              <div
                key={entry.key}
                role="option"
                tabIndex={0}
                aria-selected={active}
                onClick={() => setSelectedKey(entry.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedKey(entry.key);
                  }
                }}
                {...stylex.props(surface.listRow, active && surface.listRowSelected, styles.entry)}
              >
                <div {...stylex.props(styles.entryLine)}>
                  <span>
                    <span {...stylex.props(styles.who)}>
                      {t(`settings.memory.builtin.${latest.source.actor}`)}
                    </span>
                    {' · '}
                    {t(`settings.memory.builtin.${entry.changes[0]!.kind}`)}
                    {entry.changes.length > 1
                      ? ` · ${t('settings.memory.history.merged', { count: entry.changes.length })}`
                      : ''}
                  </span>
                </div>
                <time
                  dateTime={new Date(latest.recordedAt).toISOString()}
                  {...stylex.props(catalog.meta)}
                >
                  {time.format(latest.recordedAt)}
                </time>
                {turn ? (
                  <div {...stylex.props(styles.session)}>
                    <Button
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={!session || !workspaceSlug}
                      onClick={(event) => {
                        event.stopPropagation();
                        openSession(turn.sessionId);
                      }}
                    >
                      <MessageSquare size={12} />
                      {t('settings.memory.history.openSession')}
                    </Button>
                    <span {...stylex.props(styles.sessionTitle)}>
                      {session
                        ? session.title || t('settings.memory.history.untitledSession')
                        : t('settings.memory.history.sessionUnavailable')}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div {...stylex.props(styles.diff)}>
          {diff === null ? (
            <p {...stylex.props(styles.note)}>{t('settings.memory.history.noDiff')}</p>
          ) : diff ? (
            diff.before === diff.after ? (
              <p {...stylex.props(styles.note)}>{t('settings.memory.history.noTextChange')}</p>
            ) : (
              <Suspense fallback={<Spinner size="small" />}>
                <DiffViewer
                  path={path}
                  oldText={diff.before}
                  newText={diff.after}
                  diffStyle="unified"
                  showHeader={false}
                />
              </Suspense>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
