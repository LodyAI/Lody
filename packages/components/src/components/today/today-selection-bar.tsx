import * as stylex from '@stylexjs/stylex';
import { Copy, MessageSquarePlus, Square, SquareCheck, Trash2, Type } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { TODAY_MENTION_CHAR, type TodayNodeId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Kbd } from '@lody/ui/kbd';
import { Tooltip } from '@lody/ui/tooltip';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { formatKeyBinding } from '@/lib/commands';
import type { TodayPageStore } from '@/lib/today/today-page-store';
import { topLevelSelection } from './editor/block-selection';
import { useTodayEditor } from './editor/today-editor-context';

const BAR_HEIGHT = 36;
const BAR_GAP = 6;

const styles = stylex.create({
  bar: {
    position: 'fixed',
    zIndex: 45,
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    height: BAR_HEIGHT,
    boxSizing: 'border-box',
    padding: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.raisedBackground,
    boxShadow: shadow.popover,
  },
  divider: {
    width: 1,
    alignSelf: 'stretch',
    marginBlock: space[1],
    marginInline: 2,
    backgroundColor: colors.separator,
  },
  tip: { display: 'flex', alignItems: 'center', gap: space[1] },
});

/** Block-selection actions. Behavior: specs/today-outline.md (Outline editing). */
export function TodaySelectionBar(props: {
  onConvert: (store: TodayPageStore, nodeId: TodayNodeId) => void;
}) {
  const { t } = useTranslation();
  const controller = useTodayEditor();
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const [layout, setLayout] = useState(0);
  const selection =
    controller && !controller.isSelectingByPointer() ? controller.getBlockSelection() : null;
  const version = controller?.getVersion() ?? 0;
  const snapshot = useSyncExternalStore(
    selection?.store.subscribe ?? noopSubscribe,
    selection?.store.getSnapshot ?? noSnapshot
  );
  const surface = controller?.getSurface() ?? null;

  useEffect(() => {
    if (!selection || !surface) return undefined;
    const bump = () => setLayout((value) => value + 1);
    surface.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    return () => {
      surface.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, [selection, surface]);

  useLayoutEffect(() => {
    if (!selection || !surface) return setPlace(null);
    const ids = new Set<string>(selection.ids);
    const rows = [...surface.querySelectorAll<HTMLElement>('[data-today-node]')].filter((row) =>
      ids.has(row.dataset.todayNode ?? '')
    );
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) return setPlace(null);
    const bounds = surface.getBoundingClientRect();
    const top = first.getBoundingClientRect().top - BAR_HEIGHT - BAR_GAP;
    const below = last.getBoundingClientRect().bottom + BAR_GAP;
    const bullet = first.querySelector('[data-today-bullet]') ?? first;
    const width = ref.current?.offsetWidth ?? 0;
    const left = Math.max(
      bounds.left + 4,
      Math.min(bullet.getBoundingClientRect().left, bounds.right - width - 4)
    );
    setPlace({
      top: top >= bounds.top ? top : Math.min(below, bounds.bottom - BAR_HEIGHT - 4),
      left,
    });
    return undefined;
  }, [selection, surface, version, layout, snapshot]);

  if (!controller || !selection) return null;
  const { store } = selection;
  const visible = snapshot?.visible ?? [];
  const roots = topLevelSelection(visible, selection.ids);
  const root = roots.length === 1 ? store.outline.getNode(roots[0]!) : undefined;
  const canConvert = !!root && root.text.replaceAll(TODAY_MENTION_CHAR, '').trim().length > 0;
  const state = visible.find((node) => node.id === selection.ids[0])?.todo;
  const todo =
    state === undefined
      ? { icon: <Square size={16} />, label: t('today.todo.make', 'Turn into to-do') }
      : state === 'todo'
        ? { icon: <SquareCheck size={16} />, label: t('today.todo.markDone', 'Mark as done') }
        : { icon: <Type size={16} />, label: t('today.todo.clear', 'Back to plain text') };

  return (
    <Tooltip.Provider delay={400}>
      <div
        ref={ref}
        role="toolbar"
        aria-label={t('today.selectionActions', 'Selected nodes')}
        {...stylex.props(styles.bar)}
        style={place ? place : { visibility: 'hidden', top: 0, left: 0 }}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
      >
        <BarButton
          label={todo.label}
          shortcut={formatKeyBinding('Mod+Enter')}
          onClick={() => controller.cycleSelectionTodo()}
        >
          {todo.icon}
        </BarButton>
        <Button
          variant="ghost"
          size="small"
          disabled={!canConvert}
          onClick={() => root && props.onConvert(store, root.id)}
        >
          <MessageSquarePlus size={16} />
          {t('today.convertToTask', 'Convert to task')}
        </Button>
        <span {...stylex.props(styles.divider)} />
        <BarButton
          label={t('common.copy', 'Copy')}
          shortcut={formatKeyBinding('Mod+C')}
          onClick={() => controller.copySelection()}
        >
          <Copy size={16} />
        </BarButton>
        <BarButton
          label={t('common.delete', 'Delete')}
          shortcut="⌫"
          onClick={() => controller.deleteSelection()}
        >
          <Trash2 size={16} />
        </BarButton>
      </div>
    </Tooltip.Provider>
  );
}

const noopSubscribe = () => () => {};
const noSnapshot = () => null;

function BarButton(props: {
  label: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Button
            variant="ghost"
            size="small"
            icon
            aria-label={props.label}
            onClick={props.onClick}
          >
            {props.children}
          </Button>
        }
      />
      <Tooltip.Content side="top">
        <span {...stylex.props(styles.tip)}>
          {props.label}
          <Kbd>{props.shortcut}</Kbd>
        </span>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
