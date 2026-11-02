/** Retained aliases are scanned by the existing src Tailwind source glob. */
export const legacyDeclarations = [
  { key: 'dimmed', alias: 'opacity-70', js: 'opacity', css: 'opacity' },
  { key: 'container', alias: '@container', js: 'containerType', css: 'container-type' },
  { key: 'row', alias: 'flex', js: 'display', css: 'display' },
  { key: 'fullWidth', alias: 'w-full', js: 'width', css: 'width' },
  { key: 'centered', alias: 'items-center', js: 'alignItems', css: 'align-items' },
  { key: 'minimum', alias: 'min-w-0', js: 'minWidth', css: 'min-width' },
  { key: 'remainder', alias: 'flex-1', js: 'flex', css: 'flex' },
  { key: 'clipped', alias: 'overflow-hidden', js: 'overflow', css: 'overflow' },
] as const;

export const legacyBindings = {
  pickerSpinnerClass: ['dimmed'],
  tabViewportClass: ['minimum', 'remainder', 'clipped'],
  tabContainerClass: ['container'],
  tabStripClass: ['row', 'fullWidth', 'centered'],
  tabItemClass: ['minimum', 'clipped'],
} as const;
