import skill from './genui/SKILL.md?raw';
import controls from './genui/references/controls.md?raw';
import expressions from './genui/references/expressions.md?raw';
import layoutText from './genui/references/layout-text.md?raw';
import { bundleSkill } from './catalog';

export const genuiSkill = bundleSkill({
  'SKILL.md': skill,
  'references/controls.md': controls,
  'references/expressions.md': expressions,
  'references/layout-text.md': layoutText,
});
