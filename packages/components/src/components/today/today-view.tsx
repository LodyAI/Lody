import * as stylex from '@stylexjs/stylex';
import { CalendarDays, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildTodayLink, parseTodayDate, type TodayDate } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { userAtom } from '@/atoms';
import { runtimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import { writeTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/toast';
import { TodayEditorContext } from './editor/today-editor-context';
import { TodayEditorController } from './editor/today-editor-controller';
import { TodayDaySection } from './today-day-section';
import { buildDayStream, localTodayDate, todayDateToLocalDate } from './today-stream';
import { useTodayClock } from './use-today-clock';

export type TodayViewTarget = { member?: string; date?: string };

const styles = stylex.create({
  root: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: text.subheadlineSize,
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  scroller: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[6],
    paddingBottom: space[8],
  },
  back: {
    position: 'absolute',
    insetInline: 0,
    bottom: space[4],
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  backButton: { pointerEvents: 'auto' },
  calendar: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    padding: space[2],
    width: 252,
  },
  calendarHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: text.subheadlineSize,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 },
  weekday: { fontSize: text.captionSize, color: colors.tertiaryLabel, textAlign: 'center' },
  day: {
    position: 'relative',
    height: 30,
    borderRadius: radius.small,
    borderWidth: 0,
    background: 'none',
    color: colors.label,
    fontSize: text.footnoteSize,
    cursor: 'pointer',
    ':hover': { backgroundColor: colors.hoverFill },
  },
  dayOutside: { color: colors.tertiaryLabel },
  dayToday: { color: colors.accent, fontWeight: 600 },
  dayMark: {
    position: 'absolute',
    bottom: 3,
    left: '50%',
    width: 4,
    height: 4,
    marginLeft: -2,
    borderRadius: radius.full,
    backgroundColor: colors.secondaryLabel,
  },
});

/**
 * The Today day stream for one member. Behavior: specs/today-outline.md.
 * Navigation is the host's: the full page writes the route search, the pinned
 * column keeps its own state.
 */
