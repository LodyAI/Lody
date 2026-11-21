import * as stylex from '@stylexjs/stylex';
import type { CoordinatorActionSpec } from '@lody/shared';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  Check,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  Play,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import type { ResolvedCoordinatorAction } from './coordinator-action-engine';

const styles = stylex.create({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1.5],
    paddingTop: space[1],
    minWidth: 0,
  },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minHeight: 28,
    maxWidth: '100%',
    paddingBlock: 4,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.medium,
    backgroundColor: { default: colors.background, ':hover': colors.hoverFill },
    color: colors.label,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    cursor: 'pointer',
    transitionProperty: 'background-color, border-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  buttonPrimary: {
    backgroundColor: { default: colors.accent, ':hover': colors.accent },
    borderColor: colors.accent,
    color: colors.onAccent,
    opacity: { default: 1, ':hover': 0.9 },
  },
  buttonDanger: {
    borderColor: colors.separator,
    color: colors.destructive,
    backgroundColor: { default: colors.background, ':hover': colors.hoverFill },
  },
  buttonCompleted: {
    backgroundColor: colors.wellBackground,
    borderColor: 'transparent',
    color: colors.secondaryLabel,
    cursor: 'default',
  },
  buttonDisabled: {
    backgroundColor: colors.wellBackground,
    borderColor: 'transparent',
    color: colors.tertiaryLabel,
    cursor: 'not-allowed',
    opacity: 0.75,
  },
  buttonRunning: {
    backgroundColor: colors.wellBackground,
    borderColor: colors.separator,
    color: colors.secondaryLabel,
    cursor: 'default',
  },
  iconCompleted: {
    flexShrink: 0,
    color: colors.success,
  },
  iconSlot: {
    flexShrink: 0,
  },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  spinner: {
    width: 12,
    height: 12,
    flexShrink: 0,
  },
});

function ActionIcon({ icon }: { icon?: string }) {
  switch (icon) {
    case 'check':
      return <Check size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'git-merge':
      return <GitMerge size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'git-pull-request':
      return <GitPullRequest size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'message-square':
      return <MessageSquare size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'external-link':
      return <ExternalLink size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'play':
      return <Play size={12} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    case 'sparkles':
      return <Sparkles size={13} {...stylex.props(styles.iconSlot)} aria-hidden="true" />;
    default:
      return null;
  }
}

export function CoordinatorBubbleActionBar({
  actions,
  onExecuteAction,
}: {
  actions: readonly ResolvedCoordinatorAction[];
  onExecuteAction?: (action: CoordinatorActionSpec) => Promise<void> | void;
}) {
  const [inFlightId, setInFlightId] = useState<string | null>(null);

  if (actions.length === 0) return null;

  return (
    <div {...stylex.props(styles.row)} data-coordinator-action-bar="">
      {actions.map((resolved) => {
        const { spec, liveState, displayLabel } = resolved;
        const isBusy = inFlightId === spec.id || liveState === 'running';
        const isCompleted = liveState === 'completed';
        const isDisabled = liveState === 'disabled' || !onExecuteAction;
        const interactive = !isBusy && !isCompleted && !isDisabled && inFlightId === null;

        return (
          <button
            key={spec.id}
            type="button"
            disabled={!interactive}
            title={spec.description || displayLabel}
            data-coordinator-action-id={spec.id}
            data-coordinator-action-state={isBusy ? 'running' : liveState}
            onClick={(event) => {
              event.stopPropagation();
              if (!interactive || !onExecuteAction) return;
              setInFlightId(spec.id);
              Promise.resolve(onExecuteAction(spec))
                .catch(() => {})
                .finally(() => {
                  setInFlightId((prev) => (prev === spec.id ? null : prev));
                });
            }}
            {...stylex.props(
              styles.button,
              interactive && spec.tone === 'primary' && styles.buttonPrimary,
              interactive && spec.tone === 'danger' && styles.buttonDanger,
              isCompleted && styles.buttonCompleted,
              isBusy && styles.buttonRunning,
              liveState === 'disabled' && styles.buttonDisabled
            )}
          >
            {isBusy ? (
              <Spinner {...stylex.props(styles.spinner)} />
            ) : isCompleted ? (
              <Check size={13} {...stylex.props(styles.iconCompleted)} aria-hidden="true" />
            ) : (
              <ActionIcon icon={spec.icon} />
            )}
            <span {...stylex.props(styles.label)}>{displayLabel}</span>
          </button>
        );
      })}
    </div>
  );
}
