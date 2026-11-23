import * as stylex from '@stylexjs/stylex';

/**
 * The app theme's semantic colours, bound to the CSS variables the theme
 * writes.
 *
 * Tailwind's preset maps every colour utility to `hsl(var(--token))`, and the
 * theme writes those variables on the document root — from the bundled Lody
 * Light palette, from the `.dark` block, and at runtime from the active VS Code
 * theme (`lib/vscode-theme/vscode-theme-css.ts`). The aliases resolve those
 * expressions where their group is declared. A surface that pins a subtree
 * palette must also apply `scopedThemeColors` there; inherited aliases otherwise
 * retain the app root's resolved colours. A portal renders outside the subtree
 * that carries the `@lody/ui` palette, so product surfaces read the app's CSS
 * variables through these aliases instead of that separate palette.
 *
 * `@lody/ui`'s own primitives keep reading `colors` — that is the design
 * system's palette, and a primitive is not a product surface.
 *
 * Opacity belongs to the component's original declaration. Preserve the locked
 * compiler's exact HSL or color-mix expression; README.md#alpha owns that mapping.
 * Matching percentages alone do not establish identical browser pixels.
 */
const themeColorDefaults = {
  /* Surfaces */
  background: 'hsl(var(--background))',
  foreground: 'hsl(var(--foreground))',
  card: 'hsl(var(--card))',
  cardForeground: 'hsl(var(--card-foreground))',
  popover: 'hsl(var(--popover))',
  popoverForeground: 'hsl(var(--popover-foreground))',
  composer: 'hsl(var(--composer))',
  secondary: 'hsl(var(--secondary))',
  secondaryForeground: 'hsl(var(--secondary-foreground))',
  muted: 'hsl(var(--muted))',
  mutedForeground: 'hsl(var(--muted-foreground))',
  highlight: 'hsl(var(--highlight))',
  highlightForeground: 'hsl(var(--highlight-foreground))',
  hover: 'hsl(var(--hover))',
  hoverForeground: 'hsl(var(--hover-foreground))',
  selection: 'hsl(var(--selection))',
  selectionForeground: 'hsl(var(--selection-foreground))',
  selectionInactive: 'hsl(var(--selection-inactive))',
  selectionInactiveForeground: 'hsl(var(--selection-inactive-foreground))',

  /* Ink */
  primary: 'hsl(var(--primary))',
  primaryForeground: 'hsl(var(--primary-foreground))',
  primaryContent: 'hsl(var(--primary-content))',
  destructive: 'hsl(var(--destructive))',
  destructiveForeground: 'hsl(var(--destructive-foreground))',
  ring: 'hsl(var(--ring))',
  switchTrack: 'hsl(var(--switch-track))',
  buttonHover: 'hsl(var(--button-hover))',
  bottomBar: 'hsl(var(--bottom-bar))',
  bottomBarForeground: 'hsl(var(--bottom-bar-foreground))',

  /* Long-form reading ink, and the one step above the interface ceiling. */
  reading: 'hsl(var(--reading-foreground))',
  foregroundStrong: 'hsl(var(--foreground-strong))',
  modifiedFile: 'hsl(var(--modified-file))',

  /* Edges */
  border: 'hsl(var(--border))',
  input: 'hsl(var(--input))',
  inputForeground: 'hsl(var(--input-foreground))',
  inputPlaceholder: 'hsl(var(--input-placeholder))',
  inputBorder: 'hsl(var(--input-border))',
  inputField: 'hsl(var(--input-field))',

  /* The sidebar's own plane and inks. */
  sidebar: 'hsl(var(--sidebar-background))',
  sidebarForeground: 'hsl(var(--sidebar-foreground))',
  sidebarForegroundMuted: 'hsl(var(--sidebar-foreground-muted))',
  sidebarRowForeground: 'hsl(var(--sidebar-row-foreground))',
  sidebarPrimary: 'hsl(var(--sidebar-primary))',
  sidebarPrimaryForeground: 'hsl(var(--sidebar-primary-foreground))',
  sidebarHighlight: 'hsl(var(--sidebar-highlight))',
  sidebarHighlightForeground: 'hsl(var(--sidebar-highlight-foreground))',
  sidebarHover: 'hsl(var(--sidebar-hover))',
  sidebarHoverForeground: 'hsl(var(--sidebar-hover-foreground))',
  sidebarSelection: 'hsl(var(--sidebar-selection))',
  sidebarSelectionForeground: 'hsl(var(--sidebar-selection-foreground))',
  sidebarBorder: 'hsl(var(--sidebar-border))',
  sidebarRing: 'hsl(var(--sidebar-ring))',

  /* The tab strip. */
  tabBar: 'hsl(var(--tab-bar))',
  tabActive: 'hsl(var(--tab-active))',
  tabActiveForeground: 'hsl(var(--tab-active-foreground))',
  tabInactive: 'hsl(var(--tab-inactive))',
  tabInactiveForeground: 'hsl(var(--tab-inactive-foreground))',
  tabHover: 'hsl(var(--tab-hover))',
  tabHoverForeground: 'hsl(var(--tab-hover-foreground))',
  tabBorder: 'hsl(var(--tab-border))',
  tabActiveAccent: 'hsl(var(--tab-active-accent))',

  /* Code and diffs. */
  code: 'hsl(var(--code-background))',
  codeForeground: 'hsl(var(--code-foreground))',
  codeBorder: 'hsl(var(--code-border))',
  codeAdded: 'hsl(var(--code-added))',
  codeRemoved: 'hsl(var(--code-removed))',

  /* Status marks. */
  statusInfo: 'hsl(var(--status-info))',
  statusSuccess: 'hsl(var(--status-success))',
  statusWarning: 'hsl(var(--status-warning))',
  statusDanger: 'hsl(var(--status-danger))',
  statusMerged: 'hsl(var(--status-merged))',

  /* GitHub pull-request states. */
  githubOpen: 'hsl(var(--github-open))',
  githubMerged: 'hsl(var(--github-merged))',
  githubClosed: 'hsl(var(--github-closed))',
  githubDraft: 'hsl(var(--github-draft))',
  githubAddition: 'hsl(var(--github-addition))',
  githubDeletion: 'hsl(var(--github-deletion))',

  /* Charts. */
  chart1: 'hsl(var(--chart-1))',
  chart2: 'hsl(var(--chart-2))',
  chart3: 'hsl(var(--chart-3))',
  chart4: 'hsl(var(--chart-4))',
  chart5: 'hsl(var(--chart-5))',
};

export const themeColors = stylex.defineVars(themeColorDefaults);

/** Re-evaluate the semantic aliases where a surface pins its own CSS palette. */
export const scopedThemeColors = stylex.createTheme(themeColors, themeColorDefaults);