export function TodayView(props: {
  target: TodayViewTarget;
  onNavigate: (target: TodayViewTarget) => void;
}) {
  const { t, i18n } = useTranslation();
  const scope = useResolvedWorkspaceScope();
  const activeRuntime = useAtomValue(runtimeAtom);
  const runtime =
    scope.enabled && activeRuntime && scope.workspaceId === activeRuntime.workspaceId
      ? activeRuntime
      : null;
  const self = useAtomValue(userAtom)?.id ?? null;
  const userId = props.target.member ?? self;
  const today = useTodayClock();
  const anchor = props.target.date ? (parseTodayDate(props.target.date) ?? undefined) : undefined;
  const [registered, setRegistered] = useState<readonly TodayDate[]>([]);
  const [empty, setEmpty] = useState<ReadonlySet<TodayDate>>(new Set());
  const { members, isMultiMember } = useWorkspaceMembers();

  useEffect(() => {
    setRegistered([]);
    setEmpty(new Set());
    if (!runtime || !userId) return undefined;
    return runtime.todayPages.observeDates(userId, setRegistered);
  }, [runtime, userId]);

  const onEmpty = useCallback((date: TodayDate) => {
    setEmpty((previous) => (previous.has(date) ? previous : new Set(previous).add(date)));
  }, []);
  const days = useMemo(
    () => buildDayStream({ today, anchor, registered, empty }),
    [anchor, empty, registered, today]
  );
  const cache = runtime?.todayPages ?? null;
  const [controller, setController] = useState<TodayEditorController | null>(null);
  useEffect(() => {
    if (!cache) return undefined;
    const created = new TodayEditorController(cache);
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [cache]);
  const memberName =
    userId && userId !== self
      ? members.find((member) => member.userId === userId)?.name
      : undefined;

  if (!runtime || !userId) return null;
  return (
    <TodayEditorContext.Provider value={controller}>
      <div {...stylex.props(styles.root)} data-testid="today-view">
        <div {...stylex.props(styles.toolbar)}>
          <span {...stylex.props(styles.title)}>
            {memberName ? t('today.memberTitle', '{{name}}’s Today', { name: memberName }) : null}
          </span>
          <TodayCalendar
            today={today}
            selected={anchor ?? today}
            registered={registered}
            language={i18n.language}
            onPick={(date) =>
              props.onNavigate({ ...props.target, date: date === today ? undefined : date })
            }
          />
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button variant="ghost" size="small" icon aria-label={t('today.more', 'More')}>
                  <MoreHorizontal size={16} />
                </Button>
              }
            />
            <Menu.Content>
              {isMultiMember ? (
                <Menu.Submenu>
                  <Menu.SubmenuTrigger>
                    {t('today.viewMember', "View a member's Today")}
                  </Menu.SubmenuTrigger>
                  <Menu.Content>
                    {members.map((member) => (
                      <Menu.Item
                        key={member.userId}
                        onClick={() =>
                          props.onNavigate({
                            date: props.target.date,
                            member: member.userId === self ? undefined : member.userId,
                          })
                        }
                      >
                        {member.name}
                      </Menu.Item>
                    ))}
                  </Menu.Content>
                </Menu.Submenu>
              ) : null}
              <Menu.Item
                onClick={() => {
                  void writeTextToClipboard(
                    buildTodayLink(runtime.workspaceId, userId, anchor ?? today)
                  ).then((copied) => {
                    if (copied) toast.success(t('today.linkCopied', 'Link copied'));
                  });
                }}
              >
                {t('today.copyLink', 'Copy link')}
              </Menu.Item>
            </Menu.Content>
          </Menu.Root>
        </div>
        <div {...stylex.props(styles.scroller)}>
          {days.map((date, index) => (
            <TodayDaySection
              key={`${userId}:${date}`}
              cache={runtime.todayPages}
              userId={userId}
              date={date}
              today={today}
              isTop={index === 0}
              onEmpty={onEmpty}
            />
          ))}
        </div>
        {anchor && anchor !== today ? (
          <div {...stylex.props(styles.back)}>
            <span {...stylex.props(styles.backButton)}>
              <Button
                variant="secondary"
                size="small"
                shape="pill"
                onClick={() => props.onNavigate({ ...props.target, date: undefined })}
              >
                {t('today.backToToday', 'Back to today')}
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </TodayEditorContext.Provider>
  );
}

function TodayCalendar(props: {
  today: TodayDate;
  selected: TodayDate;
  registered: readonly TodayDate[];
  language: string;
  onPick: (date: TodayDate) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => todayDateToLocalDate(props.selected));
  const marked = useMemo(() => new Set(props.registered), [props.registered]);
  const cells = useMemo(() => monthCells(month), [month]);
  const weekdayFormat = new Intl.DateTimeFormat(props.language, { weekday: 'narrow' });
  const monthFormat = new Intl.DateTimeFormat(props.language, { year: 'numeric', month: 'long' });
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setMonth(todayDateToLocalDate(props.selected));
      }}
    >
      <Popover.Trigger
        render={
          <Button variant="ghost" size="small" icon aria-label={t('today.calendar', 'Pick a date')}>
            <CalendarDays size={16} />
          </Button>
        }
      />
      <Popover.Content>
        <div {...stylex.props(styles.calendar)}>
          <div {...stylex.props(styles.calendarHead)}>
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={t('today.previousMonth', 'Previous month')}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <ChevronLeft size={14} />
            </Button>
            <span>{monthFormat.format(month)}</span>
            <Button
              variant="ghost"
              size="mini"
              icon
              aria-label={t('today.nextMonth', 'Next month')}
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
          <div {...stylex.props(styles.grid)}>
            {cells.slice(0, 7).map((cell) => (
              <span key={`w${cell.getDay()}`} {...stylex.props(styles.weekday)}>
                {weekdayFormat.format(cell)}
              </span>
            ))}
            {cells.map((cell) => {
              const date = localTodayDate(cell);
              return (
                <button
                  type="button"
                  key={date}
                  {...stylex.props(
                    styles.day,
                    cell.getMonth() !== month.getMonth() && styles.dayOutside,
                    date === props.today && styles.dayToday
                  )}
                  aria-pressed={date === props.selected}
                  onClick={() => {
                    setOpen(false);
                    props.onPick(date);
                  }}
                >
                  {cell.getDate()}
                  {marked.has(date) ? <span {...stylex.props(styles.dayMark)} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}

/** Six Monday-first weeks covering `month`. */
function monthCells(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index)
  );
}
