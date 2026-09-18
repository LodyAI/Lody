import type { LodyResolvedVSCodeTheme } from './vscode-theme-schemas';
import {
  asVSCodeCssVariableName,
  compositeHexColors,
  hexColorToHslChannel,
  hexColorToRgb,
  hexColorToRgba,
  isHexColorFullyTransparent,
  readWorkbenchColor,
} from './vscode-theme-color';

type LodyAliasRule = {
  cssVariable: string;
  colorIds: readonly string[];
  compositeOverColorIds?: readonly string[];
  fallbackColorByThemeType?: Partial<Record<LodyResolvedVSCodeTheme['type'], string>>;
  ensureVisibleAgainst?: {
    colorIds: readonly string[];
    minimumRgbDistance?: number;
    fallbackBlendRatio?: number;
  };
};

const DEFAULT_ALIAS_BASE_COLOR_IDS = [
  'editor.background',
  'panel.background',
  'sideBar.background',
];
const SIDEBAR_ALIAS_BASE_COLOR_IDS = [
  'sideBar.background',
  'panel.background',
  'editor.background',
];
const TAB_ALIAS_BASE_COLOR_IDS = [
  'editorGroupHeader.tabsBackground',
  'editor.background',
  'panel.background',
];
const WIDGET_ALIAS_BASE_COLOR_IDS = [
  'editorWidget.background',
  'quickInput.background',
  'panel.background',
  'sideBar.background',
  'editor.background',
];
const BUTTON_ALIAS_BASE_COLOR_IDS = [
  'button.background',
  'button.secondaryBackground',
  'input.background',
  'editorWidget.background',
  'editor.background',
];
const DEFAULT_MINIMUM_VISIBLE_RGB_DISTANCE = 10;
const TEXT_CODE_BLOCK_DEFAULT_BACKGROUND_BY_THEME_TYPE: Record<
  LodyResolvedVSCodeTheme['type'],
  string
> = {
  light: '#DCDCDC66',
  dark: '#0A0A0A66',
  hcDark: '#000000',
  hcLight: '#F2F2F2',
};
// VS Code exposes textCodeBlock.background, but no textCodeBlock.border.
// Keep Lody's code block border theme-owned by resolving it only from VS Code border tokens.
const CODE_BLOCK_BORDER_COLOR_IDS = [
  'chat.requestCodeBorder',
  'textPreformat.border',
  'input.border',
  'editorHoverWidget.border',
  'editorWidget.border',
  'panel.border',
  'contrastBorder',
] as const;

