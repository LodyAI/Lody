import * as stylex from '@stylexjs/stylex';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { inheritedButtonTokens } from '../style/message-action-button.stylex';

export const parentControlTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  ghostHover: 'rgb(35 125 85 / 0.3)',
  gap: '19px',
  ring: 'rgb(225 75 25)',
  ringWidth: '3px',
});
