/**
 * Shared presentation for the Prompt Shortcuts prototype: requirement pills,
 * eligibility text, and the chip-decorated template preview.
 *
 * Colour and glyph come from the composer's own chip table
 * (`components/mentions/mention-chips`) so a mention looks like the same thing
 * in Settings, in the composer, and in the transcript.
 */

import * as React from 'react';
import { AlertTriangle, Boxes, Cpu, FolderGit2 } from 'lucide-react';

import {
  MENTION_CHIP_CLASS_NAME,
  MENTION_ICON_CLASS_NAME,
  getComposerMentionChip,
  getMentionKindIcon,
} from '@/components/mentions/mention-chips';
import { cn } from '@/lib/utils';
import type { Mention as MentionRange, MentionChipResolver } from '@/ui/mention/index';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  agentLabel,
  machineLabel,
  projectLabel,
  PROTOTYPE_MENTION_CATALOG,
} from './prompt-shortcut-fixtures';
import {
  isWorkspaceWideScope,
  segmentBlock,
  type PrototypeEligibility,
  type PrototypeScope,
  type PrototypeVariableValues,
} from './prompt-shortcut-model';

const pillClassName =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground';

function Pill({
  icon,
  children,
  tone = 'neutral',
  title,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'neutral' | 'muted' | 'danger';
  title?: string;
}) {
  const body = (
    <span
      className={cn(
        pillClassName,
        tone === 'muted' && 'border-dashed text-muted-foreground/70',
        tone === 'danger' && 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
  if (!title) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The scope the author set, in the fixed Project → Machine → Agent order.
 *
 * Read-only HERE — this renders it — but not read-only as a concept: the editor
 * sets these with three selectors, and all-`null` prints one muted `Workspace`
 * pill rather than nothing, because "applies everywhere" is a decision and
 * blank space is not.
 */
export function ScopePills({ scope, className }: { scope: PrototypeScope; className?: string }) {
  if (isWorkspaceWideScope(scope)) {
    return (
      <div className={cn('flex flex-wrap items-center gap-1', className)}>
        <Pill tone="muted">Workspace</Pill>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {scope.projectId ? (
        <Pill icon={<FolderGit2 className="size-3 shrink-0" aria-hidden="true" />}>
          {projectLabel(scope.projectId)}
        </Pill>
      ) : null}
      {scope.machineId ? (
        <Pill icon={<Cpu className="size-3 shrink-0" aria-hidden="true" />}>
          {machineLabel(scope.machineId)}
        </Pill>
      ) : null}
      {scope.agentId ? (
        <Pill icon={<Boxes className="size-3 shrink-0" aria-hidden="true" />}>
          {agentLabel(scope.agentId)}
        </Pill>
      ) : null}
    </div>
  );
}

export const ELIGIBILITY_TEXT: Record<string, string> = {
  project_mismatch: 'Requires project',
  machine_mismatch: 'Requires machine',
  machine_offline: 'Machine offline',
  provider_mismatch: 'Requires agent',
  dependency_missing: 'Reference no longer exists',
  permission_denied: 'You no longer have access',
  reference_out_of_scope: 'Reference is outside this scope',
};

export function describeEligibility(eligibility: PrototypeEligibility): string {
  if (eligibility.kind === 'available') return 'Available';
  if (eligibility.kind === 'unknown') return 'Checking…';
  const base = ELIGIBILITY_TEXT[eligibility.reason] ?? 'Unavailable';
  return eligibility.detail ? `${base} — ${eligibility.detail}` : base;
}

/** Status, never a requirement: offline/deleted/permission are runtime facts (§2.2). */
export function EligibilityNote({
  eligibility,
  className,
}: {
  eligibility: PrototypeEligibility;
  className?: string;
}) {
  if (eligibility.kind === 'available') {
    return (
      <span className={cn('text-[11px] leading-tight text-muted-foreground/80', className)}>
        Available
      </span>
    );
  }
  if (eligibility.kind === 'unknown') {
    return (
      <span className={cn('text-[11px] leading-tight text-muted-foreground/80', className)}>
        Checking availability…
      </span>
    );
  }
  const danger = eligibility.reason === 'reference_out_of_scope';
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[11px] leading-tight',
        danger ? 'text-destructive' : 'text-status-warning',
        className
      )}
    >
      <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{describeEligibility(eligibility)}</span>
    </span>
  );
}

/** The composer chip's glyph, at the size the surrounding text uses. */
function MentionGlyph({ kind, path }: { kind: string; path: string }) {
  const icon = getMentionKindIcon(kind, { path, className: MENTION_ICON_CLASS_NAME });
  if (!icon) return null;
  return (
    <span aria-hidden="true" className="mr-0.5 inline-flex translate-y-[0.1em] align-baseline">
      {icon}
    </span>
  );
}

/**
 * Read-only render of one block: mention chips in the composer's chip colour,
 * `!{placeholder}` tokens marked as filled or still missing.
 *
 * The production editor decorates a real textarea through the mention
 * primitive; a preview can paint spans because nothing here has a caret.
 */
export function TemplateText({
  text,
  values,
  className,
}: {
  text: string;
  /** When given, filled placeholders show their value instead of the token. */
  values?: PrototypeVariableValues;
  className?: string;
}) {
  const segments = React.useMemo(() => segmentBlock(text, PROTOTYPE_MENTION_CATALOG), [text]);
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {segments.map((segment, index) => {
        if (segment.kind === 'text')
          return <React.Fragment key={index}>{segment.text}</React.Fragment>;
        if (segment.kind === 'mention') {
          return (
            <span key={index} className={MENTION_CHIP_CLASS_NAME}>
              <MentionGlyph kind={segment.target.kind} path={segment.target.label} />
              {segment.token}
            </span>
          );
        }
        const filled = values?.[segment.name];
        if (filled) {
          return (
            <span
              key={index}
              className="rounded-sm bg-primary/10 px-0.5 text-foreground"
              title={`!{${segment.name}}`}
            >
              {filled}
            </span>
          );
        }
        return (
          <span
            key={index}
            className="rounded-sm bg-status-warning/12 px-0.5 text-status-warning"
            title={values ? 'Missing value' : 'Variable'}
          >
            {segment.raw}
          </span>
        );
      })}
    </span>
  );
}

/** `3 variables` / `1 variable` — the list's variable count (§3.1). */
export function variableCountLabel(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? '1 variable' : `${count} variables`;
}

/* ------------------------------------------------------------------ */
/* Editable surfaces                                                   */
/* ------------------------------------------------------------------ */

/**
 * Mention ranges for a live textarea, re-derived from the text on every
 * keystroke rather than committed by a menu.
 *
 * A production Shortcut stores its ranges (§4.1) — re-scanning is a prototype
 * shortcut that buys the one behaviour worth demonstrating: break a token and
 * the chip, the Required-context pill, and the Variables row all disappear
 * together, because they were never separate state.
 *
 * `!{placeholder}` tokens come back as ranges too, under a `placeholder` kind
 * the composer's chip table does not know, so the resolver below paints them.
 */
export function derivePrototypeRanges(text: string): MentionRange[] {
  const ranges: MentionRange[] = [];
  let offset = 0;
  for (const segment of segmentBlock(text, PROTOTYPE_MENTION_CATALOG)) {
    if (segment.kind === 'mention') {
      ranges.push({
        start: offset,
        end: offset + segment.token.length,
        value: segment.token,
        kind: segment.target.kind,
      });
      offset += segment.token.length;
      continue;
    }
    if (segment.kind === 'placeholder') {
      ranges.push({
        start: offset,
        end: offset + segment.raw.length,
        value: segment.name,
        kind: 'placeholder',
      });
      offset += segment.raw.length;
      continue;
    }
    offset += segment.text.length;
  }
  return ranges;
}

/**
 * The composer's chip table, plus one kind it does not have.
 *
 * Colour only, no icon: the chip may not change the advance width of the text
 * it decorates, and `!{name}` has no sigil worth covering.
 */
export const prototypeChipResolver: MentionChipResolver = (mention, text) => {
  if (mention.kind === 'placeholder') {
    return { className: 'text-status-warning', iconSlots: 0 };
  }
  return getComposerMentionChip(mention, text);
};
