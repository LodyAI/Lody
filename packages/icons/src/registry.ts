/**
 * The drawing of every icon in the set, on one grid.
 *
 * Every icon is drawn on a 24 × 24 canvas with a 20 × 20 live area, a 1.5
 * stroke with round caps and joins, 2px corners on containers and 2px nodes for
 * the git family; strokes sit on .5 coordinates so 1.5px is crisp at 1×. A family
 * shares one skeleton — the chat family one bubble, the file family one folded
 * sheet, the git family the same two node columns — so its members line up in a
 * list. The set is original; it follows Nucleo's drawing conventions, not its
 * paths.
 *
 * `marks` is the outline. `layers`, where an icon has them, is what the filled
 * variants are built from: `mass` is the back layer, `front` the layer in front
 * of it, `mid` an optional one between, `detail` the marks inside the mass,
 * `outer` the strokes outside it (an antenna, a pin, a bell's nub) that no
 * variant may cut, and `dots` the eyes. An icon without layers is outline in
 * every variant.
 */

export interface IconLayers {
  /** The back layer: the container, the body, the sheet. A closed path. */
  mass: string;
  /** An optional layer between the mass and the front, at 55% in bulk. */
  mid?: string;
  /** The layer in front of the mass: a folder's front panel, a cube's top face. */
  front?: string;
  /** Whether `front` is also drawn as a stroke in the outline variants. */
  strokeFront?: boolean;
  /** Marks inside the mass: a terminal's prompt, a warning's exclamation. */
  detail?: string;
  /** What replaces `detail` in bulk, where the fills already carry the depth. */
  bulkDetail?: string;
  /** Strokes outside the mass, drawn in every variant and never cut. */
  outer?: string;
  /** Eyes: a dot stroke at weight 2.5. */
  dots?: string;
}

export type IconMark =
  | { path: string; weight?: number }
  | { circle: readonly [cx: number, cy: number, r: number] }
  | { rect: readonly [x: number, y: number, width: number, height: number, rx: number] };

export interface IconDefinition {
  /** The outline, drawn at 1.5 unless a mark states its own weight. */
  marks: readonly IconMark[];
  layers?: IconLayers;
}

export const ICON_FAMILIES = {
  navigation: [
    'chevron-up',
    'chevron-down',
    'chevron-left',
    'chevron-right',
    'arrow-left',
    'arrow-right',
    'arrow-up',
    'arrow-down',
    'send',
    'external-link',
    'maximize',
    'sidebar',
    'sidebar-collapsed',
    'search',
  ],
  actions: [
    'plus',
    'minus',
    'check',
    'close',
    'more',
    'play',
    'pause',
    'stop',
    'refresh',
    'undo',
    'edit',
    'trash',
    'copy',
    'download',
    'upload',
    'save',
    'filter',
    'pin',
    'pin-off',
    'attach',
    'link',
    'quote',
  ],
  files: [
    'file',
    'file-text',
    'file-code',
    'folder',
    'folder-open',
    'folder-plus',
    'worktree',
    'archive',
    'inbox',
    'layers',
    'image',
  ],
  git: [
    'branch',
    'fork',
    'commit',
    'merge',
    'pull-request',
    'diff',
    'issue',
    'code',
    'tag',
    'review',
    'checklist',
  ],
  status: [
    'check-circle',
    'x-circle',
    'alert-circle',
    'warning',
    'info-circle',
    'help-circle',
    'circle',
    'clock',
    'history',
    'star',
    'shield-check',
    'shield-alert',
    'lock',
    'eye',
    'eye-off',
  ],
  product: [
    'session',
    'sparkle',
    'agent',
    'model',
    'cpu',
    'terminal',
    'monitor',
    'zap',
    'globe',
    'user',
    'users',
    'mail',
    'bell',
    'settings',
    'wrench',
    'sun',
    'moon',
  ],
} as const;

export type IconFamily = keyof typeof ICON_FAMILIES;
export type IconName = (typeof ICON_FAMILIES)[IconFamily][number];