const LODY_ALIAS_RULES: LodyAliasRule[] = [
  { cssVariable: '--background', colorIds: ['editor.background'] },
  { cssVariable: '--foreground', colorIds: ['foreground', 'editor.foreground'] },
  {
    cssVariable: '--composer',
    colorIds: ['editorWidget.background', 'quickInput.background', 'editor.background'],
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--card',
    colorIds: ['sideBar.background', 'panel.background', 'editor.background'],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--card-foreground',
    colorIds: ['sideBar.foreground', 'sideBarTitle.foreground', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--popover',
    colorIds: [
      'editorWidget.background',
      'quickInput.background',
      'panel.background',
      'sideBar.background',
    ],
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--muted',
    colorIds: [
      'sideBarSectionHeader.background',
      'list.inactiveSelectionBackground',
      'editorWidget.background',
      'sideBar.background',
    ],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--muted-foreground',
    colorIds: [
      'descriptionForeground',
      'sideBarSectionHeader.foreground',
      'sideBarTitle.foreground',
      'list.deemphasizedForeground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--secondary',
    colorIds: [
      'list.inactiveSelectionBackground',
      'list.hoverBackground',
      'sideBarSectionHeader.background',
      'sideBar.background',
    ],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--secondary-foreground',
    colorIds: [
      'list.inactiveSelectionForeground',
      'sideBar.foreground',
      'sideBarTitle.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--destructive',
    colorIds: [
      'editorError.foreground',
      'errorForeground',
      'inputValidation.errorBorder',
      'terminal.ansiRed',
      'terminal.ansiBrightRed',
    ],
  },
  {
    cssVariable: '--destructive-foreground',
    colorIds: ['button.foreground', 'editor.background'],
  },
  {
    cssVariable: '--button-secondary',
    colorIds: [
      'button.secondaryBackground',
      'input.background',
      'editorWidget.background',
      'list.inactiveSelectionBackground',
      'sideBarSectionHeader.background',
      'sideBar.background',
    ],
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--button-secondary-foreground',
    colorIds: [
      'button.secondaryForeground',
      'foreground',
      'editor.foreground',
      'sideBar.foreground',
      'sideBarTitle.foreground',
    ],
  },
  {
    cssVariable: '--button-secondary-hover',
    colorIds: [
      'button.secondaryHoverBackground',
      'list.hoverBackground',
      'button.secondaryBackground',
      'editorWidget.background',
      'input.background',
    ],
    compositeOverColorIds: BUTTON_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--hover',
    // Page-level hover is a wash on the editor canvas. Do not reuse
    // `list.hoverBackground` — that token is sized for the sidebar and reads
    // as a heavy slab on the conversation/archive page.
    colorIds: ['editor.background'],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
    ensureVisibleAgainst: {
      colorIds: ['editor.background'],
      fallbackBlendRatio: 0.04,
    },
  },
  {
    cssVariable: '--hover-foreground',
    colorIds: [
      'list.hoverForeground',
      'menu.selectionForeground',
      'quickInputList.focusForeground',
      'list.focusForeground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--highlight',
    colorIds: [
      'focusBorder',
      'textLink.foreground',
      'progressBar.background',
      'activityBarBadge.background',
      'button.background',
      'terminal.ansiBlue',
    ],
  },
  {
    cssVariable: '--highlight-foreground',
    colorIds: ['button.foreground', 'editor.background', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--selection',
    colorIds: [
      'list.activeSelectionBackground',
      'list.focusAndSelectionBackground',
      'list.focusBackground',
      'editor.selectionBackground',
      'list.inactiveSelectionBackground',
    ],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--selection-foreground',
    colorIds: [
      'list.activeSelectionForeground',
      'list.focusAndSelectionForeground',
      'list.focusForeground',
      'editor.selectionForeground',
      'list.inactiveSelectionForeground',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--selection-inactive',
    colorIds: [
      'list.inactiveSelectionBackground',
      'list.activeSelectionBackground',
      'list.hoverBackground',
    ],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--selection-inactive-foreground',
    colorIds: [
      'list.inactiveSelectionForeground',
      'list.activeSelectionForeground',
      'list.hoverForeground',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--bottom-bar',
    colorIds: ['statusBar.background', 'panel.background', 'sideBar.background'],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--bottom-bar-foreground',
    colorIds: ['statusBar.foreground', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--tab-bar',
    colorIds: [
      'editorGroupHeader.tabsBackground',
      'tab.inactiveBackground',
      'sideBar.background',
      'panel.background',
      'editor.background',
    ],
    compositeOverColorIds: TAB_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--tab-active',
    colorIds: ['tab.activeBackground', 'editor.background', 'editorWidget.background'],
    compositeOverColorIds: TAB_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--tab-active-foreground',
    colorIds: ['tab.activeForeground', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--tab-inactive',
    colorIds: [
      'tab.inactiveBackground',
      'editorGroupHeader.tabsBackground',
      'sideBar.background',
      'panel.background',
      'editor.background',
    ],
    compositeOverColorIds: TAB_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--tab-inactive-foreground',
    colorIds: [
      'tab.inactiveForeground',
      'sideBarTitle.foreground',
      'descriptionForeground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--tab-hover',
    colorIds: [
      'tab.hoverBackground',
      'list.hoverBackground',
      'tab.inactiveBackground',
      'editorWidget.background',
      'editor.background',
    ],
    compositeOverColorIds: TAB_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--tab-hover-foreground',
    colorIds: ['tab.hoverForeground', 'tab.activeForeground', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--tab-border',
    colorIds: [
      'tab.border',
      'editorGroup.border',
      'editorWidget.border',
      'editorHoverWidget.border',
      'sideBarSectionHeader.border',
      'sideBar.border',
      'panel.border',
      'dropdown.border',
      'contrastBorder',
      'editorGroupHeader.tabsBackground',
      'sideBar.background',
      'panel.background',
      'editor.background',
    ],
    compositeOverColorIds: TAB_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--tab-active-accent',
    colorIds: ['tab.activeBorderTop', 'tab.activeBorder', 'focusBorder', 'button.background'],
  },
  { cssVariable: '--primary', colorIds: ['button.background', 'textLink.foreground'] },
  { cssVariable: '--primary-foreground', colorIds: ['button.foreground'] },
  {
    cssVariable: '--button-hover',
    colorIds: ['button.hoverBackground', 'list.hoverBackground'],
    compositeOverColorIds: BUTTON_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--status-info',
    colorIds: ['textLink.foreground', 'button.background', 'terminal.ansiBlue'],
  },
  {
    cssVariable: '--status-success',
    colorIds: [
      'gitDecoration.addedResourceForeground',
      'gitDecoration.untrackedResourceForeground',
      'terminal.ansiGreen',
      'terminal.ansiBrightGreen',
    ],
  },
  {
    cssVariable: '--status-warning',
    colorIds: [
      'editorWarning.foreground',
      'list.warningForeground',
      'terminal.ansiYellow',
      'terminal.ansiBrightYellow',
    ],
  },
  {
    cssVariable: '--status-danger',
    colorIds: [
      'editorError.foreground',
      'errorForeground',
      'terminal.ansiRed',
      'terminal.ansiBrightRed',
    ],
  },
  {
    cssVariable: '--status-merged',
    colorIds: [
      'terminal.ansiMagenta',
      'terminal.ansiBrightMagenta',
      'gitDecoration.modifiedResourceForeground',
    ],
  },
  {
    cssVariable: '--border',
    colorIds: [
      'panel.border',
      'editorWidget.border',
      'editorHoverWidget.border',
      'dropdown.border',
      'sideBarSectionHeader.border',
      'sideBar.border',
      'contrastBorder',
    ],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--input',
    colorIds: [
      'input.background',
      'dropdown.background',
      'quickInput.background',
      'editorWidget.background',
      'panel.background',
      'sideBar.background',
      'editor.background',
    ],
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--switch-track',
    colorIds: ['checkbox.border', 'input.border', 'sideBar.border', 'contrastBorder'],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
    ensureVisibleAgainst: {
      colorIds: ['editor.background', 'sideBar.background', 'panel.background'],
      minimumRgbDistance: 20,
      fallbackBlendRatio: 0.3,
    },
  },
  {
    cssVariable: '--input-foreground',
    colorIds: ['input.foreground', 'dropdown.foreground'],
  },
  {
    cssVariable: '--input-placeholder',
    colorIds: ['input.placeholderForeground', 'descriptionForeground', 'disabledForeground'],
  },
  {
    cssVariable: '--input-border',
    colorIds: [
      'input.border',
      'editorWidget.border',
      'editorHoverWidget.border',
      'dropdown.border',
      'panel.border',
      'contrastBorder',
    ],
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  { cssVariable: '--ring', colorIds: ['focusBorder'] },
  {
    cssVariable: '--sidebar-background',
    colorIds: ['sideBar.background', 'editor.background'],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--sidebar-foreground',
    colorIds: ['sideBar.foreground', 'list.foreground', 'foreground', 'editor.foreground'],
  },
  {
    cssVariable: '--sidebar-foreground-muted',
    colorIds: [
      'sideBarSectionHeader.foreground',
      'sideBarTitle.foreground',
      'descriptionForeground',
      'list.deemphasizedForeground',
      'foreground',
      'editor.foreground',
    ],
  },
  { cssVariable: '--sidebar-primary', colorIds: ['button.background', 'textLink.foreground'] },
  {
    cssVariable: '--sidebar-primary-foreground',
    colorIds: [
      'button.foreground',
      'list.activeSelectionForeground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--sidebar-hover',
    colorIds: [
      'list.hoverBackground',
      'menu.selectionBackground',
      'quickInputList.focusBackground',
      'list.inactiveSelectionBackground',
      'list.focusBackground',
      'editorWidget.background',
      'sideBarSectionHeader.background',
      'sideBar.background',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
    ensureVisibleAgainst: {
      colorIds: ['sideBar.background', 'editor.background'],
      fallbackBlendRatio: 0.08,
    },
  },
  {
    cssVariable: '--sidebar-hover-foreground',
    colorIds: [
      'list.hoverForeground',
      'menu.selectionForeground',
      'quickInputList.focusForeground',
      'list.focusForeground',
      'sideBar.foreground',
      'sideBarTitle.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--sidebar-highlight',
    colorIds: [
      'focusBorder',
      'textLink.foreground',
      'progressBar.background',
      'activityBarBadge.background',
      'button.background',
      'terminal.ansiBlue',
    ],
  },
  {
    cssVariable: '--sidebar-highlight-foreground',
    colorIds: [
      'button.foreground',
      'editor.background',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--sidebar-selection',
    colorIds: [
      'list.activeSelectionBackground',
      'list.focusAndSelectionBackground',
      'list.focusBackground',
      'editor.selectionBackground',
      'list.inactiveSelectionBackground',
      'list.hoverBackground',
      'sideBarSectionHeader.background',
      'sideBar.background',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--sidebar-selection-foreground',
    colorIds: [
      'list.activeSelectionForeground',
      'list.focusAndSelectionForeground',
      'list.focusForeground',
      'editor.selectionForeground',
      'list.inactiveSelectionForeground',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
  },
  {
    cssVariable: '--sidebar-border',
    colorIds: [
      'sideBar.border',
      'panel.border',
      'editorWidget.border',
      'editorHoverWidget.border',
      'dropdown.border',
      'sideBarSectionHeader.border',
      'contrastBorder',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  { cssVariable: '--sidebar-ring', colorIds: ['focusBorder', 'button.background'] },
  {
    cssVariable: '--code-background',
    colorIds: ['textCodeBlock.background'],
    compositeOverColorIds: DEFAULT_ALIAS_BASE_COLOR_IDS,
    fallbackColorByThemeType: TEXT_CODE_BLOCK_DEFAULT_BACKGROUND_BY_THEME_TYPE,
  },
  { cssVariable: '--code-foreground', colorIds: ['editor.foreground', 'foreground'] },
  {
    cssVariable: '--code-border',
    colorIds: CODE_BLOCK_BORDER_COLOR_IDS,
    compositeOverColorIds: WIDGET_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--code-added',
    colorIds: [
      'gitDecoration.addedResourceForeground',
      'gitDecoration.untrackedResourceForeground',
      'editorGutter.addedBackground',
      'diffEditor.insertedTextBackground',
      'terminal.ansiGreen',
    ],
  },
  {
    cssVariable: '--code-removed',
    colorIds: [
      'gitDecoration.deletedResourceForeground',
      'editorGutter.deletedBackground',
      'diffEditor.removedTextBackground',
      'terminal.ansiRed',
    ],
  },
  {
    cssVariable: '--modified-file',
    colorIds: ['gitDecoration.modifiedResourceForeground', 'terminal.ansiYellow'],
  },
  {
    cssVariable: '--scrollbar-thumb',
    colorIds: [
      'scrollbarSlider.background',
      'scrollbarSlider.hoverBackground',
      'scrollbarSlider.activeBackground',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--scrollbar-thumb-hover',
    colorIds: [
      'scrollbarSlider.hoverBackground',
      'scrollbarSlider.activeBackground',
      'scrollbarSlider.background',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
  {
    cssVariable: '--scrollbar-thumb-active',
    colorIds: [
      'scrollbarSlider.activeBackground',
      'scrollbarSlider.hoverBackground',
      'scrollbarSlider.background',
      'sideBar.foreground',
      'foreground',
      'editor.foreground',
    ],
    compositeOverColorIds: SIDEBAR_ALIAS_BASE_COLOR_IDS,
  },
];

const SYNTAX_ALIAS_SCOPES = [
  { cssVariable: '--syntax-comment', scopes: ['comment'] },
  { cssVariable: '--syntax-string', scopes: ['string'] },
  { cssVariable: '--syntax-keyword', scopes: ['keyword', 'storage.type'] },
  { cssVariable: '--syntax-number', scopes: ['constant.numeric', 'constant.language.boolean'] },
  { cssVariable: '--syntax-function', scopes: ['entity.name.function', 'support.function'] },
  { cssVariable: '--syntax-variable', scopes: ['variable', 'identifier'] },
  { cssVariable: '--syntax-title', scopes: ['entity.name.type', 'entity.name.class'] },
  {
    cssVariable: '--syntax-attr',
    scopes: ['entity.other.attribute-name', 'support.type.property-name'],
  },
  {
    cssVariable: '--syntax-builtin',
    scopes: ['support.class', 'support.type', 'variable.language'],
  },
] as const;

export const createVSCodeThemeCssVariables = (
  theme: LodyResolvedVSCodeTheme
): Record<string, string> => {
  const variables: Record<string, string> = {};
  for (const [colorId, color] of Object.entries(theme.colors)) {
    variables[asVSCodeCssVariableName(colorId)] = color;
  }
  return variables;
};

export const createLodyThemeCssVariables = (
  theme: LodyResolvedVSCodeTheme
): Record<string, string> => {
  const variables: Record<string, string> = {};
  const colorByCssVariable: Record<string, string> = {};

  for (const rule of LODY_ALIAS_RULES) {
    const color = resolveWorkbenchAliasColor(theme, rule);
    if (color) {
      colorByCssVariable[rule.cssVariable] = color;
      variables[rule.cssVariable] = hexColorToHslChannel(color);
    }
  }

  const inputFieldColor = resolveInputFieldColor(
    colorByCssVariable['--input'],
    colorByCssVariable['--background']
  );
  if (inputFieldColor) {
    variables['--input-field'] = hexColorToHslChannel(inputFieldColor);
  }

  for (const alias of SYNTAX_ALIAS_SCOPES) {
    const color = findTokenForeground(theme, alias.scopes);
    if (color) {
      variables[alias.cssVariable] = hexColorToHslChannel(color);
    }
  }

  return variables;
};

/**
 * `--input-field` is the fill of an editable form control (Input, Textarea,
 * Select trigger), as opposed to `--input`, which stays the theme's raw
 * `input.background` and is also used as a muted chip/pill fill.
 *
 * A control the user can type into must never sit DARKER than the page it is
 * drawn on: on a light canvas a recessed gray rectangle reads as `disabled`.
 * VS Code themes are free to recess `input.background` (Lody Light does:
 * #DCDEE4 on a #F9F9F9 editor background), so the field fill is the LIGHTER of
 * the field and page colors. Dark themes are unaffected — there
 * `input.background` is already the raised surface (Vesper: #1C1C1C on
 * #101010) — and light themes fall back onto the page color, where the field
 * is delimited by `--input-border` plus the focus ring instead.
 */
const resolveInputFieldColor = (
  inputColor: string | undefined,
  backgroundColor: string | undefined
): string | undefined => {
  if (!inputColor || !backgroundColor) {
    return inputColor ?? backgroundColor;
  }

  return hexColorLightness(inputColor) >= hexColorLightness(backgroundColor)
    ? inputColor
    : backgroundColor;
};

const hexColorLightness = (color: string): number => {
  const { r, g, b } = hexColorToRgb(color);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
};

const resolveWorkbenchAliasColor = (
  theme: LodyResolvedVSCodeTheme,
  rule: LodyAliasRule
): string | undefined => {
  const baseColor = readWorkbenchColor(
    theme,
    rule.compositeOverColorIds ?? DEFAULT_ALIAS_BASE_COLOR_IDS
  );
  const visibleBaseColor = rule.ensureVisibleAgainst
    ? resolveFirstWorkbenchAliasColor(theme, rule.ensureVisibleAgainst.colorIds, baseColor)
    : undefined;
  const minimumRgbDistance =
    rule.ensureVisibleAgainst?.minimumRgbDistance ?? DEFAULT_MINIMUM_VISIBLE_RGB_DISTANCE;

  for (const colorId of rule.colorIds) {
    const color = resolveWorkbenchAliasCandidateColor(theme, colorId, baseColor);
    if (color) {
      if (visibleBaseColor && rgbDistance(color, visibleBaseColor) < minimumRgbDistance) {
        continue;
      }
      return color;
    }
  }

  if (visibleBaseColor && rule.ensureVisibleAgainst?.fallbackBlendRatio) {
    return createVisibleFallbackColor(
      visibleBaseColor,
      theme.type,
      rule.ensureVisibleAgainst.fallbackBlendRatio
    );
  }

  const fallbackColor = rule.fallbackColorByThemeType?.[theme.type];
  if (fallbackColor && !isHexColorFullyTransparent(fallbackColor)) {
    return resolveColorAgainstBase(fallbackColor, baseColor);
  }

  return undefined;
};

const resolveFirstWorkbenchAliasColor = (
  theme: LodyResolvedVSCodeTheme,
  colorIds: readonly string[],
  baseColor: string | undefined
): string | undefined => {
  for (const colorId of colorIds) {
    const color = resolveWorkbenchAliasCandidateColor(theme, colorId, baseColor);
    if (color) {
      return color;
    }
  }

  return undefined;
};

const resolveWorkbenchAliasCandidateColor = (
  theme: LodyResolvedVSCodeTheme,
  colorId: string,
  baseColor: string | undefined
): string | undefined => {
  const color = theme.colors[colorId];
  if (!color || isHexColorFullyTransparent(color)) {
    return undefined;
  }

  return resolveColorAgainstBase(color, baseColor);
};

const resolveColorAgainstBase = (color: string, baseColor: string | undefined): string => {
  if (hexColorToRgba(color).a < 1 && baseColor) {
    return compositeHexColors(color, baseColor);
  }

  return color;
};

const rgbDistance = (first: string, second: string): number => {
  const a = hexColorToRgb(first);
  const b = hexColorToRgb(second);
  return Math.sqrt(Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2));
};

const createVisibleFallbackColor = (
  baseColor: string,
  themeType: LodyResolvedVSCodeTheme['type'],
  blendRatio: number
): string => {
  const targetColor = themeType === 'light' || themeType === 'hcLight' ? '#000000' : '#FFFFFF';
  return mixHexColors(baseColor, targetColor, blendRatio);
};

const mixHexColors = (baseColor: string, targetColor: string, ratio: number): string => {
  const base = hexColorToRgb(baseColor);
  const target = hexColorToRgb(targetColor);
  const mixChannel = (baseChannel: number, targetChannel: number) =>
    Math.round(baseChannel + (targetChannel - baseChannel) * ratio);

  return `#${toHex(mixChannel(base.r, target.r))}${toHex(mixChannel(base.g, target.g))}${toHex(
    mixChannel(base.b, target.b)
  )}`;
};

const toHex = (value: number): string => value.toString(16).padStart(2, '0').toUpperCase();

export const createThemeCssVariables = (
  theme: LodyResolvedVSCodeTheme
): Record<string, string> => ({
  ...createVSCodeThemeCssVariables(theme),
  ...createLodyThemeCssVariables(theme),
});

const findTokenForeground = (
  theme: LodyResolvedVSCodeTheme,
  desiredScopes: readonly string[]
): string | undefined => {
  for (const tokenColor of theme.tokenColors) {
    if (!tokenColor.settings.foreground) {
      continue;
    }
    const scopes = Array.isArray(tokenColor.scope)
      ? tokenColor.scope
      : tokenColor.scope
        ? tokenColor.scope.split(',').map((scope) => scope.trim())
        : [];
    if (scopes.some((scope) => desiredScopes.some((desired) => scope.startsWith(desired)))) {
      return tokenColor.settings.foreground;
    }
  }
  return undefined;
};
