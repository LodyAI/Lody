import { useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { Popover } from '@lody/ui/popover';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { MessageQueueItem, SessionId } from '@lody/shared';
import { ChatComposer } from '@/components/chat/chat-composer';
import { MessageQueueDisplay } from '@/components/sessions/message-queue';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: { default: space[8], '@media (max-width: 600px)': space[1] },
    backgroundColor: colors.background,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: { default: space[6], '@media (max-width: 600px)': space[2] },
  },
  frame: { width: '100%', maxWidth: 760 },
  inset: { marginInline: { default: space[3], '@media (max-width: 600px)': 0 } },
  footer: { flexShrink: 0, color: colors.secondaryLabel },
  timeLink: {
    color: colors.secondaryLabel,
    fontWeight: 400,
    textDecoration: 'underline',
    textUnderlineOffset: 4,
    textDecorationColor: colors.separator,
  },
  airy: { paddingBlock: space[1] },
  label: { fontSize: text.footnoteSize, color: colors.secondaryLabel, margin: 0 },
  picker: { width: 420, maxWidth: 'calc(100vw - 32px)' },
  modalPicker: { width: '100%', maxWidth: '100%' },
  modalTop: { padding: 0, paddingBottom: space[4] },
  modalBody: { gridTemplateColumns: 'minmax(0, 1fr) 88px', paddingInline: 0 },
  top: { padding: space[4], display: 'flex', flexDirection: 'column', gap: space[4] },
  title: { margin: 0, fontSize: text.bodySize, fontWeight: 600 },
  presets: { display: 'flex', gap: space[1.5] },
  body: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 104px',
    paddingInline: space[2],
  },
  calendar: { padding: space[2] },
  month: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space[2],
  },
  monthLabel: { fontSize: text.footnoteSize },
  arrows: { display: 'flex' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2 },
  weekday: {
    textAlign: 'center',
    paddingBottom: space[1],
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  day: { display: 'flex', justifyContent: 'center' },
  otherMonth: { opacity: 0.35 },
  time: {
    padding: 0,

    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: space[1],
  },
  column: { minWidth: 0 },
  columnLabel: {
    textAlign: 'center',
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    margin: '0 0 8px',
  },
  scroll: {
    height: 180,
    overflowY: 'auto',
    paddingInline: space[1],
    paddingBlock: space[1],
    scrollbarWidth: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  number: { flexShrink: 0, display: 'flex', justifyContent: 'center' },
  bottom: { padding: space[3], display: 'flex', flexDirection: 'column', gap: space[2] },
  bottomActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
});
const pad = (value: number) => String(value).padStart(2, '0');
const baseDay = '2026-10-27';

