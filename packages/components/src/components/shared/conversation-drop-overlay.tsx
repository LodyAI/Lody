import { AtSign, Paperclip } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';

const styles = stylex.create({
  root: {
    pointerEvents: 'none',
    position: 'absolute',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[4],
  },
  backdrop: {
    position: 'absolute',
    inset: space[3],
    borderWidth: '2px',
    borderStyle: 'dashed',
    // The app may force a theme independently of the OS preference.
    borderColor: {
      default: `color-mix(in oklab, ${colors.accent} 55%, transparent)`,
      ':is(.dark *)': `color-mix(in oklab, ${colors.accent} 45%, transparent)`,
    },
    borderRadius: '16px',
    backgroundColor: {
      default: `color-mix(in oklab, ${colors.accent} 12%, transparent)`,
      ':is(.dark *)': `color-mix(in oklab, ${colors.accent} 16%, transparent)`,
    },
    backdropFilter: 'blur(2px)',
  },
  label: {
    position: 'relative',
    display: 'flex',
    maxWidth: 'min(100%, 20rem)',
    alignItems: 'center',
    gap: space[2],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: `color-mix(in oklab, ${colors.accent} 25%, transparent)`,
    borderRadius: radius.full,
    backgroundColor: `color-mix(in oklab, ${colors.background} 90%, transparent)`,
    paddingInline: space[4],
    paddingBlock: space[2],
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  icon: { width: '16px', height: '16px', flexShrink: 0, color: colors.accent },
  text: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/**
 * Full-surface drop mask for a conversation page or the chat landing.
 *
 * The zone itself lives on the parent (`useDropZone`). Session-mention drags
 * also arm this from sidebar `dragstart` so the mask is up before the pointer
 * reaches the page. `pointer-events-none` is required: a hit-testing overlay
 * would fire `dragleave` on every nested child and flicker the highlight the
 * depth counter exists to prevent.
 */
export type ConversationDropKind = 'session-mention' | 'files';

export function ConversationDropOverlay({
  active,
  kind = 'session-mention',
}: {
  active: boolean;
  kind?: ConversationDropKind;
}) {
  if (!active) return null;
  return <ConversationDropOverlayPaint kind={kind} />;
}

function ConversationDropOverlayPaint({ kind }: { kind: ConversationDropKind }) {
  const { t } = useTranslation();
  const isMention = kind === 'session-mention';
  const label = isMention ? t('sessions.drop.mention') : t('sessions.drop.files');
  const Icon = isMention ? AtSign : Paperclip;

  return (
    <div
      data-testid="conversation-drop-overlay"
      data-drop-kind={kind}
      role="status"
      aria-live="polite"
      {...stylex.props(styles.root)}
    >
      <div {...stylex.props(styles.backdrop)} />
      <div {...stylex.props(styles.label)}>
        <Icon {...stylex.props(styles.icon)} aria-hidden />
        <span {...stylex.props(styles.text)}>{label}</span>
      </div>
    </div>
  );
}
