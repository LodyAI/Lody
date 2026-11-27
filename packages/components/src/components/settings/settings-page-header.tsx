import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  /** Outside the pane, a page's actions keep to the end of their own line. */
  inlineActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[2],
  },
  breadcrumbRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    maxWidth: '100%',
  },
  breadcrumbParent: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    color: {
      default: colors.secondaryLabel,
      ':hover': colors.label,
    },
    cursor: 'pointer',
    flexShrink: 0,
  },
  breadcrumbSep: {
    flexShrink: 0,
    width: '15px',
    height: '15px',
    color: colors.tertiaryLabel,
  },
  breadcrumbCurrent: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  /** Portal target inside the pane title for a nested sub-page breadcrumb. */
  breadcrumb?: HTMLElement | null;
  parentLabel?: string;
  setBreadcrumbActive?: (active: boolean) => void;
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

/**
 * Replaces the desktop settings pane's plain page title with a clickable parent
 * breadcrumb (`Machines › <label>`). Uses a portal so dynamic children never
 * trigger parent state updates.
 */
export function SettingsPageBreadcrumb({
  label,
  onBack,
  leading,
  trailing,
}: {
  label: string;
  onBack: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const slots = useContext(SettingsPaneHeaderContext);
  const setBreadcrumbActive = slots?.setBreadcrumbActive;
  useLayoutEffect(() => {
    if (!setBreadcrumbActive) return undefined;
    setBreadcrumbActive(true);
    return () => setBreadcrumbActive(false);
  }, [setBreadcrumbActive]);

  if (!slots?.breadcrumb) return null;
  return createPortal(
    <span {...stylex.props(styles.breadcrumbRow)}>
      <button
        type="button"
        onClick={onBack}
        {...stylex.props(surface.pageTitle, styles.breadcrumbParent)}
      >
        {slots.parentLabel}
      </button>
      <ChevronRight aria-hidden="true" {...stylex.props(styles.breadcrumbSep)} />
      {leading}
      <span {...stylex.props(surface.pageTitle, styles.breadcrumbCurrent)}>{label}</span>
      {trailing}
    </span>,
    slots.breadcrumb
  );
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
