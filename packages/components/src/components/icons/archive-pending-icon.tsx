import { createLucideIcon } from 'lucide-react';

/** Archive requested, waiting for execution to settle. Keep the clock static. */
export const ArchivePendingIcon = createLucideIcon('ArchivePending', [
  ['rect', { width: '20', height: '5', x: '2', y: '3', rx: '1', key: 'lid' }],
  ['path', { d: 'M4 8v11a2 2 0 0 0 2 2h3M20 8v2', key: 'box' }],
  ['path', { d: 'M10 12h2', key: 'handle' }],
  ['circle', { cx: '17', cy: '17', r: '5', key: 'clock' }],
  ['path', { d: 'M17 14v3l2 1', key: 'hands' }],
]);
