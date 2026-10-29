import * as stylex from '@stylexjs/stylex';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { inheritedButtonTokens, inheritedColors } from '../style/message-action-button.stylex';

export const parentButtonTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  gap: '23px',
  ring: 'rgb(230 80 10)',
  ringWidth: '3px',
});

export const parentInkTheme = stylex.createTheme(colors, {
  ...inheritedColors,
  label: 'rgb(25 70 195)',
  hoverFill: 'rgb(15 190 80)',
});