function NumberColumn({
  label,
  value,
  count,
  onChange,
}: {
  label: string;
  value: number;
  count: number;
  onChange: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const selected = element?.children[value] as HTMLElement | undefined;
    if (element && selected) element.scrollTop = selected.offsetTop - element.offsetTop - 70;
  }, [value]);
  return (
    <div {...stylex.props(styles.column)}>
      <p {...stylex.props(styles.columnLabel)}>{label}</p>
      <div ref={ref} {...stylex.props(styles.scroll)}>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} {...stylex.props(styles.number)}>
            <Button
              size="small"
              variant={value === index ? 'secondary' : 'ghost'}
              aria-label={`${label} ${index}`}
              onClick={() => onChange(index)}
            >
              {pad(index)}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreviewTimePicker({
  value,
  onApply,
  onRemove,
  modal = false,
}: {
  modal?: boolean;
  value: string | null;
  onApply: (value: string) => void;
  onRemove: () => void;
}) {
  const [day, setDay] = useState(value?.slice(0, 10) ?? baseDay);
  const [hour, setHour] = useState(Number(value?.slice(11, 13) ?? '21'));
  const [minute, setMinute] = useState(Number(value?.slice(14, 16) ?? '00'));
  const [month, setMonth] = useState(() => new Date(`${day.slice(0, 7)}-01T00:00:00Z`));
  const year = month.getUTCFullYear(),
    monthNumber = month.getUTCMonth();
  const firstWeekday = new Date(Date.UTC(year, monthNumber, 1)).getUTCDay();
  const days = Array.from(
    { length: 42 },
    (_, index) => new Date(Date.UTC(year, monthNumber, index - firstWeekday + 1))
  );
  const chosen = `${day}T${pad(hour)}:${pad(minute)}`;
  const shortcut = (minutes: number) => {
    const next = new Date(Date.UTC(2026, 9, 27, 16, minutes));
    setDay(next.toISOString().slice(0, 10));
    setHour(next.getUTCHours());
    setMinute(next.getUTCMinutes());
    setMonth(new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1)));
  };
  return (
    <div {...stylex.props(styles.picker, modal && styles.modalPicker)}>
      <div {...stylex.props(styles.top, modal && styles.modalTop)}>
        {modal ? (
          <Dialog.Title>什么时间发送</Dialog.Title>
        ) : (
          <p {...stylex.props(styles.title)}>什么时间发送</p>
        )}
        <div {...stylex.props(styles.presets)}>
          <Button size="small" variant="secondary" onClick={() => shortcut(30)}>
            30 分钟后
          </Button>
          <Button size="small" variant="secondary" onClick={() => shortcut(60)}>
            1 小时后
          </Button>
          <Button size="small" variant="secondary" onClick={() => shortcut(300)}>
            5 小时后
          </Button>
        </div>
      </div>
      <div {...stylex.props(styles.body, modal && styles.modalBody)}>
        <div {...stylex.props(styles.calendar)}>
          <div {...stylex.props(styles.month)}>
            <span {...stylex.props(styles.monthLabel)}>
              {year} 年 {monthNumber + 1} 月
            </span>
            <div {...stylex.props(styles.arrows)}>
              <Button
                icon
                size="small"
                variant="ghost"
                aria-label="上个月"
                onClick={() => setMonth(new Date(Date.UTC(year, monthNumber - 1, 1)))}
              >
                <ChevronLeft size={14} />
              </Button>
              <Button
                icon
                size="small"
                variant="ghost"
                aria-label="下个月"
                onClick={() => setMonth(new Date(Date.UTC(year, monthNumber + 1, 1)))}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
          <div {...stylex.props(styles.grid)}>
            {['日', '一', '二', '三', '四', '五', '六'].map((label) => (
              <span key={label} {...stylex.props(styles.weekday)}>
                {label}
              </span>
            ))}
            {days.map((date) => {
              const id = date.toISOString().slice(0, 10);
              return (
                <div
                  key={id}
                  {...stylex.props(
                    styles.day,
                    date.getUTCMonth() !== monthNumber && styles.otherMonth
                  )}
                >
                  <Button
                    icon
                    size="small"
                    variant={id === day ? 'primary' : 'ghost'}
                    aria-label={id}
                    onClick={() => setDay(id)}
                  >
                    {date.getUTCDate()}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
        <div {...stylex.props(styles.time)}>
          <NumberColumn label="小时" value={hour} count={24} onChange={setHour} />
          <NumberColumn label="分钟" value={minute} count={60} onChange={setMinute} />
        </div>
      </div>
      <div {...stylex.props(styles.bottom)}>
        <div {...stylex.props(styles.bottomActions)}>
          <Button variant="ghost" size="small" onClick={onRemove}>
            取消定时
          </Button>
          <Button size="small" onClick={() => onApply(chosen)}>
            确定
          </Button>
        </div>
      </div>
    </div>
  );
}

export function QueuedScheduledMessagePreview({
  variant = 'end',
}: {
  variant?: 'start' | 'end' | 'airy';
}) {
  const mobile = useIsMobile();
  const [times, setTimes] = useState<Record<string, string | null>>({
    'preview-queued-turn': '2026-10-27T21:00',
    'preview-second-turn': '2026-10-28T09:00',
  });
  const [openCid, setOpenCid] = useState<string | null>(null);
  const [textValue, setTextValue] = useState('');
  const [items, setItems] = useState<MessageQueueItem[]>(() => [
    {
      $cid: 'preview-queued-turn',
      userId: 'preview-user',
      userTurnId: 'preview-user-turn',
      task: 'continue',
      timestamp: '2026-10-27T08:00:00Z',
      acpSessionConfig: { prompt: 'continue', cliType: 'builtin', agentType: 'claude' },
    } as MessageQueueItem,
    {
      $cid: 'preview-second-turn',
      userId: 'preview-user',
      userTurnId: 'preview-second',
      task: '整理今天的改动，列出还需要确认的问题',
      timestamp: '2026-10-27T08:00:00Z',
      acpSessionConfig: {
        prompt: '整理今天的改动，列出还需要确认的问题',
        cliType: 'builtin',
        agentType: 'claude',
      },
    } as MessageQueueItem,
    {
      $cid: 'preview-ordinary',
      userId: 'preview-user',
      userTurnId: 'preview-ordinary-turn',
      task: '先检查测试结果',
      timestamp: '2026-10-27T08:00:00Z',
      acpSessionConfig: { prompt: '先检查测试结果', cliType: 'builtin', agentType: 'claude' },
    } as MessageQueueItem,
  ]);
  const editing = (item: MessageQueueItem, isEditing: boolean) =>
    setItems((rows) => rows.map((row) => (row.$cid === item.$cid ? { ...row, isEditing } : row)));
  return (
    <div {...stylex.props(styles.canvas)}>
      <p {...stylex.props(styles.label)}>
        {variant === 'start' ? 'A · 时间在前' : variant === 'end' ? 'B · 内容在前' : 'C · 宽松留白'}{' '}
        · 真实组件交互预览
      </p>
      <div {...stylex.props(styles.frame)}>
        <div {...stylex.props(styles.inset)}>
          <MessageQueueDisplay
            sessionId={'queued-time-preview' as SessionId}
            items={items}
            title="消息队列"
            roomy={variant === 'airy' ? 'airy' : true}
            footerPosition={mobile ? 'inline' : variant === 'start' ? 'start' : 'end'}
            showSteerAction={false}
            onRemove={(cid) => setItems((rows) => rows.filter((row) => row.$cid !== cid))}
            getItemScheduledAt={(item) =>
              times[item.$cid] ? Date.parse(`${times[item.$cid]}:00+08:00`) : null
            }
            onReorder={(activeCid, overCid) =>
              setItems((rows) => {
                const active = rows.find((row) => row.$cid === activeCid);
                const target = rows.findIndex((row) => row.$cid === overCid);
                if (!active || target < 0 || activeCid === overCid) return rows;
                const next = rows.filter((row) => row.$cid !== activeCid);
                next.splice(target, 0, active);
                return next;
              })
            }
            onEditStart={(item) => editing(item, true)}
            onEditCancel={(item) => editing(item, false)}
            onEditSave={(item, task) =>
              setItems((rows) =>
                rows.map((row) =>
                  row.$cid === item.$cid
                    ? {
                        ...row,
                        task,
                        isEditing: false,
                        acpSessionConfig: { ...row.acpSessionConfig, prompt: task },
                      }
                    : row
                )
              )
            }
            onSteer={() => {}}
            renderItemFooter={(item) => {
              const value = times[item.$cid] ?? null;
              if (!value) return null;
              const trigger = (
                <Button size="small" variant={mobile ? 'link' : 'ghost'}>
                  <span {...stylex.props(styles.timeLink)}>
                    {value
                      ? `${value.slice(5, 10).replace('-', '/')} ${value.slice(11)} 发送`
                      : '添加发送时间'}
                  </span>
                </Button>
              );
              const picker = (
                <PreviewTimePicker
                  modal={mobile}
                  value={value}
                  onApply={(next) => {
                    setTimes((current) => ({ ...current, [item.$cid]: next }));
                    setOpenCid(null);
                  }}
                  onRemove={() => {
                    setTimes((current) => ({ ...current, [item.$cid]: null }));
                    setOpenCid(null);
                  }}
                />
              );
              return (
                <span {...stylex.props(styles.footer, variant === 'airy' && styles.airy)}>
                  {mobile ? (
                    <Dialog.Root
                      open={openCid === item.$cid}
                      onOpenChange={(open) => setOpenCid(open ? item.$cid : null)}
                    >
                      <Dialog.Trigger render={trigger} />
                      <Dialog.Content width={380} closeLabel="关闭时间编辑">
                        {picker}
                      </Dialog.Content>
                    </Dialog.Root>
                  ) : (
                    <Popover.Root
                      open={openCid === item.$cid}
                      onOpenChange={(open) => setOpenCid(open ? item.$cid : null)}
                    >
                      <Popover.Trigger render={trigger} />
                      <Popover.Content
                        side="top"
                        align="start"
                        className="w-auto p-0"
                        aria-label="发送时间选择器"
                      >
                        {picker}
                      </Popover.Content>
                    </Popover.Root>
                  )}
                </span>
              );
            }}
          />
        </div>
        <ChatComposer
          variant="session"
          tone="light"
          promptValue={textValue}
          onPromptChange={setTextValue}
          onAttachmentAddClick={() => {}}
          primaryAction={
            <Button
              icon
              disabled={!textValue.trim()}
              aria-label="加入预览队列"
              onClick={() => {
                setItems((rows) => [
                  ...rows,
                  {
                    userId: 'preview-user',
                    timestamp: '2026-10-27T08:00:00Z',
                    project: undefined,
                    $cid: crypto.randomUUID(),
                    userTurnId: crypto.randomUUID(),
                    task: textValue,
                    acpSessionConfig: {
                      prompt: textValue,
                      cliType: 'builtin',
                      agentType: 'claude',
                    },
                  } as MessageQueueItem,
                ]);
                setTextValue('');
              }}
            >
              <ArrowUp size={16} />
            </Button>
          }
        />
      </div>
    </div>
  );
}
