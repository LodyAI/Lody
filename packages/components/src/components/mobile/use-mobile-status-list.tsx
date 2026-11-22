import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  CircleCheck,
  Clock,
  Ellipsis,
  Focus,
  FolderInput,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  buildStatusViewLayout,
  getServerNow,
  planNewPinSectionOrderKey,
  type PinSection,
  type StatusViewCommand,
  type StatusViewLayout,
  type StatusViewState,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { AlertDialog } from '@/ui/dialog';
import { MobileLaterSheet, MobileSectionNameSheet } from './mobile-later-sheet';
import { MobileSessionMenuSheet, type MobileSessionMenuAction } from './mobile-session-menu-sheet';
import type { MobileConversationItem } from './mobile-project-screen';
import {
  applyStatusViewMove,
  buildMobileStatusViewInput,
  findStatusViewEntry,
  statusViewNeighbourBeforeId,
  statusViewPlacementSignature,
} from './mobile-status-view';
import { useStatusListDrag } from './use-status-list-drag';

type MoveCommand = Extract<StatusViewCommand, { type: 'move' }>;

/**
 * What the phone Status list needs from its host. `run` plans one shared
 * command against `state` and performs its writes (`useSessionActions()
 * .runStatusViewCommand`); Later, Settle and Move to Focus go through the
 * host's confirmation and Undo flow (`useMobileStatusActions`).
 */
export type MobileStatusCommands = {
  run: (command: StatusViewCommand, state: StatusViewState) => Promise<void>;
  snooze: (sessionId: string, until: number) => void;
  settle: (sessionId: string) => void;
  moveToFocus: (sessionId: string) => void;
  report: (error: unknown) => void;
};

/** Same bucket ids `groupChats` emits for the Pinned area. */
export const sectionIdOfPinnedBucket = (bucketId: string, pinnedBucketId: string) =>
  bucketId === pinnedBucketId ? null : bucketId.slice(pinnedBucketId.length + 1);

