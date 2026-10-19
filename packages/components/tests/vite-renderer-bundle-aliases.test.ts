import { describe, expect, it } from 'vitest';

import { isMermaidRuntimeDependency } from '../vite-renderer-bundle-aliases';

describe('renderer bundle aliases', () => {
  it('isolates the Pele diagram runtime from the startup graph', () => {
    expect(isMermaidRuntimeDependency('/node_modules/pele/dist/pele.js')).toBe(true);
    expect(isMermaidRuntimeDependency('C:\\repo\\node_modules\\pele\\dist\\pele.js')).toBe(true);
    expect(isMermaidRuntimeDependency('/node_modules/peletron/index.js')).toBe(false);
    expect(isMermaidRuntimeDependency('/packages/components/src/components/ai-gui/view.tsx')).toBe(
      false
    );
  });
});
