import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy, UserRoundCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UserAvatar } from '@/components/user-avatar';
import { cn } from '@/lib/utils';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';

/**
 * Bottom sheet that replaces the mobile session header "…" dropdown. A dropdown
 * with a nested Copy submenu overflowed narrow screens, so this presents the
 * same options as a flat sheet: a read-only info block (machine, base/current
 * branch, project path — tap to copy) on top, then the flat action list
 * (find / fork / rename / copy / archive / restore / delete).
 *
 * Pure component — the caller (`session-detail.tsx`) resolves the rows/actions.
 */
export type MobileSessionMenuInfoRow = {
  id: string;
  icon: ReactNode;
  label: string;
  value: string;
  /** Allow long values such as file paths to wrap instead of being truncated. */
  wrapValue?: boolean;
  /** Tap-to-copy; renders a copy affordance when provided. */
  onCopy?: () => void;
  /** Trailing node (e.g. an online dot for the machine row). */
  trailing?: ReactNode;
};

export type MobileSessionMenuAction = {
  id: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draw a divider above this action (groups copy vs archive, etc.). */
  separatorBefore?: boolean;
};

/**
 * Owner transfer. The sheet is deliberately flat, so this renders as a single
 * disclosure row (current owner + chevron) that expands the member list in
 * place — a workspace with many members must not push the actions off screen.
 * Only passed on multi-member workspaces.
 */
export type MobileSessionMenuOwner = {
  members: { userId: string; name: string; image?: string | null }[];
  /** Current `SessionMeta.userId`; may name someone who already left. */
  ownerUserId: string;
  onSelect: (userId: string) => void;
};

export type MobileSessionMenuSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  infoRows: MobileSessionMenuInfoRow[];
  actions: MobileSessionMenuAction[];
  owner?: MobileSessionMenuOwner;
};

export function MobileSessionMenuSheet({
  open,
  onOpenChange,
  title,
  infoRows,
  actions,
  owner,
}: MobileSessionMenuSheetProps) {
  const { t } = useTranslation();
  const heading = title ?? t('sessions.moreActions', 'More actions');
  const [ownerListOpen, setOwnerListOpen] = useState(false);
  // Reopening the sheet should start from the collapsed row again.
  useEffect(() => {
    if (!open) setOwnerListOpen(false);
  }, [open]);
  const ownerName =
    owner?.members.find((member) => member.userId === owner.ownerUserId)?.name ?? null;

  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent className="h-auto! max-h-[85dvh]! rounded-t-2xl border-border/60">
        <DrawerTitle className="sr-only">{heading}</DrawerTitle>
        <DrawerDescription className="sr-only">{heading}</DrawerDescription>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(16px+var(--safe-area-bottom,0px))] pt-3">
          {infoRows.length > 0 ? (
            /* Stacked label-over-value rows so every line starts at the same x
               regardless of label length; hairline dividers between rows. */
            <div className="mb-2 flex flex-col divide-y divide-border/40 rounded-xl bg-card ring-1 ring-border/60">
              {infoRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={row.onCopy ? () => run(row.onCopy!) : undefined}
                  disabled={!row.onCopy}
                  className={cn(
                    'flex w-full select-none items-center gap-3 px-3.5 py-2.5 text-left',
                    'first:rounded-t-xl last:rounded-b-xl',
                    row.onCopy ? 'transition-colors hover:bg-muted/60' : 'cursor-default'
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                    {row.icon}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[0.68rem] font-medium tracking-wide text-muted-foreground/70">
                      {row.label}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={cn(
                          'min-w-0 text-sm leading-tight text-foreground',
                          row.wrapValue ? 'break-all' : 'truncate'
                        )}
                      >
                        {row.value}
                      </span>
                      {row.trailing}
                    </span>
                  </span>
                  {row.onCopy ? (
                    <Copy
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {owner ? (
            <div className="mb-2 flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border/60">
              <button
                type="button"
                onClick={() => setOwnerListOpen((value) => !value)}
                aria-expanded={ownerListOpen}
                className="flex w-full select-none items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  <UserRoundCog className="h-3.5 w-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.68rem] font-medium tracking-wide text-muted-foreground/70">
                    {t('sessions.owner.label', 'Owner')}
                  </span>
                  <span className="min-w-0 truncate text-sm leading-tight text-foreground">
                    {ownerName ?? t('sessions.owner.unknown', 'Unknown')}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
                    ownerListOpen && 'rotate-180'
                  )}
                  aria-hidden="true"
                />
              </button>
              {ownerListOpen ? (
                <div className="flex max-h-64 flex-col overflow-y-auto border-t border-border/40">
                  {owner.members.map((member) => {
                    const isOwner = member.userId === owner.ownerUserId;
                    return (
                      <button
                        key={member.userId}
                        type="button"
                        onClick={() => {
                          if (!isOwner) run(() => owner.onSelect(member.userId));
                          else onOpenChange(false);
                        }}
                        className="flex w-full select-none items-center gap-2.5 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-muted/60"
                      >
                        <UserAvatar
                          user={{ id: member.userId, name: member.name, image: member.image }}
                          size="small"
                          className="shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {member.name}
                        </span>
                        {isOwner ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-col gap-0.5">
            {actions.map((action) => (
              <div key={action.id}>
                {action.separatorBefore ? <div className="my-1 h-px bg-border/60" /> : null}
                <button
                  type="button"
                  onClick={() => run(action.onClick)}
                  disabled={action.disabled}
                  className={cn(
                    'flex w-full select-none items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm',
                    'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    action.destructive
                      ? 'text-destructive hover:bg-destructive/10'
                      : 'text-foreground hover:bg-muted/60'
                  )}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {action.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
