import * as stylex from '@stylexjs/stylex';
import { MessageSquare } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TodayMentionTarget } from '@lody/shared';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import type { WorkspaceMember } from '@/hooks/use-workspace-members';
import {
  selectSessionMentionCandidates,
  useSessionMentionItems,
  type SessionMentionItem,
} from '@/components/mentions/mention-session-source';
import { UserAvatar } from '../user-avatar';
import { useTodayEditor } from './editor/today-editor-context';
import type { TodayPickerTab } from './editor/today-editor-controller';
import { selectTodayMembers, useTodayMembers } from './today-members';

const pickerStyles = stylex.create({
  menu: {
    position: 'fixed',
    zIndex: 50,
    width: 320,
    maxWidth: 'calc(100vw - 16px)',
    padding: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.raisedBackground,
    boxShadow: '0 8px 24px rgb(0 0 0 / 0.16)',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  tabs: {
    display: 'flex',
    gap: space[3],
    paddingInline: space[2],
    marginBottom: space[1],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  tab: {
    position: 'relative',
    paddingBlock: space[1],
    borderWidth: 0,
    background: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontSize: text.footnoteSize,
    cursor: 'pointer',
  },
  tabActive: {
    color: { default: colors.accent, ':hover': colors.accent },
    '::after': {
      content: '""',
      position: 'absolute',
      insetInline: 0,
      bottom: -1,
      height: 2,
      borderRadius: radius.full,
      backgroundColor: colors.accent,
    },
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    textAlign: 'start',
    borderWidth: 0,
    background: 'none',
    color: colors.label,
    padding: `${space[1]} ${space[2]}`,
    borderRadius: radius.small,
    fontSize: text.subheadlineSize,
    cursor: 'pointer',
  },
  itemLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemIcon: {
    width: 16,
    flexShrink: 0,
    display: 'inline-flex',
    justifyContent: 'center',
    color: colors.secondaryLabel,
  },
  highlighted: { backgroundColor: colors.hoverFill },
  empty: { padding: space[2], fontSize: text.footnoteSize, color: colors.tertiaryLabel },
});

/** Rows the picker shows per kind on its "All" tab; a kind's own tab shows more. */
const PICKER_PREVIEW = 4;
const PICKER_LIMIT = 8;

/**
 * The live picker: the workspace's conversation list is subscribed only while
 * `@` is open, so session-list ticks never re-render the whole Today surface.
 */
export function TodayLiveSessionPicker() {
  const controller = useTodayEditor();
  if (!controller?.getPicker()) return null;
  return <TodayWorkspaceSessionPicker />;
}

function TodayWorkspaceSessionPicker() {
  return <TodaySessionPicker items={useSessionMentionItems()} />;
}

type PickerRow =
  | { target: TodayMentionTarget; kind: 'member'; member: WorkspaceMember }
  | { target: TodayMentionTarget; kind: 'session'; item: SessionMentionItem };

/**
 * The `@` picker below the editing caret: workspace members and conversations,
 * on "All", "People" and "Conversations" tabs. People show only in a
 * workspace with other members. Conversation items come from the host.
 */
export function TodaySessionPicker(props: { items: readonly SessionMentionItem[] }) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const members = useTodayMembers();
  const { items } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [above, setAbove] = useState(false);
  const picker = controller?.getPicker() ?? null;
  const root = controller?.getEditorRoot() ?? null;
  const query = picker?.query ?? null;
  const withPeople = members.size > 1;
  const tab = withPeople ? (picker?.tab ?? 'all') : 'session';
  const rows = useMemo((): PickerRow[] => {
    if (query === null) return [];
    const limit = tab === 'all' ? PICKER_PREVIEW : PICKER_LIMIT;
    const people =
      tab === 'session'
        ? []
        : selectTodayMembers(members.values(), query, limit).map((member) => ({
            kind: 'member' as const,
            target: { kind: 'member', id: member.userId },
            member,
          }));
    const sessions =
      tab === 'member'
        ? []
        : (query
            ? selectSessionMentionCandidates(items, query, limit)
            : [...items].sort((a, b) => b.activityAt - a.activityAt).slice(0, limit)
          ).map((item) => ({
            kind: 'session' as const,
            target: { kind: 'session', id: item.sessionId },
            item,
          }));
    return [...people, ...sessions];
  }, [items, members, query, tab]);
  if (controller) controller.pickerItems = rows.map((row) => row.target);
  const anchorBottom = picker ? (root?.getBoundingClientRect().bottom ?? 0) : null;
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || anchorBottom === null) return;
    setAbove(anchorBottom + 4 + menu.offsetHeight > window.innerHeight);
  }, [anchorBottom, rows.length, tab]);
  if (!controller || !picker || !root) return null;
  // Under the `@`: the caret's line when the browser can measure it, else the node.
  const selection = window.getSelection();
  const caret =
    selection?.rangeCount && root.contains(selection.anchorNode)
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
  const rect = caret && caret.height > 0 ? caret : root.getBoundingClientRect();
  const tabs: Array<[TodayPickerTab, string]> = [
    ['all', t('today.picker.all', 'All')],
    ['member', t('today.picker.people', 'People')],
    ['session', t('today.picker.sessions', 'Sessions')],
  ];
  return (
    <div
      ref={menuRef}
      {...stylex.props(pickerStyles.menu)}
      style={
        above
          ? { left: rect.left, bottom: window.innerHeight - rect.top + 4 }
          : { left: rect.left, top: rect.bottom + 4 }
      }
      onMouseDown={(event) => event.preventDefault()}
    >
      {withPeople ? (
        <div {...stylex.props(pickerStyles.tabs)} role="tablist">
          {tabs.map(([id, label]) => (
            <button
              type="button"
              key={id}
              role="tab"
              aria-selected={tab === id}
              {...stylex.props(pickerStyles.tab, tab === id && pickerStyles.tabActive)}
              onClick={() => controller.setPickerTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        role="listbox"
        aria-label={t('today.pickMention', 'Mention')}
        style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {rows.length === 0 ? (
          <span {...stylex.props(pickerStyles.empty)}>
            {tab === 'member'
              ? t('today.noMembers', 'No matching people')
              : tab === 'session'
                ? t('today.noSessions', 'No matching sessions')
                : t('today.noMentions', 'No matching people or sessions')}
          </span>
        ) : (
          rows.map((row, index) => (
            <button
              type="button"
              key={`${row.target.kind}:${row.target.id}`}
              role="option"
              aria-selected={index === picker.index}
              data-today-picker-kind={row.kind}
              {...stylex.props(
                pickerStyles.item,
                index === picker.index && pickerStyles.highlighted
              )}
              onClick={() => controller.acceptPicker(row.target)}
            >
              {row.kind === 'member' ? (
                <>
                  <UserAvatar
                    user={{ id: row.member.userId, name: row.member.name, image: row.member.image }}
                    size="small"
                  />
                  <span {...stylex.props(pickerStyles.itemLabel)}>{row.member.name}</span>
                </>
              ) : (
                <>
                  <span {...stylex.props(pickerStyles.itemIcon)}>
                    <MessageSquare size={14} strokeWidth={1.75} />
                  </span>
                  <span {...stylex.props(pickerStyles.itemLabel)}>
                    {row.item.title || t('today.untitledSession', 'Untitled session')}
                  </span>
                </>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
