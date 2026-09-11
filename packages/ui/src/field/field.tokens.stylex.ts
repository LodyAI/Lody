import * as stylex from '@stylexjs/stylex';
import { control, radius, space, text } from '../tokens/scales.stylex';

/** Dimensions shared by the whole field family. Colours remain semantic tokens. */
export const field = stylex.defineVars({
  heightSmall: control.small,
  heightMedium: control.medium,
  heightLarge: control.large,
  paddingXSmall: space[2],
  // 10px sits between space.2 and space.3; the 32px control needs the half step.
  paddingXMedium: '10px',
  paddingXLarge: space[3],
  paddingBlock: space[2],
  radiusSmall: radius.small,
  radiusMedium: radius.medium,
  // One step for the whole 28 / 32 / 36 ladder. 12 belongs to the label and the
  // help text; a control's own content is never sized like the text about it.
  text: text.subheadlineSize,
  labelSize: text.footnoteSize,
  labelLeading: text.footnoteLeading,
  gap: space[1.5],
  ringWidth: '2px',
  textareaMinHeight: '72px',
  // A checkbox and a radio are the rules' "16px things", so they take the mini
  // radius; a radio overrides it with a full round because it is a circle.
  boxSize: '16px',
  boxRadius: radius.mini,
  // The tick and the dot inside that box, and the switch the same height as it
  // so a settings row holding both lines up.
  markSize: '10px',
  dotSize: '6px',
  switchWidth: '28px',
  switchHeight: '16px',
  switchThumbSize: '12px',
  switchInset: '2px',
  // A Select or Combobox trigger holds a glyph beside its value. The rules put
  // a chevron in the hint colour, and the gap keeps the value off it.
  iconSize: '16px',
  triggerGap: space[2],
  // The rules put disabled at 45% opacity on the control. It is one value for
  // the whole family, so the control and its label cannot drift apart.
  disabledOpacity: '0.45',
});
