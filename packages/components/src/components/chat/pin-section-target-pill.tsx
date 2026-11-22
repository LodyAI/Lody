import * as stylex from '@stylexjs/stylex';
import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@lody/ui/checkbox';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { composerSurface } from '@/components/shared/composer-surface';
import { useWorkspaceCatalog } from '@/hooks/use-workspace-catalog';

const styles = stylex.create({
  pill: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    height: '24px',
    gap: space[1.5],
    paddingInline: space[2],
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 400,
    color: {
      default: `color-mix(in oklab, ${colors.label} 80%, transparent)`,
      ':hover': colors.label,
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.label} 6%, transparent)`,
    },
    userSelect: 'none',
    cursor: 'pointer',
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
  },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/**
 * The pin section a conversation started from that section's "New Chat"
 * button lands in. The catalog subscription lives here, not in the landing, so
 * catalog updates re-render only this pill.
 */
export function PinSectionTarget({
  sectionId,
  onClear,
}: {
  sectionId: string;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  const { pinSections, loaded, failed } = useWorkspaceCatalog();
  const section = pinSections.find((candidate) => candidate.id === sectionId);
  // A section deleted meanwhile leaves the conversation in the default section.
  const name = section?.name ?? (loaded || failed ? t('sidebar.pinned', 'Pinned') : null);
  if (name === null) return null;
  return <PinSectionTargetPill sectionId={sectionId} name={name} onClear={onClear} />;
}

/** Unchecking it starts an unpinned conversation instead. */
export function PinSectionTargetPill({
  sectionId,
  name,
  onClear,
}: {
  sectionId: string;
  name: string;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-pin-section-target={sectionId}
      {...stylex.props(composerSurface.contextPill, composerSurface.contextPillFixed)}
    >
      <label {...stylex.props(styles.pill)}>
        <Checkbox
          checked
          onCheckedChange={(checked) => {
            if (!checked) onClear?.();
          }}
          disabled={!onClear}
          aria-label={t('chat.pinSectionTarget', 'Pin to {{name}}', { name })}
        />
        <Pin {...stylex.props(composerSurface.glyph12)} aria-hidden="true" />
        <span {...stylex.props(styles.name)}>{name}</span>
      </label>
    </div>
  );
}
