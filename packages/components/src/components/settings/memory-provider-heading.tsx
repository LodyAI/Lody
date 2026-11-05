import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsSurface as surface } from './surface';

const styles = stylex.create({
  lead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    flexWrap: 'wrap',
  },
  text: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  // The step a block offers when it has nothing to list yet: one full-width
  // control under the description. A column so each child stretches, and the
  // padding keeps the step clear of the sentence that introduced it.
  actions: { display: 'flex', flexDirection: 'column', gap: space[2], paddingBlock: space[1] },
});

/** Shared so the two providers' full-width steps cannot drift apart. */
export const memoryProviderActions = styles.actions;

/**
 * The one shape every memory provider wears, in every state it can be in.
 *
 * Each provider's block used to build this by hand, and the copies drifted:
 * a gap of 4px in one and 6px in the next, a description on two screens and
 * none on the third, so the title moved a few pixels as a user walked from
 * installing to signing in to the list. The page asks someone to compare two
 * products; a title that will not hold still is the thing that breaks it.
 */
export function MemoryProviderHeading({
  logo,
  name,
  providerKey,
  description,
  action,
}: {
  logo?: ReactNode;
  name: string;
  /** Picks the one-line copy saying how this provider divides a memory up. */
  providerKey: string;
  /** Replaces that line while something is wrong and needs saying instead. */
  description?: string;
  /** Sits at the trailing edge. Omitted when the block acts below instead. */
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.lead)}>
      <span {...stylex.props(styles.text)}>
        <span {...stylex.props(styles.titleRow)}>
          {logo}
          <span {...stylex.props(surface.sectionTitle)}>{name}</span>
        </span>
        <span {...stylex.props(surface.sectionDescription)}>
          {description ?? t(`settings.memory.about.${providerKey}`)}
        </span>
      </span>
      {action}
    </div>
  );
}