/**
 * The arrow the composer sends with. `send` and `arrow-up` are one drawing and
 * two meanings — a caller states what it means, not what it looks like — so the
 * path is stated once rather than maintained twice.
 */
const ARROW_UP = 'M12 19.5v-15M5.5 11 12 4.5 18.5 11';

/** The pin, and the pin with a line through it: one body, stated once. */
const PIN = 'M9 4.5h6V7l-1 1v3.5l2.5 2.5V15h-9v-1l2.5-2.5V8l-1-1zM12 15v5.5';

export const ICONS: Record<IconName, IconDefinition> = {
  'chevron-up': {
    marks: [{ path: 'M7 14l5-5 5 5' }],
  },
  'chevron-down': {
    marks: [{ path: 'M7 10l5 5 5-5' }],
  },
  'chevron-left': {
    marks: [{ path: 'M14 7l-5 5 5 5' }],
  },
  'chevron-right': {
    marks: [{ path: 'M10 7l5 5-5 5' }],
  },
  'arrow-left': {
    marks: [{ path: 'M19.5 12h-15M11 5.5 4.5 12 11 18.5' }],
  },
  'arrow-right': {
    marks: [{ path: 'M4.5 12h15M13 5.5 19.5 12 13 18.5' }],
  },
  'arrow-down': {
    marks: [{ path: 'M12 4.5v15M5.5 13l6.5 6.5 6.5-6.5' }],
  },
  send: {
    marks: [{ path: ARROW_UP }],
  },
  'arrow-up': {
    marks: [{ path: ARROW_UP }],
  },
  'external-link': {
    marks: [
      {
        path: 'M10 5.5H6.5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V14M14 4.5h5.5V10M19.5 4.5L11 13',
      },
    ],
  },
  maximize: {
    marks: [
      {
        path: 'M9 4.5H6.5a2 2 0 0 0-2 2V9M15 4.5h2.5a2 2 0 0 1 2 2V9M9 19.5H6.5a2 2 0 0 1-2-2V15M15 19.5h2.5a2 2 0 0 0 2-2V15',
      },
    ],
  },
  sidebar: {
    marks: [
      { path: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { path: 'M10 4.5v15M5.5 8h2.5M5.5 10.5h2.5M5.5 13h2.5' },
    ],
  },
  'sidebar-collapsed': {
    // The rail is 3.5 units of air between two strokes, so it holds one mark of
    // 2 with 0.75 either side, and two of them down its length. A narrower rail
    // — the 3 units this was first drawn at — leaves 1.5, and a 2-wide mark in
    // it merges into the frame on one side and the divider on the other.
    marks: [
      { path: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { path: 'M8.5 4.5v15' },
      { path: 'M6 9.5h.01M6 14.5h.01', weight: 2 },
    ],
  },
  search: {
    marks: [{ circle: [11, 11, 7] }, { path: 'M16 16l4.5 4.5' }],
  },
  plus: {
    marks: [{ path: 'M12 5.5v13M5.5 12h13' }],
  },
  minus: {
    marks: [{ path: 'M5.5 12h13' }],
  },
  check: {
    marks: [{ path: 'M5 12.5l4.5 4.5 9.5-10' }],
  },
  close: {
    marks: [{ path: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }],
  },
  more: {
    marks: [{ path: 'M6 12h.01M12 12h.01M18 12h.01', weight: 2.5 }],
  },
  play: {
    marks: [
      { path: 'M8 6.4c0-.8.9-1.3 1.6-.9l8.9 5.6c.7.4.7 1.4 0 1.8l-8.9 5.6c-.7.4-1.6-.1-1.6-.9z' },
    ],
    layers: {
      mass: 'M8 6.4c0-.8.9-1.3 1.6-.9l8.9 5.6c.7.4.7 1.4 0 1.8l-8.9 5.6c-.7.4-1.6-.1-1.6-.9z',
    },
  },
  pause: {
    marks: [{ rect: [7, 5.5, 3.5, 13, 1] }, { rect: [13.5, 5.5, 3.5, 13, 1] }],
  },
  stop: {
    marks: [{ rect: [5.5, 5.5, 13, 13, 2.5] }],
  },
  refresh: {
    marks: [
      {
        path: 'M19.5 12a7.5 7.5 0 0 1-13 5.1L4.5 15M4.5 12a7.5 7.5 0 0 1 13-5.1L19.5 9M19.5 4.5V9H15M4.5 19.5V15H9',
      },
    ],
  },
  edit: {
    marks: [{ path: 'M5 15.5l9.5-9.5 4 4L9 19.5H5zM12.5 8l4 4' }],
  },
  trash: {
    marks: [
      {
        path: 'M4.5 6.5h15M9.5 6.5V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 6.5l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1M10 10.5v6M14 10.5v6',
      },
    ],
  },
  copy: {
    marks: [
      { rect: [8.5, 8.5, 12, 12, 2] },
      { path: 'M15.5 5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2' },
    ],
    layers: {
      mass: 'M5.5 3.5h8a2 2 0 0 1 2 2v3h-5a2 2 0 0 0-2 2v5h-3a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      front: 'M10.5 8.5h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      strokeFront: true,
      detail: 'M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3',
      bulkDetail: '',
    },
  },
  download: {
    marks: [
      { path: 'M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M4.5 16.5v1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1' },
    ],
  },
  upload: {
    marks: [
      { path: 'M12 15.5v-11M7.5 9 12 4.5 16.5 9M4.5 16.5v1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1' },
    ],
  },
  filter: {
    marks: [{ path: 'M4.5 5.5h15l-5.5 6.5v5.5l-4 2v-7.5z' }],
  },
  pin: {
    marks: [{ path: PIN }],
  },
  attach: {
    marks: [
      {
        path: 'M15.5 8l-6.5 6.5a1.75 1.75 0 0 0 2.5 2.5l7-7a3.5 3.5 0 0 0-5-5l-7 7a5.25 5.25 0 0 0 7.4 7.4L20 13.3',
      },
    ],
  },
  link: {
    marks: [
      {
        path: 'M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1',
      },
    ],
  },
  undo: {
    // The turn `history` makes, gone the other way and ending in a head rather
    // than a hand: back to where this was, not back through where it has been.
    marks: [{ path: 'M8.5 5.5 4.5 9.5l4 4M4.5 9.5h9.5a5.5 5.5 0 0 1 0 11H9' }],
  },
  save: {
    // The file family's folded sheet is a document; this is the disk it is
    // written to, so it takes the same 2px container with the corner cut off
    // the other way — the shutter at the top, the label at the foot. 15 by 15:
    // a disk is square, and drawn 17 by 15 it reads as a letterbox.
    marks: [
      { path: 'M6.5 4.5h9l4 4v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { path: 'M9 4.5v4h6v-4M8 19.5v-4.5h8v4.5' },
    ],
    layers: {
      mass: 'M6.5 4.5h9l4 4v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
      front: 'M8 15h8v4.5h-8z',
      detail: 'M9 4.5v4h6v-4M8 19.5v-4.5h8v4.5',
      bulkDetail: 'M9 4.5v4h6v-4',
    },
  },
  quote: {
    // A quote mark is a ball with a tail, so it is drawn as one: two of them,
    // on the set's own stroke. The first draft notched the tail out of a block
    // and read as a pair of counters by 20px; the second swept the tail so far
    // round the ball that it read as a lowercase e.
    marks: [
      {
        path: 'M7.25 13.5a2.75 2.75 0 1 1 2.75-2.75c0 2.3-1 4-3 5.25M16.75 13.5a2.75 2.75 0 1 1 2.75-2.75c0 2.3-1 4-3 5.25',
      },
    ],
  },
  'pin-off': {
    // `eye-off` breaks its drawing because a line across an eye lands on the
    // pupil and reads as part of it. A pin has no such centre, and broken into
    // fragments it stops being a pin at all — so this one stays whole and takes
    // the line across it.
    marks: [{ path: PIN }, { path: 'M4.5 4.5l15 15' }],
  },
  file: {
    marks: [
      { path: 'M7 3.5h6.5l5 5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z' },
      { path: 'M13.5 3.5v5h5' },
    ],
  },
  'file-text': {
    marks: [
      { path: 'M7 3.5h6.5l5 5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z' },
      { path: 'M13.5 3.5v5h5M9 12.5h6M9 16h4' },
    ],
  },
  'file-code': {
    marks: [
      { path: 'M7 3.5h6.5l5 5V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z' },
      { path: 'M13.5 3.5v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2' },
    ],
  },
  folder: {
    marks: [
      { path: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' },
      { path: 'M3.5 10.5h17' },
    ],
    layers: {
      mass: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
      front: 'M3.5 10.5h17v6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
      detail: 'M3.5 10.5h17',
      bulkDetail: '',
    },
  },
  'folder-open': {
    marks: [
      { path: 'M3.5 17.5v-10a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1.6' },
      {
        path: 'M3.5 17.5l2.6-6a1.5 1.5 0 0 1 1.4-.9h12.6a1 1 0 0 1 .9 1.4l-2.4 5.6a1.5 1.5 0 0 1-1.4.9H5.5a2 2 0 0 1-2-2z',
      },
    ],
  },
  worktree: {
    marks: [
      { path: 'M12.5 18.5h-7a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v3' },
      { circle: [18.5, 18, 2] },
      { path: 'M18.5 16v-2.5' },
    ],
  },
  archive: {
    marks: [
      { rect: [3.5, 4.5, 17, 4, 1] },
      { path: 'M5 8.5v9.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4' },
    ],
  },
  inbox: {
    marks: [
      {
        path: 'M4.5 13h4l1.5 2.5h4L15.5 13h4M4.5 13v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13M4.5 13l2.3-6.4a1.5 1.5 0 0 1 1.4-1h7.6a1.5 1.5 0 0 1 1.4 1L19.5 13',
      },
    ],
  },
  layers: {
    marks: [
      { path: 'M12 4.5l8.5 4-8.5 4-8.5-4z' },
      { path: 'M3.5 12.5l8.5 4 8.5-4M3.5 16.5l8.5 4 8.5-4' },
    ],
  },
  'folder-plus': {
    // The folder's skeleton with a cross in it, and no front-panel line: the
    // line splits the face the cross has to sit in, and two marks in a folder
    // that small is one too many. The cross centres on the face, not the box.
    //
    // No layer model, like `folder-open`. `folder` fills its front panel at
    // 100% over a 35% body, and a cross drawn on top of that panel is
    // currentColor on currentColor — it disappears, and what is left is
    // `folder`. A variant is a treatment of one drawing; where the treatment
    // costs the drawing its meaning, the icon does not have one.
    marks: [
      { path: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' },
      { path: 'M12 10v6M9 13h6' },
    ],
  },
  image: {
    // The 17x15 container `sidebar`, `terminal` and `monitor` share, holding a
    // horizon instead of a screen: one sun and two ridges, the near one cutting
    // in front of the far one so the depth survives the fill.
    marks: [
      { path: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { circle: [8.5, 9, 1.5] },
      { path: 'M3.5 16.5l4-4 4.5 4.5M11 15l3-3 6.5 6.5' },
    ],
    layers: {
      mass: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
      detail: 'M7 9a1.5 1.5 0 1 1 3 0 1.5 1.5 0 1 1-3 0M3.5 16.5l4-4 4.5 4.5M11 15l3-3 6.5 6.5',
    },
  },
  branch: {
    marks: [
      { circle: [7, 5, 2] },
      { circle: [7, 19, 2] },
      { circle: [17, 7, 2] },
      { path: 'M7 7v10M17 9c0 3.5-10 2.5-10 8' },
    ],
  },
  commit: {
    marks: [{ circle: [12, 12, 3.5] }, { path: 'M3.5 12h5M15.5 12h5' }],
  },
  merge: {
    marks: [
      { circle: [7, 5, 2] },
      { circle: [7, 19, 2] },
      { circle: [17, 12, 2] },
      { path: 'M7 7v10M15 12h-2.5A5.5 5.5 0 0 1 7 6.5V7' },
    ],
  },
  'pull-request': {
    marks: [
      { circle: [7, 5, 2] },
      { circle: [7, 19, 2] },
      { circle: [17, 19, 2] },
      { path: 'M7 7v10M17 17v-7a2.5 2.5 0 0 0-2.5-2.5H11M13.5 5L11 7.5 13.5 10' },
    ],
  },
  diff: {
    marks: [
      { path: 'M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { path: 'M12 4.5v15M8.5 10.5v3M7 12h3M14 12h3' },
    ],
  },
  issue: {
    marks: [{ circle: [12, 12, 8.5] }, { circle: [12, 12, 1.5] }],
  },
  code: {
    // The chevrons reach the live area and the slash leans across it: drawn
    // with 4.5 of travel each and a slash 4 wide, the mass bunched in the
    // middle and the icon read narrow next to everything else on its row.
    marks: [{ path: 'M8.5 7.5 3 12l5.5 4.5M15.5 7.5 21 12l-5.5 4.5M14.5 5l-5 14' }],
  },
  tag: {
    marks: [
      {
        path: 'M4.5 5.5v6.2c0 .5.2 1 .6 1.4l7.3 7.3a1.5 1.5 0 0 0 2.1 0l5.4-5.4a1.5 1.5 0 0 0 0-2.1l-7.3-7.3a2 2 0 0 0-1.4-.6H5.5a1 1 0 0 0-1 1z',
      },
      { path: 'M8.5 8.5h.01', weight: 2 },
    ],
  },
  review: {
    marks: [
      {
        path: 'M6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-3.5 3v-3a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      },
      { path: 'M9 11l2 2 4-4.5' },
    ],
  },
  checklist: {
    marks: [
      {
        path: 'M4.5 6.5L6 8l3-3M4.5 12.5L6 14l3-3M4.5 18.5L6 20l3-3M12 6.5h7.5M12 12h7.5M12 17.5h7.5',
      },
    ],
  },
  fork: {
    // The git family's two node columns, opened: one line down from each head
    // into a shoulder, and a single trunk from the shoulder to the foot. The
    // heads sit on 7 and 17 like `branch`, `merge` and `pull-request`, so the
    // family still lines up when it is read down a list.
    marks: [
      { circle: [7, 5, 2] },
      { circle: [17, 5, 2] },
      { circle: [12, 19, 2] },
      { path: 'M17 7v1.5a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V7M12 10.5v6.5' },
    ],
  },
  'check-circle': {
    marks: [{ circle: [12, 12, 8.5] }, { path: 'M8.5 12.2l2.4 2.4 4.8-5' }],
  },
  'x-circle': {
    marks: [{ circle: [12, 12, 8.5] }, { path: 'M9.5 9.5l5 5M14.5 9.5l-5 5' }],
  },
  warning: {
    marks: [
      { path: 'M10.7 5.3c.6-1 2-1 2.6 0l7.4 12.7c.6 1-.1 2.3-1.3 2.3H4.6c-1.2 0-1.9-1.3-1.3-2.3z' },
      { path: 'M12 9.5v4M12 16.5h.01' },
    ],
    layers: {
      mass: 'M10.7 5.3c.6-1 2-1 2.6 0l7.4 12.7c.6 1-.1 2.3-1.3 2.3H4.6c-1.2 0-1.9-1.3-1.3-2.3z',
      detail: 'M12 9.5v4M12 16.5h.01',
    },
  },
  'info-circle': {
    marks: [{ circle: [12, 12, 8.5] }, { path: 'M12 11v5' }, { path: 'M12 8h.01', weight: 2 }],
  },
  'help-circle': {
    marks: [
      { circle: [12, 12, 8.5] },
      { path: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5' },
      { path: 'M12 17h.01', weight: 2 },
    ],
  },
  clock: {
    marks: [{ circle: [12, 12, 8.5] }, { path: 'M12 7.5V12l3 2' }],
  },
  history: {
    marks: [
      { path: 'M4.5 12a7.5 7.5 0 1 0 7.5-7.5 7.8 7.8 0 0 0-5.6 2.4L4.5 8.8' },
      { path: 'M4.5 4.5v4.3h4.3M12 8.5V12l2.5 1.8' },
    ],
  },
  star: {
    marks: [{ path: 'M12 4l2.5 5.2 5.7.8-4.1 4 1 5.7L12 17l-5.1 2.7 1-5.7-4.1-4 5.7-.8z' }],
  },
  'shield-check': {
    marks: [
      { path: 'M12 3.5l7.5 2.8v5.7c0 4.2-3 7.3-7.5 8.5-4.5-1.2-7.5-4.3-7.5-8.5V6.3z' },
      { path: 'M8.75 12l2.25 2.25 4.25-4.5' },
    ],
  },
  lock: {
    marks: [
      { rect: [5.5, 10.5, 13, 10, 2] },
      { path: 'M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3' },
      { path: 'M12 15.5h.01', weight: 2 },
    ],
  },
  eye: {
    marks: [
      { path: 'M3.5 12c2-4.5 5-6.5 8.5-6.5s6.5 2 8.5 6.5c-2 4.5-5 6.5-8.5 6.5S5.5 16.5 3.5 12z' },
      { circle: [12, 12, 2.75] },
    ],
  },
  'eye-off': {
    marks: [
      {
        path: 'M4.5 4.5l15 15M9.9 9.9a3 3 0 0 0 4.2 4.2M6.8 6.9C5.4 8 4.3 9.7 3.5 12c2 4.5 5 6.5 8.5 6.5 1.6 0 3-.4 4.3-1.1M10.3 5.7c.5-.1 1.1-.2 1.7-.2 3.5 0 6.5 2 8.5 6.5-.5 1.1-1 2-1.6 2.8',
      },
    ],
  },
  'alert-circle': {
    // The circle family's ring, and `info-circle` turned over: a bar under the
    // dot says what this is, a bar over it says what to do about it.
    marks: [{ circle: [12, 12, 8.5] }, { path: 'M12 8v5' }, { path: 'M12 16h.01', weight: 2 }],
  },
  circle: {
    // The ring with nothing in it: a state that has not happened yet. `issue`
    // is this ring with its dot, and a ring that is filled is a `check-circle`.
    marks: [{ circle: [12, 12, 8.5] }],
  },
  'shield-alert': {
    marks: [
      { path: 'M12 3.5l7.5 2.8v5.7c0 4.2-3 7.3-7.5 8.5-4.5-1.2-7.5-4.3-7.5-8.5V6.3z' },
      { path: 'M12 8.5v4' },
      { path: 'M12 15.5h.01', weight: 2 },
    ],
  },
  session: {
    marks: [
      {
        path: 'M6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-3.5 3v-3a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      },
      { path: 'M8.5 9.5h7M8.5 12.5h4' },
    ],
    layers: {
      mass: 'M6.5 4.5h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-3.5 3v-3a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      detail: 'M8.5 9.5h7M8.5 12.5h4',
    },
  },
  sparkle: {
    marks: [
      {
        path: 'M10.5 6C11.1 10.2 13.8 12.9 18 13.5 13.8 14.1 11.1 16.8 10.5 21 9.9 16.8 7.2 14.1 3 13.5 7.2 12.9 9.9 10.2 10.5 6zM18 3.5c.2 1.4 1.1 2.3 2.5 2.5-1.4.2-2.3 1.1-2.5 2.5-.2-1.4-1.1-2.3-2.5-2.5 1.4-.2 2.3-1.1 2.5-2.5z',
      },
    ],
    layers: {
      mass: 'M10.5 6C11.1 10.2 13.8 12.9 18 13.5 13.8 14.1 11.1 16.8 10.5 21 9.9 16.8 7.2 14.1 3 13.5 7.2 12.9 9.9 10.2 10.5 6z',
      front:
        'M18 3.5c.2 1.4 1.1 2.3 2.5 2.5-1.4.2-2.3 1.1-2.5 2.5-.2-1.4-1.1-2.3-2.5-2.5 1.4-.2 2.3-1.1 2.5-2.5z',
      strokeFront: true,
    },
  },
  agent: {
    marks: [
      { rect: [5.5, 7.5, 13, 11, 3] },
      { path: 'M12 7.5V4M5.5 13H3.5M18.5 13h2M9.5 16h5' },
      { path: 'M9.5 12h.01M14.5 12h.01', weight: 2.5 },
    ],
    layers: {
      mass: 'M8.5 7.5h7a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3z',
      detail: 'M9.5 16h5',
      outer: 'M12 7.5V4M5.5 13H3.5M18.5 13h2',
      dots: 'M9.5 12h.01M14.5 12h.01',
    },
  },
  model: {
    marks: [
      { path: 'M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5z' },
      { path: 'M4.5 7.75 12 12l7.5-4.25M12 12v8.5' },
    ],
    layers: {
      mass: 'M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5z',
      mid: 'M12 12l7.5-4.25v8.5L12 20.5z',
      front: 'M12 3.5l7.5 4.25L12 12 4.5 7.75z',
      detail: 'M4.5 7.75 12 12l7.5-4.25M12 12v8.5',
      bulkDetail: '',
    },
  },
  cpu: {
    marks: [
      { rect: [6.5, 6.5, 11, 11, 2] },
      { rect: [10, 10, 4, 4, 0.75] },
      {
        path: 'M9.5 4v2.5M14.5 4v2.5M9.5 17.5V20M14.5 17.5V20M4 9.5h2.5M4 14.5h2.5M17.5 9.5H20M17.5 14.5H20',
      },
    ],
  },
  terminal: {
    marks: [
      { path: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z' },
      { path: 'M7.5 9.5l3 2.5-3 2.5M12.5 15h4' },
    ],
    layers: {
      mass: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
      detail: 'M7.5 9.5l3 2.5-3 2.5M12.5 15h4',
    },
  },
  zap: {
    marks: [{ path: 'M13 3.5 5.5 13.5h6L11 20.5l7.5-10h-6z' }],
  },
  globe: {
    marks: [
      { circle: [12, 12, 8.5] },
      {
        path: 'M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z',
      },
    ],
  },
  user: {
    marks: [{ circle: [12, 8, 3.5] }, { path: 'M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6' }],
  },
  bell: {
    // A bell is wider than it is tall. Drawn with an 11-wide dome over 6 units
    // of straight side it was neither: a tube with a cap on it, 14 across and 13
    // down. The dome is 12 now and the side sweeps out to a mouth 16.4 across a
    // 12.7-tall body.
    //
    // The sweep is a curve rather than a flange, and the mouth has thickness,
    // because a flange is a spike: the flare met the mouth line at 39 degrees,
    // which `stroke-linejoin: round` hides in the outline and a fill cannot —
    // glyph and bulk grew horns. Rounding the spike is not the answer either,
    // since a 0.8 radius at that angle eats 2.28 units of a 3.2-unit flare. So
    // the side arrives at the mouth vertically, turns through a 0.7 corner, and
    // the mouth is a line under it. The clapper's arc is a segment and not a
    // half-circle, so it hangs a unit clear and stops at the live area rather
    // than 1.25 past it; `front` is that same silhouette filled, for bulk.
    marks: [
      {
        path: 'M12 3.5v1.5M12 5.5a6 6 0 0 1 6 6c0 2.6 2.2 4.8 2.2 6a.7 .7 0 0 1-.7 .7H4.5a.7 .7 0 0 1-.7-.7c0-1.2 2.2-3.4 2.2-6a6 6 0 0 1 6-6zM10 20.5a3 3 0 0 0 4 0',
      },
    ],
    layers: {
      mass: 'M12 5.5a6 6 0 0 1 6 6c0 2.6 2.2 4.8 2.2 6a.7 .7 0 0 1-.7 .7H4.5a.7 .7 0 0 1-.7-.7c0-1.2 2.2-3.4 2.2-6a6 6 0 0 1 6-6z',
      front: 'M9.75 19.75h4.5a2.25 2.25 0 0 1-4.5 0z',
      outer: 'M12 3.5v1.5M10 20.5a3 3 0 0 0 4 0',
    },
  },
  settings: {
    marks: [
      {
        path: 'M18.79 10.31L20.91 10.75L20.91 13.25L18.79 13.69L18.00 15.61L19.19 17.42L17.42 19.19L15.61 18.00L13.69 18.79L13.25 20.91L10.75 20.91L10.31 18.79L8.39 18.00L6.58 19.19L4.81 17.42L6.00 15.61L5.21 13.69L3.09 13.25L3.09 10.75L5.21 10.31L6.00 8.39L4.81 6.58L6.58 4.81L8.39 6.00L10.31 5.21L10.75 3.09L13.25 3.09L13.69 5.21L15.61 6.00L17.42 4.81L19.19 6.58L18.00 8.39z',
      },
      { circle: [12, 12, 2.5] },
    ],
  },
  sun: {
    marks: [
      { circle: [12, 12, 3.5] },
      {
        path: 'M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6',
      },
    ],
  },
  moon: {
    marks: [{ path: 'M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z' }],
  },
  monitor: {
    // The machine this product is mostly about. The same 2px container as
    // `sidebar` and `terminal`, three units shorter, standing on a foot: the
    // foot is `outer`, so a glyph keeps the silhouette a screen alone loses.
    marks: [
      { path: 'M5.5 4.5h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z' },
      { path: 'M12 16.5v3M8.5 19.5h7' },
    ],
    layers: {
      mass: 'M5.5 4.5h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
      outer: 'M12 16.5v3M8.5 19.5h7',
    },
  },
  users: {
    // `user` twice on one skeleton: the same head and the same shoulders, the
    // second set cut off by the frame so the two read as a group and not as a
    // pair. The one in front is whole; the one behind gives its far half.
    //
    // No layer model, like `user`. The one behind is half a person, and half
    // a person as a stroke beside a filled one is not a person behind it —
    // it is two fragments floating off the shoulder of a silhouette.
    marks: [
      { circle: [9.5, 8.5, 3.25] },
      { path: 'M3 20c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5' },
      { path: 'M15.5 5.6a3.25 3.25 0 0 1 0 5.8M16.8 14.7c2.5.6 4.2 2.5 4.2 5.3' },
    ],
  },
  mail: {
    // A 2px container again, and the flap folded into it. The flap is `detail`
    // rather than a second panel: it is a crease on the face, not a layer over
    // it, so a glyph cuts it and bulk leaves the face flat.
    marks: [
      { path: 'M5.5 5.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z' },
      { path: 'M3.5 8l8.5 5.5L20.5 8' },
    ],
    layers: {
      mass: 'M5.5 5.5h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z',
      detail: 'M3.5 8l8.5 5.5L20.5 8',
    },
  },
  wrench: {
    marks: [
      {
        path: 'M14.8 4.6a5 5 0 0 0-6.4 6.4l-4.3 4.3a2 2 0 0 0 2.8 2.8l4.3-4.3a5 5 0 0 0 6.4-6.4l-2.9 2.9-2.8-.7-.7-2.8z',
      },
    ],
    layers: {
      mass: 'M14.8 4.6a5 5 0 0 0-6.4 6.4l-4.3 4.3a2 2 0 0 0 2.8 2.8l4.3-4.3a5 5 0 0 0 6.4-6.4l-2.9 2.9-2.8-.7-.7-2.8z',
    },
  },
};

export const ICON_NAMES = Object.keys(ICONS) as IconName[];