/**
 * The longest delay `setTimeout` honours. A longer one fires at once in browsers,
 * which re-ran the clock effect every tick; a later change re-arms on the next tick.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const icon = (Icon: typeof Clock) => <Icon size={14} aria-hidden="true" />;

export function useMobileStatusList({
  chats,
  sections,
  sectionsLoaded,
  writable,
  preferable = true,
  scopeHiddenCounts,
  statusMode,
  commands,
  rowActions,
  touchSurfaces,
}: {
  /** Split-panel portal targets holding rows outside the list's own element. */
  touchSurfaces?: readonly HTMLElement[];
  chats: readonly MobileConversationItem[];
  sections: readonly PinSection[];
  sectionsLoaded: boolean;
  /** Read-only members may only pin: no status writes, no section management. */
  writable: boolean;
  /** False when not even a pin can be written (an encrypted workspace's read role). */
  preferable?: boolean;
  /** Pinned rows the list's scope hid, by pin section id (`""` = default). */
  scopeHiddenCounts?: Record<string, number>;
  /** The Status grouping is showing (drag and the row menu live there). */
  statusMode: boolean;
  commands?: MobileStatusCommands;
  rowActions?: {
    onTogglePin?: (chatId: string, nextPinned: boolean) => void;
    onArchive?: (chatId: string) => void;
  };
}) {
  const { t } = useTranslation();
  const [clock, setClock] = useState(() => getServerNow());
  const input = useMemo(
    () =>
      buildMobileStatusViewInput(chats, {
        sections,
        sectionsLoaded,
        writable,
        preferable,
        scopeHiddenCounts,
        nowMs: clock,
      }),
    [chats, clock, preferable, scopeHiddenCounts, sections, sectionsLoaded, writable]
  );
  const liveLayout = useMemo(() => buildStatusViewLayout(input), [input]);

  useEffect(() => {
    const now = getServerNow();
    const untilChange = liveLayout.nextChangeAt === null ? Infinity : liveLayout.nextChangeAt - now;
    const wait = Math.min(
      untilChange,
      statusMode && liveLayout.later.length > 0 ? 60_000 : Infinity
    );
    if (!Number.isFinite(wait)) return undefined;
    const timer = window.setTimeout(
      () => setClock(getServerNow()),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1_000, wait))
    );
    return () => window.clearTimeout(timer);
  }, [liveLayout, statusMode]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setClock(getServerNow());
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);
  const [held, setHeld] = useState<{ move: MoveCommand; signature: string } | null>(null);
  useEffect(() => {
    if (held && statusViewPlacementSignature(chatById.get(held.move.sessionId)) !== held.signature)
      setHeld(null);
  }, [chatById, held]);
  const heldLayout = useMemo(
    () => (held ? applyStatusViewMove(liveLayout, held.move) : liveLayout),
    [held, liveLayout]
  );

  const runMove = useCallback(
    (move: MoveCommand) => {
      if (!commands) return;
      setHeld({ move, signature: statusViewPlacementSignature(chatById.get(move.sessionId)) });
      void commands.run(move, input).catch((error: unknown) => {
        setHeld(null);
        commands.report(error);
      });
    },
    [chatById, commands, input]
  );
  const run = useCallback(
    (command: StatusViewCommand) => {
      if (!commands) return;
      void commands.run(command, input).catch(commands.report);
    },
    [commands, input]
  );

  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sectionPickerFor, setSectionPickerFor] = useState<string | null>(null);
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const [nameSheet, setNameSheet] = useState<
    | { kind: 'create'; moveSessionId: string | null }
    | { kind: 'rename'; sectionId: string; name: string }
    | null
  >(null);
  const [sectionMenuFor, setSectionMenuFor] = useState<{ sectionId: string | null } | null>(null);
  const [deleteSection, setDeleteSection] = useState<{ sectionId: string; name: string } | null>(
    null
  );

  const frozen = useRef<StatusViewLayout | null>(null);
  const drag = useStatusListDrag({
    enabled: statusMode && Boolean(commands) && (writable || preferable),
    canDrag: (rootId) => {
      const entry = findStatusViewEntry(frozen.current ?? heldLayout, rootId);
      if (!entry || entry.nested) return false;
      return entry.place.area.area === 'pinned' ? entry.row.canPrefer : entry.row.canManage;
    },
    layout: frozen.current ?? heldLayout,
    onOpenMenu: setMenuFor,
    onDrop: runMove,
    extraSurfaces: touchSurfaces,
  });
  if (drag.state.phase === 'idle') frozen.current = null;
  else frozen.current ??= heldLayout;
  const layout = frozen.current ?? heldLayout;

  const dropTarget = drag.state.phase === 'dragging' ? drag.state.target : null;

  const namedSections = layout.pinned.filter((section) => section.sectionId !== null);

  const rowMenuActions = (sessionId: string): MobileSessionMenuAction[] => {
    const entry = findStatusViewEntry(layout, sessionId);
    const chat = chatById.get(sessionId);
    if (!entry || !chat) return [];
    const { place, row, nested } = entry;
    const actions: MobileSessionMenuAction[] = [];
    const area = place.area.area;
    if (row.canManage && area !== 'pinned') {
      if (area !== 'focus')
        actions.push({
          id: 'move-to-focus',
          icon: icon(Focus),
          label: t('sessions.contextMenu.moveToFocus', 'Move to Focus'),
          onClick: () => commands?.moveToFocus(sessionId),
        });
      actions.push({
        id: 'later',
        icon: icon(Clock),
        label: t('sessions.contextMenu.snooze', 'Later'),
        onClick: () => setLaterFor(sessionId),
      });
      if (area !== 'settled')
        actions.push({
          id: 'settle',
          icon: icon(CircleCheck),
          label: t('sessions.contextMenu.settle', 'Settle'),
          onClick: () => commands?.settle(sessionId),
        });
    }
    if (row.canPrefer && rowActions?.onTogglePin) {
      const pinned = chat.isPinned === true;
      actions.push({
        id: 'pin',
        icon: icon(pinned ? PinOff : Pin),
        label: pinned
          ? t('sessions.contextMenu.unpin', 'Unpin Session')
          : t('sessions.contextMenu.pin', 'Pin Session'),
        onClick: () => rowActions.onTogglePin!(sessionId, !pinned),
        separatorBefore: actions.length > 0,
      });
      if ((namedSections.length > 0 || layout.canManageSections) && (pinned || area !== 'pinned'))
        actions.push({
          id: 'move-to-section',
          icon: icon(FolderInput),
          label: t('sidebar.pinSections.moveToSection', 'Move to Section'),
          onClick: () => setSectionPickerFor(sessionId),
        });
    }
    const reorderable =
      !nested && ((area === 'focus' && row.canManage) || (area === 'pinned' && row.canPrefer));
    if (reorderable) {
      const to = place.area as MoveCommand['to'];
      const move = (
        direction: 'top' | 'up' | 'down',
        id: string,
        label: string,
        Icon: typeof Clock
      ) => {
        const beforeId = statusViewNeighbourBeforeId(place, direction);
        if (beforeId === undefined) return;
        actions.push({
          id,
          icon: icon(Icon),
          label,
          onClick: () => runMove({ type: 'move', sessionId, to, beforeId }),
        });
      };
      move(
        'top',
        'move-to-top',
        t('chat.mobileHome.status.moveToTop', 'Move to top'),
        ArrowUpToLine
      );
      move('up', 'move-up', t('chat.mobileHome.status.moveUp', 'Move up'), ArrowUp);
      move('down', 'move-down', t('chat.mobileHome.status.moveDown', 'Move down'), ArrowDown);
    }
    if (!chat.readOnly && rowActions?.onArchive) {
      actions.push({
        id: 'archive',
        icon: icon(Archive),
        label: t('sessions.contextMenu.archive', 'Archive Session'),
        onClick: () => rowActions.onArchive!(sessionId),
        separatorBefore: true,
      });
    }
    return actions;
  };

  const moveToSection = (sessionId: string, sectionId: string | null) => {
    const rows = layout.pinned.find((section) => section.sectionId === sectionId)?.rows ?? [];
    const first = rows.find((row) => row.id !== sessionId);
    runMove({
      type: 'move',
      sessionId,
      to: { area: 'pinned', sectionId },
      beforeId: first?.id ?? null,
    });
  };

  const sectionPickerActions = (sessionId: string): MobileSessionMenuAction[] => [
    {
      id: 'section:default',
      icon: icon(Pin),
      label: t('chat.mobileHome.groupLabels.pinned', 'Pinned'),
      onClick: () => moveToSection(sessionId, null),
    },
    ...namedSections.map((section) => ({
      id: `section:${section.sectionId}`,
      icon: icon(FolderInput),
      label: section.name ?? '',
      onClick: () => moveToSection(sessionId, section.sectionId),
    })),
    ...(layout.canManageSections
      ? [
          {
            id: 'section:new',
            icon: icon(Plus),
            label: t('sidebar.pinSections.newSection', 'New Section…'),
            onClick: () => setNameSheet({ kind: 'create', moveSessionId: sessionId }),
            separatorBefore: true,
          },
        ]
      : []),
  ];

  const sectionMenuActions = (sectionId: string | null): MobileSessionMenuAction[] => {
    const actions: MobileSessionMenuAction[] = [
      {
        id: 'section-new',
        icon: icon(Plus),
        label: t('sidebar.pinSections.newSection', 'New Section…'),
        onClick: () => setNameSheet({ kind: 'create', moveSessionId: null }),
      },
    ];
    if (sectionId === null) return actions;
    const index = namedSections.findIndex((section) => section.sectionId === sectionId);
    const section = namedSections[index];
    if (!section) return actions;
    actions.push({
      id: 'section-rename',
      icon: icon(Pencil),
      label: t('sidebar.pinSections.rename', 'Rename Section'),
      onClick: () => setNameSheet({ kind: 'rename', sectionId, name: section.name ?? '' }),
    });
    if (index > 0)
      actions.push({
        id: 'section-up',
        icon: icon(ArrowUp),
        label: t('chat.mobileHome.status.moveUp', 'Move up'),
        onClick: () =>
          run({ type: 'moveSection', sectionId, beforeId: namedSections[index - 1]!.sectionId }),
      });
    if (index < namedSections.length - 1)
      actions.push({
        id: 'section-down',
        icon: icon(ArrowDown),
        label: t('chat.mobileHome.status.moveDown', 'Move down'),
        onClick: () =>
          run({
            type: 'moveSection',
            sectionId,
            beforeId: namedSections[index + 2]?.sectionId ?? null,
          }),
      });
    actions.push({
      id: 'section-delete',
      icon: icon(Trash2),
      label: t('sidebar.pinSections.delete', 'Delete Section'),
      onClick: () => setDeleteSection({ sectionId, name: section.name ?? '' }),
      destructive: true,
      separatorBefore: true,
    });
    return actions;
  };

  /**
   * The ⋯ control on a Pinned-area heading, in the Status grouping only: that is
   * where pins can be dragged and placed. Absent for read-only members.
   */
  const sectionHeaderMenu = (sectionId: string | null): ReactNode =>
    commands && statusMode && layout.canManageSections ? (
      <Button
        variant="ghost"
        size="small"
        icon
        aria-label={t('sidebar.pinSections.sectionActions', 'Section actions')}
        data-status-section-menu={sectionId ?? ''}
        onClick={() => setSectionMenuFor({ sectionId })}
      >
        <Ellipsis size={16} aria-hidden="true" />
      </Button>
    ) : null;

  const laterChat = laterFor ? chatById.get(laterFor) : undefined;
  const overlays = commands ? (
    <>
      <MobileSessionMenuSheet
        open={menuFor !== null}
        onOpenChange={(open) => !open && setMenuFor(null)}
        title={menuFor ? chatById.get(menuFor)?.title : undefined}
        infoRows={[]}
        actions={menuFor ? rowMenuActions(menuFor) : []}
      />
      <MobileSessionMenuSheet
        open={sectionPickerFor !== null}
        onOpenChange={(open) => !open && setSectionPickerFor(null)}
        title={t('sidebar.pinSections.moveToSection', 'Move to Section')}
        infoRows={[]}
        actions={sectionPickerFor ? sectionPickerActions(sectionPickerFor) : []}
      />
      <MobileSessionMenuSheet
        open={sectionMenuFor !== null}
        onOpenChange={(open) => !open && setSectionMenuFor(null)}
        title={t('sidebar.pinSections.sectionActions', 'Section actions')}
        infoRows={[]}
        actions={sectionMenuFor ? sectionMenuActions(sectionMenuFor.sectionId) : []}
      />
      <AlertDialog.Root
        open={deleteSection !== null}
        onOpenChange={(open) => !open && setDeleteSection(null)}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('sidebar.pinSections.delete', 'Delete Section')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                'chat.mobileHome.status.deleteSectionDescription',
                'Delete “{{name}}”? Its conversations stay pinned and move to Pinned.',
                { name: deleteSection?.name ?? '' }
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteSection)
                  run({ type: 'deleteSection', sectionId: deleteSection.sectionId });
                setDeleteSection(null);
              }}
            >
              {t('sidebar.pinSections.delete', 'Delete Section')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <MobileLaterSheet
        open={laterFor !== null}
        onOpenChange={(open) => !open && setLaterFor(null)}
        title={laterChat?.title}
        nowMs={getServerNow()}
        onPick={(until) => laterFor && commands.snooze(laterFor, until)}
      />
      <MobileSectionNameSheet
        open={nameSheet !== null}
        onOpenChange={(open) => !open && setNameSheet(null)}
        heading={
          nameSheet?.kind === 'rename'
            ? t('sidebar.pinSections.renameTitle', 'Rename Section')
            : t('sidebar.pinSections.createTitle', 'New Section')
        }
        initialName={nameSheet?.kind === 'rename' ? nameSheet.name : ''}
        onSubmit={(name) => {
          if (!nameSheet) return;
          if (nameSheet.kind === 'rename') {
            run({ type: 'renameSection', sectionId: nameSheet.sectionId, name });
            return;
          }
          const sectionId = crypto.randomUUID();
          const moveSessionId = nameSheet.moveSessionId;
          void commands
            .run({ type: 'createSection', sectionId, name }, input)
            .then(() => {
              if (!moveSessionId) return;
              const state: StatusViewState = {
                ...input,
                sections: [
                  ...input.sections,
                  { id: sectionId, name, orderKey: planNewPinSectionOrderKey(input.sections) },
                ],
              };
              return commands.run(
                {
                  type: 'move',
                  sessionId: moveSessionId,
                  to: { area: 'pinned', sectionId },
                  beforeId: null,
                },
                state
              );
            })
            .catch(commands.report);
        }}
      />
    </>
  ) : null;

  /** Whether Later / Settle / Move to Focus may be offered on a rendered row. */
  const canManage = (sessionId: string) =>
    findStatusViewEntry(layout, sessionId)?.row.canManage ?? false;
  /** Whether a rendered row may be pinned, unpinned or placed. */
  const canPrefer = (sessionId: string) =>
    findStatusViewEntry(layout, sessionId)?.row.canPrefer ?? false;

  return {
    layout,
    drag,
    canManage,
    canPrefer,
    openMenu: setMenuFor,
    dropTarget,
    openLater: setLaterFor,
    sectionHeaderMenu,
    overlays,
  };
}
