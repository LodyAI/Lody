import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog } from './surface';

const styles = stylex.create({
  /** Outside the pane, a page's actions keep to the end of their own line. */
  inlineActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[2],
  },
});

/**
 * The desktop settings pane draws one header for every page: the page's name,
 * with the page's actions beside it and the page's one-sentence lead under it.
 * A page does not draw its own title there. It hands its actions and its lead
 * to the header through these slots, so every page starts at the same place
 * and a page with an "Add" button is laid out like one without.
 *
 * Outside the pane (the mobile settings routes) there are no slots, and a page
 * keeps whatever header it draws for itself.
 */
interface SettingsPaneHeaderSlots {
  actions: HTMLElement | null;
  lead: HTMLElement | null;
  /** The page pane itself, beside the nav. */
  pane: HTMLElement | null;
}

const SettingsPaneHeaderContext = createContext<SettingsPaneHeaderSlots | null>(null);

export const SettingsPaneHeaderProvider = SettingsPaneHeaderContext.Provider;

/** Whether this page is drawn inside the desktop settings pane, under its header. */
export function useInSettingsPane(): boolean {
  return useContext(SettingsPaneHeaderContext) !== null;
}

/**
 * The page pane, for a settings editor dialog to centre on (`Dialog.Content`'s
 * `centerOn`): opened from a page, it belongs over that page rather than over
 * the seam between the nav and the page. Outside the pane — the mobile
 * settings routes, the composer's Role picker — there is none, and the dialog
 * is centred on the window.
 */
export function useSettingsPane(): HTMLElement | null {
  return useContext(SettingsPaneHeaderContext)?.pane ?? null;
}

/** A page's actions, beside its name in the pane header. */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const slots = useContext(SettingsPaneHeaderContext);
  if (!slots) return <div {...stylex.props(styles.inlineActions)}>{children}</div>;
  return slots.actions ? createPortal(children, slots.actions) : null;
}

/**
 * A page's one-sentence lead, under its name in the pane header; the header
 * sets its type. Outside the pane it is the page's first line.
 */
export function SettingsPageLead({ children }: { children: ReactNode }) {
  const slots = useContext(SettingsPaneHeaderContext);
  if (!slots) return <p {...stylex.props(catalog.intro)}>{children}</p>;
  return slots.lead ? createPortal(children, slots.lead) : null;
}
