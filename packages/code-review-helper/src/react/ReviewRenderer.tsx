import * as stylex from '@stylexjs/stylex';
import { canUseWASM } from '@pierre/diffs';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { FileDiff, type FileDiffProps } from '@pierre/diffs/react';
import { observeResizeOnAnimationFrame } from '@lody/components/lib/resize-observer';
import { ErrorBoundary } from './error-boundary';
import { useCodeReviewTheme } from './theme-provider';
import { parseDiffFromFile, type DiffLineAnnotation, type FileDiffMetadata } from '@pierre/diffs';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Columns2,
  Copy,
  ExternalLink,
  Folder,
  HelpCircle,
  Info,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  Rows3,
  Square,
  Trash2,
} from 'lucide-react';

import { getSourceLine } from '../sparse-text';
import { parseReviewRef } from '../parser';
import { countLines } from '../validation';
import { unwrapReviewBundle, type ReviewBundleInput } from '../snapshot';
import type {
  ReviewBundle,
  ReviewDiagnostic,
  ReviewFinding,
  ReviewFindingRef,
  ReviewNote,
  ReviewNoteSeverity,
  ReviewResolvedBlock,
  ReviewResolvedCommit,
  ReviewResolvedFile,
  ReviewResolvedGroup,
  ReviewSide,
  ReviewUserComment,
} from '../types';
import {
  buildFileTree,
  collectChecklistFiles,
  nodeCheckState,
  setNodeReviewed,
  setSnippetReviewed,
  setSnippetsReviewed,
  snippetsCheckState,
  type FileTreeNode,
  type ReviewCheckState,
} from '../review-checklist';
import { FileIcon } from '../file-icons';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Separator } from '@/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

type PierreSide = 'additions' | 'deletions';

/** A line range to highlight in a file's diff (from a finding-ref jump). */
interface HighlightSelection {
  readonly path: string;
  readonly lines: { readonly start: number; readonly end: number; readonly side: PierreSide };
}

export type ReviewDiffStyle = 'unified' | 'split';

interface ColumnWidths {
  readonly sidebar: number;
  readonly panel: number;
}

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 460;
const PANEL_MIN = 260;
const PANEL_MAX = 560;
const CENTER_MIN = 360;
const COLUMN_STORAGE_KEY = 'review-helper-columns';
const DEFAULT_COLUMNS: ColumnWidths = { sidebar: 264, panel: 360 };

interface DraftComment {
  readonly path: string;
  readonly side: ReviewSide;
  readonly lineNumber: number;
  readonly body: string;
}

interface ThreadItem {
  readonly kind: 'note' | 'comment';
  readonly id: string;
  readonly path: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly lineEnd: number;
  readonly severity: ReviewNoteSeverity;
  readonly anchor: string;
  readonly body: string;
  readonly createdAt?: number;
}

interface FileThread {
  readonly path: string;
  readonly items: readonly ThreadItem[];
}

/** A `## Review` finding that references this diff line, for the light line marker. */
interface FindingLineMarker {
  readonly findingId: string;
  readonly severity: ReviewNoteSeverity;
}

/** Where a finding ref lands in a file, used to build the line markers. */
interface FindingAnchor {
  readonly side: ReviewSide;
  readonly line: number;
  readonly findingId: string;
  readonly severity: ReviewNoteSeverity;
}

const EMPTY_FINDING_ANCHORS: readonly FindingAnchor[] = [];

function findingDomId(findingId: string): string {
  return `crh-${findingId}`;
}

interface AnnotationMeta {
  readonly key: string;
  readonly path: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly severity: ReviewNoteSeverity;
  readonly notes: readonly ReviewNote[];
  readonly comments: readonly ReviewUserComment[];
  readonly findingRefs: readonly FindingLineMarker[];
}

// Lody mark shown in the sidebar header. Bundled with the package (copied from
// @lody/components) so the renderer stays standalone; Vite inlines it as a data URL
// in the single-file viewer build and serves it normally in Storybook.
const lodyIconUrl = new URL('../assets/lody-icon.png', import.meta.url).href;

export interface ReviewRendererProps {
  readonly bundle: ReviewBundleInput;
  readonly storageKey?: string;
  readonly initialComments?: readonly ReviewUserComment[];
  readonly onCommentsChange?: (comments: readonly ReviewUserComment[]) => void;
  readonly defaultDiffStyle?: ReviewDiffStyle;
  readonly diffStyle?: ReviewDiffStyle;
  readonly onDiffStyleChange?: (diffStyle: ReviewDiffStyle) => void;
}

const privateButtonStyles = stylex.create({
  mutedInk: {
    '--crh-muted-button-label': {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground))' },
    },
  },
});

const rootLayoutStyles = stylex.create({
  toolbarNoShrink: { flexShrink: 0 },
  diffControlHeight: { height: 'calc(var(--spacing) * 8)' },
  resizerVisibility: {
    display: { default: null, '@media not all and (width >= 64rem)': 'none' },
  },
  shell: {
    position: 'relative',
    display: 'grid',
    maxWidth: '100vw',
    overflowX: 'hidden',
    overflowY: { default: null, '@media (width >= 64rem)': 'hidden' },
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  columnsBoth: {
    gridTemplateColumns: {
      default: null,
      '@media (width >= 64rem)': '232px minmax(0,1fr) 300px',
      '@media (width >= 80rem)': '264px minmax(0,1fr) minmax(336px,388px)',
    },
  },
  columnsSidebar: {
    gridTemplateColumns: {
      default: null,
      '@media (width >= 64rem)': '232px minmax(0,1fr)',
      '@media (width >= 80rem)': '264px minmax(0,1fr)',
    },
  },
  columnsPanel: {
    gridTemplateColumns: {
      default: null,
      '@media (width >= 64rem)': 'minmax(0,1fr) 300px',
      '@media (width >= 80rem)': 'minmax(0,1fr) minmax(336px,388px)',
    },
  },
  columnsMain: {
    gridTemplateColumns: { default: null, '@media (width >= 64rem)': 'minmax(0,1fr)' },
  },
  sidebar: {
    zIndex: 10,
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 4)',
    overflowY: 'auto',
    overflowX: 'hidden',
    borderRightStyle: 'var(--tw-border-style)',
    borderRightWidth: { default: '1px', '@media (width < 64rem)': '0px' },
    borderBottomStyle: { default: null, '@media (width < 64rem)': 'var(--tw-border-style)' },
    borderBottomWidth: { default: null, '@media (width < 64rem)': '1px' },
    borderColor: 'hsl(var(--sidebar-border))',
    backgroundColor: 'hsl(var(--sidebar))',
    padding: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--sidebar-foreground))',
    position: { default: 'relative', '@media (width >= 64rem)': 'sticky' },
    height: { default: 'auto', '@media (width >= 64rem)': '100vh' },
    top: { default: null, '@media (width >= 64rem)': 'calc(var(--spacing) * 0)' },
  },
  hidden: { display: 'none' },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    'padding-inline': 'calc(var(--spacing) * 1)',
  },
  logo: {
    width: 'calc(var(--spacing) * 7)',
    height: 'calc(var(--spacing) * 7)',
    flexShrink: 0,
    borderRadius: 'var(--radius)',
  },
  brandTitle: {
    '--tw-leading': 'var(--leading-tight)',
    lineHeight: 'var(--leading-tight)',
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': 'var(--tracking-tight)',
    letterSpacing: 'var(--tracking-tight)',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '15px',
  },
  navigation: {
    'margin-inline': 'calc(var(--spacing) * -1)',
    display: 'grid',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  group: { display: 'flex', width: '100%', flexDirection: 'column' },
  groupRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    'padding-left': 'calc(var(--spacing) * 2.5)',
    'padding-right': 'calc(var(--spacing) * 2)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  groupActive: {
    backgroundColor: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    },
    color: 'hsl(var(--foreground))',
  },
  groupInactive: {
    backgroundColor: {
      default: null,
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--foreground))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
        },
      },
    },
    color: 'hsl(var(--sidebar-foreground))',
  },
  groupButton: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    borderRadius: 'calc(var(--radius) - 2px)',
    textAlign: 'left',
  },
  groupText: { minWidth: 'calc(var(--spacing) * 0)', flex: '1' },
  pullRequestNumber: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
  },
  groupTitle: {
    '--tw-leading': 'var(--leading-snug)',
    lineHeight: 'var(--leading-snug)',
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
    display: 'block',
    overflowWrap: 'break-word',
    fontSize: '13px',
  },
  groupStats: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'block',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
  },
  additions: { color: 'hsl(var(--github-addition))' },
  deletions: { color: 'hsl(var(--github-deletion))' },
  fileCount: { 'margin-left': 'calc(var(--spacing) * 1.5)', color: 'hsl(var(--muted-foreground))' },
  descriptionButton: {
    flexShrink: 0,
    borderRadius: 'calc(var(--radius) - 2px)',
    padding: 'calc(var(--spacing) * 0.5)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  descriptionActive: { color: 'hsl(var(--foreground))' },
  descriptionInactive: {
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground))' },
    },
  },
  descriptionIcon: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
  },
  description: {
    'margin-top': 'calc(var(--spacing) * 1.5)',
    maxHeight: 'calc(var(--spacing) * 80)',
    overflowY: 'auto',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1)',
    fontSize: '13px',
  },
  main: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flexDirection: 'column',
    overflowX: 'hidden',
    height: { default: null, '@media (width >= 64rem)': '100vh' },
  },
  toolbar: {
    position: 'sticky',
    top: 'calc(var(--spacing) * 0)',
    zIndex: 30,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 'calc(var(--spacing) * 3)',
    rowGap: 'calc(var(--spacing) * 2)',
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    backgroundColor: 'hsl(var(--background))',
    'padding-inline': {
      default: 'calc(var(--spacing) * 4)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 5)',
    },
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  totalStats: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  mono: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  content: {
    minWidth: 'calc(var(--spacing) * 0)',
    'padding-inline': {
      default: 'calc(var(--spacing) * 4)',
      '@media (width >= 40rem)': 'calc(var(--spacing) * 6)',
    },
    'padding-block': 'calc(var(--spacing) * 5)',
  },
  empty: {
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    backgroundColor: 'hsl(var(--card))',
    padding: 'calc(var(--spacing) * 5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
    color: 'hsl(var(--muted-foreground))',
  },
  groups: {
    'margin-inline': 'auto',
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    maxWidth: '1100px',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 6)',
  },
  summary: { minWidth: 'calc(var(--spacing) * 0)' },
  titleBlock: {
    'margin-bottom': 'calc(var(--spacing) * 4)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  title: {
    '--tw-leading': 'var(--leading-snug)',
    lineHeight: 'var(--leading-snug)',
    '--tw-font-weight': 'var(--font-weight-bold)',
    fontWeight: 'var(--font-weight-bold)',
    '--tw-tracking': 'var(--tracking-tight)',
    letterSpacing: 'var(--tracking-tight)',
    fontSize: '22px',
  },
  pullRequest: {
    display: 'inline-flex',
    width: 'fit-content',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: '12px',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground))' },
    },
    textUnderlineOffset: '4px',
    textDecorationLine: { default: null, '@media (hover: hover)': { ':hover': 'underline' } },
  },
  externalIcon: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
    flexShrink: 0,
  },
  pullRequestSeparator: {
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted-foreground)) 50%, transparent)',
    },
  },
  pullRequestTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
    },
  },
});

export function ReviewRenderer({
  bundle: bundleInput,
  storageKey,
  initialComments,
  onCommentsChange,
  defaultDiffStyle = 'unified',
  diffStyle,
  onDiffStyleChange,
}: ReviewRendererProps) {
  const bundle = useMemo(
    () => mergeDiffBlocksByPath(unwrapReviewBundle(bundleInput)),
    [bundleInput]
  );
  const effectiveStorageKey = useMemo(
    () => storageKey ?? createDefaultStorageKey(bundle),
    [bundle, storageKey]
  );
  const [comments, setComments] = useState<ReviewUserComment[]>(() =>
    initialComments ? [...initialComments] : loadComments(effectiveStorageKey)
  );
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    () => bundle.groups[0]?.id ?? null
  );
  const highlightedGroupId = bundle.groups.some((group) => group.id === selectedGroupId)
    ? selectedGroupId
    : (bundle.groups[0]?.id ?? null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [uncontrolledDiffStyle, setUncontrolledDiffStyle] =
    useState<ReviewDiffStyle>(defaultDiffStyle);
  const [isDesktop, setIsDesktop] = useState(isDesktopViewport);
  const [focusedAnchor, setFocusedAnchor] = useState<string | null>(null);
  const focusedAnchorRef = useRef<string | null>(focusedAnchor);
  // Keep the mutable ref in sync with state so scroll handlers can read the
  // latest value without re-subscribing to the scroll listener on every change.
  focusedAnchorRef.current = focusedAnchor;
  // Paths forced to render their diff immediately (bypassing lazy IntersectionObserver
  // mounting) so panel-initiated navigation can scroll to a marker in one frame.
  const [forceVisiblePaths, setForceVisiblePaths] = useState<ReadonlySet<string>>(new Set());
  // Paths forced to expand so a target marker inside a collapsed block is reachable.
  const [forceExpandedPaths, setForceExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  // Single source of truth for review checkboxes: reviewed snippet (block) ids.
  // File / folder / group states all derive from this via `review-checklist`.
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set());
  const [columns, setColumns] = useState<ColumnWidths>(loadColumnWidths);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [panelVisible, setPanelVisible] = useState(true);
  const [expandedDescriptionIds, setExpandedDescriptionIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const activeDiffStyle = diffStyle ?? uncontrolledDiffStyle;
  const toggleDescription = useCallback((groupId: string) => {
    setExpandedDescriptionIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);
  const mainRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Cached toolbar height so the scroll handler never reads `offsetHeight` (a
  // forced synchronous layout) on every frame. Kept in sync by the ResizeObserver
  // that also updates the `--crh-toolbar-h` CSS var.
  const toolbarHeightRef = useRef(48);
  const shellRef = useRef<HTMLDivElement>(null);
  // While a right-panel comment is being navigated to, skip center-column
  // scroll-spy updates so the two panels don't fight each other.
  const isNavigatingFromPanelRef = useRef(false);
  const panelNavigationRafRef = useRef(0);

  useEffect(() => saveColumnWidths(columns), [columns]);

  const resizeColumn = useCallback((side: 'sidebar' | 'panel', clientX: number) => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }
    const rect = shell.getBoundingClientRect();
    setColumns((prev) => {
      if (side === 'sidebar') {
        const max = Math.max(SIDEBAR_MIN, rect.width - prev.panel - CENTER_MIN);
        return { ...prev, sidebar: clamp(clientX - rect.left, SIDEBAR_MIN, max) };
      }
      const max = Math.max(PANEL_MIN, rect.width - prev.sidebar - CENTER_MIN);
      return { ...prev, panel: clamp(rect.right - clientX, PANEL_MIN, max) };
    });
  }, []);

  const stepColumn = useCallback((side: 'sidebar' | 'panel', delta: number) => {
    setColumns((prev) => {
      if (side === 'sidebar') {
        return { ...prev, sidebar: clamp(prev.sidebar + delta, SIDEBAR_MIN, SIDEBAR_MAX) };
      }
      return { ...prev, panel: clamp(prev.panel + delta, PANEL_MIN, PANEL_MAX) };
    });
  }, []);

  const fileTree = useMemo<FileTreeNode[]>(
    () => buildFileTree(collectChecklistFiles(bundle.groups)),
    [bundle.groups]
  );

  const toggleSnippetReviewed = useCallback(
    (snippetId: string, checked: boolean) =>
      setReviewed((current) => setSnippetReviewed(current, snippetId, checked)),
    []
  );
  const toggleGroupReviewed = useCallback(
    (snippetIds: readonly string[], checked: boolean) =>
      setReviewed((current) => setSnippetsReviewed(current, snippetIds, checked)),
    []
  );
  const toggleNodeReviewed = useCallback(
    (node: FileTreeNode, checked: boolean) =>
      setReviewed((current) => setNodeReviewed(current, node, checked)),
    []
  );

  // Keep the sticky file-header offset in sync with the toolbar height (it can
  // wrap to two rows on narrow widths). Falls back to the CSS default otherwise.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const main = mainRef.current;
    if (!toolbar || !main || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const sync = () => {
      toolbarHeightRef.current = toolbar.offsetHeight;
      main.style.setProperty('--crh-toolbar-h', `${toolbar.offsetHeight}px`);
    };
    sync();
    return observeResizeOnAnimationFrame(toolbar, () => sync());
  }, []);

  const totalStats = useMemo(() => sumFileStats(Object.values(bundle.files)), [bundle.files]);

  const fileThreads = useMemo<FileThread[]>(() => {
    const order: string[] = [];
    const map = new Map<string, ThreadItem[]>();
    const ensure = (path: string) => {
      let items = map.get(path);
      if (!items) {
        items = [];
        map.set(path, items);
        order.push(path);
      }
      return items;
    };
    for (const group of bundle.groups) {
      for (const block of group.blocks) {
        for (const note of block.notes) {
          const severity = note.severity ?? 'info';
          // Info notes render inline in the diff, so they don't need a right-panel
          // thread; questions and P0/P1/P2 issues stay surfaced for triage.
          if (severity === 'info') {
            continue;
          }
          ensure(block.path).push({
            kind: 'note',
            id: note.id,
            path: block.path,
            side: note.side,
            line: note.range.start,
            lineEnd: note.range.end,
            severity,
            anchor: anchorKeyOf(block.path, note.side, note.range.start),
            body: note.body,
          });
        }
      }
    }
    for (const comment of comments) {
      ensure(comment.anchor.path).push({
        kind: 'comment',
        id: comment.id,
        path: comment.anchor.path,
        side: comment.anchor.side,
        line: comment.anchor.lineNumber,
        lineEnd: comment.anchor.lineNumber,
        severity: 'info',
        anchor: anchorKeyOf(comment.anchor.path, comment.anchor.side, comment.anchor.lineNumber),
        body: comment.body,
        createdAt: comment.createdAt,
      });
    }
    for (const items of map.values()) {
      items.sort((a, b) => a.line - b.line || (a.kind === b.kind ? 0 : a.kind === 'note' ? -1 : 1));
    }
    return order
      .map((path) => ({ path, items: map.get(path) ?? [] }))
      .filter((t) => t.items.length > 0);
  }, [bundle.groups, comments]);

  const threadTotal = useMemo(
    () => fileThreads.reduce((total, thread) => total + thread.items.length, 0),
    [fileThreads]
  );

  // P0/P1 issues surfaced at the top of the panel for quick triage (P2 stays inline).
  const findings = bundle.document.findings ?? [];
  const hasPanelContent = findings.length > 0 || fileThreads.length > 0 || draft !== null;

  const groupStatsById = useMemo(() => {
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const group of bundle.groups) {
      const paths = [...new Set(group.blocks.map((block) => block.path))];
      stats.set(group.id, sumFileStats(paths.map((path) => bundle.files[path]).filter(Boolean)));
    }
    return stats;
  }, [bundle.groups, bundle.files]);

  const fileStatsByPath = useMemo(() => {
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const [path, file] of Object.entries(bundle.files)) {
      stats.set(path, { additions: file.additions, deletions: file.deletions });
    }
    return stats;
  }, [bundle.files]);

  useEffect(() => {
    if (initialComments !== undefined) {
      setComments([...initialComments]);
      return;
    }
    setComments(loadComments(effectiveStorageKey));
  }, [effectiveStorageKey, initialComments]);

  const onCommentsChangeRef = useRef(onCommentsChange);
  useEffect(() => {
    onCommentsChangeRef.current = onCommentsChange;
  });
  const skipCommentsNotifyRef = useRef(true);
  useEffect(() => {
    saveComments(effectiveStorageKey, comments);
    // Skip the initial commit so we never echo the seed value straight back at
    // a parent (and keep the callback in a ref so an inline prop can't loop).
    if (skipCommentsNotifyRef.current) {
      skipCommentsNotifyRef.current = false;
      return;
    }
    onCommentsChangeRef.current?.(comments);
  }, [comments, effectiveStorageKey]);

  // Track the desktop breakpoint so the scroll-spy observer uses the correct
  // scroll root: <main> only becomes the scroll container at >=1024px; below
  // that the document scrolls, so the observer must fall back to the viewport.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  // Scroll-spy: keep the sidebar nav in sync with the group scrolled into view.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const sections = bundle.groups
      .map((group) => document.getElementById(groupDomId(group.id)))
      .filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) {
      return undefined;
    }
    const visibleTops = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-group-id');
          if (!id) {
            continue;
          }
          if (entry.isIntersecting) {
            visibleTops.set(id, entry.boundingClientRect.top);
          } else {
            visibleTops.delete(id);
          }
        }
        let topId: string | undefined;
        let topValue = Number.POSITIVE_INFINITY;
        for (const [id, top] of visibleTops) {
          if (top < topValue) {
            topValue = top;
            topId = id;
          }
        }
        if (topId) {
          setSelectedGroupId(topId);
        }
      },
      {
        root: isDesktop ? (mainRef.current ?? null) : null,
        rootMargin: '-8% 0px -68% 0px',
        threshold: 0,
      }
    );
    for (const section of sections) {
      observer.observe(section);
    }
    return () => observer.disconnect();
  }, [bundle.groups, isDesktop]);

  const setActiveDiffStyle = useCallback(
    (nextDiffStyle: ReviewDiffStyle) => {
      if (diffStyle === undefined) {
        setUncontrolledDiffStyle(nextDiffStyle);
      }
      onDiffStyleChange?.(nextDiffStyle);
    },
    [diffStyle, onDiffStyleChange]
  );

  const copyComments = useCallback(async () => {
    const markdown = formatCommentsMarkdown(bundle, comments);
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1400);
    } catch {
      setCopyState('failed');
    }
  }, [bundle, comments]);

  const startDraft = useCallback((path: string, side: ReviewSide, lineNumber: number) => {
    setDraft({ path, side, lineNumber, body: '' });
  }, []);

  const updateDraftBody = useCallback((body: string) => {
    setDraft((current) => (current ? { ...current, body } : current));
  }, []);

  const cancelDraft = useCallback(() => setDraft(null), []);

  const saveDraft = useCallback(() => {
    setDraft((current) => {
      if (!current || current.body.trim().length === 0) {
        return null;
      }
      const file = bundle.files[current.path];
      const lineText = file
        ? getSourceLine(current.side === 'old' ? file.oldText : file.newText, current.lineNumber)
        : undefined;
      const comment: ReviewUserComment = {
        id: `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        anchor: { path: current.path, side: current.side, lineNumber: current.lineNumber },
        body: current.body.trim(),
        ...(lineText === undefined ? {} : { lineText }),
        createdAt: Date.now(),
      };
      setComments((existing) => [...existing, comment]);
      return null;
    });
  }, [bundle.files]);

  const deleteComment = useCallback((id: string) => {
    setComments((existing) => existing.filter((comment) => comment.id !== id));
  }, []);

  // Center -> panel: highlight the diff marker and scroll the panel thread to it.
  const focusFromDiff = useCallback((anchor: string) => {
    setFocusedAnchor(anchor);
    if (typeof document === 'undefined') {
      return;
    }
    document
      .querySelectorAll('.crh-anno-focused')
      .forEach((element) => element.classList.remove('crh-anno-focused'));
    document.querySelector(`.crh-main [data-anno="${anchor}"]`)?.classList.add('crh-anno-focused');
    document
      .querySelector(`.crh-panel [data-anchor="${anchor}"]`)
      ?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }, []);

  // Scroll the right-panel thread card for the given anchor to the top of the
  // panel scroll container. Kept synchronous (no useEffect) so it runs in the
  // same frame as the measurement and can be guarded by the navigation flag.
  const scrollPanelToAnchor = useCallback((anchor: string, behavior: ScrollBehavior = 'smooth') => {
    if (typeof document === 'undefined') {
      return;
    }
    const panel = document.querySelector('[data-cr-panel-scroll]');
    const card = panel?.querySelector(`[data-anchor="${escapeCssIdent(anchor)}"]`);
    if (!(panel instanceof HTMLElement) || !(card instanceof HTMLElement)) {
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const currentScrollTop = panel.scrollTop;
    const cardTop = cardRect.top - panelRect.top + currentScrollTop;
    const padding = 12;
    const targetScrollTop = cardTop - padding;

    if (Math.abs(currentScrollTop - targetScrollTop) > 4) {
      panel.scrollTo({ top: Math.max(0, targetScrollTop), behavior });
    }
  }, []);

  // Determine which files and annotation markers are visible in the main
  // viewport. Several files can be active at once (small diffs). The top-most
  // visible annotation marker drives right-panel scroll-sync. Read from the DOM
  // each time so it survives lazy-mounted / collapsed blocks.
  // Panel scrolling is done synchronously here (not in a useEffect) so the
  // navigation guard can be checked at the exact moment we measure.
  const recomputeScrollSync = useCallback(() => {
    const main = mainRef.current;
    if (!main) {
      return;
    }
    const mainRect = main.getBoundingClientRect();
    const contentTop = mainRect.top + toolbarHeightRef.current;
    const visible: { path: string; top: number }[] = [];
    main.querySelectorAll<HTMLElement>('[data-block-path]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > contentTop + 8 && rect.top < mainRect.bottom - 8) {
        visible.push({ path: el.dataset.blockPath ?? '', top: rect.top });
      }
    });
    visible.sort((a, b) => a.top - b.top);
    const seen = new Set<string>();
    for (const item of visible) {
      if (item.path && !seen.has(item.path)) {
        seen.add(item.path);
      }
    }

    // The right panel is intentionally static: it does NOT follow the center
    // column's scroll, and inactive files are not dimmed. We only drop the
    // click-focus highlight once its file scrolls out of view, so a stale marker
    // highlight doesn't linger.
    if (!isNavigatingFromPanelRef.current && focusedAnchorRef.current) {
      const path = focusedAnchorRef.current.split('::')[0] ?? '';
      if (!seen.has(path)) {
        focusedAnchorRef.current = null;
        setFocusedAnchor(null);
        if (typeof document !== 'undefined') {
          document
            .querySelectorAll('.crh-anno-focused')
            .forEach((element) => element.classList.remove('crh-anno-focused'));
        }
      }
    }
  }, []);

  const finishNavigation = useCallback(
    (path: string, anchor?: string) => {
      panelNavigationRafRef.current = 0;
      recomputeScrollSync();

      const main = mainRef.current;
      if (!main) {
        isNavigatingFromPanelRef.current = false;
        return;
      }

      // Keep re-scrolling to the target until its position in the main column
      // stabilises. FileDiff blocks render lazily and can grow across several
      // frames, so a single scrollIntoView often lands ahead of the final
      // layout. We measure the target's relative top each frame and re-align
      // until it stops moving.
      const targetElement = (() => {
        if (anchor) {
          const marker = document.querySelector(
            `.crh-main [data-anno="${escapeCssIdent(anchor)}"]`
          );
          if (marker instanceof HTMLElement) {
            return marker;
          }
        }
        const block = document.querySelector(`[data-block-path="${escapeCssIdent(path)}"]`);
        return block instanceof HTMLElement ? block : null;
      })();

      if (!targetElement) {
        isNavigatingFromPanelRef.current = false;
        return;
      }

      const scrollToTarget = () => {
        if (anchor) {
          targetElement.scrollIntoView({ behavior: 'auto', block: 'center' });
        } else {
          targetElement.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
      };

      const measureTargetTop = () => {
        const mainRect = main.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        return targetRect.top - mainRect.top;
      };

      scrollToTarget();
      let lastTargetTop = measureTargetTop();
      let settledFrames = 0;
      let frames = 0;
      const maxFrames = 60;

      const waitForSettle = () => {
        frames += 1;
        const currentTop = measureTargetTop();
        if (Math.abs(currentTop - lastTargetTop) > 2) {
          lastTargetTop = currentTop;
          settledFrames = 0;
          scrollToTarget();
        } else {
          settledFrames += 1;
        }

        if (settledFrames < 3 && frames < maxFrames) {
          panelNavigationRafRef.current = requestAnimationFrame(waitForSettle);
        } else {
          panelNavigationRafRef.current = 0;
          isNavigatingFromPanelRef.current = false;
          // Release the forced visibility/expansion after a short delay so the
          // block can return to lazy loading once IntersectionObserver has fired.
          setTimeout(() => {
            setForceVisiblePaths((prev) => {
              if (!prev.has(path)) return prev;
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
            setForceExpandedPaths((prev) => {
              if (!prev.has(path)) return prev;
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          }, 2000);
        }
      };
      panelNavigationRafRef.current = requestAnimationFrame(waitForSettle);
    },
    [recomputeScrollSync]
  );

  const isInMainViewport = useCallback((element: Element): boolean => {
    const main = mainRef.current;
    if (!main) {
      return false;
    }
    const mainRect = main.getBoundingClientRect();
    const toolbarHeight = toolbarRef.current?.offsetHeight ?? 0;
    const contentTop = mainRect.top + toolbarHeight;
    const rect = element.getBoundingClientRect();
    return rect.bottom > contentTop + 4 && rect.top < mainRect.bottom - 4;
  }, []);

  // Navigate the center column to a file block, optionally to a specific line
  // marker. Forces the target block to render/expand synchronously so the jump
  // can complete in one frame instead of waiting for lazy IntersectionObserver
  // mounting and retrying across animation frames.
  const navigateToFile = useCallback(
    (path: string, anchor?: string) => {
      if (typeof document === 'undefined') {
        return;
      }

      isNavigatingFromPanelRef.current = true;
      if (panelNavigationRafRef.current) {
        cancelAnimationFrame(panelNavigationRafRef.current);
      }

      // Force the target block to render immediately. flushSync guarantees the
      // DOM update (and layout effects) complete before we measure/scroll.
      flushSync(() => {
        setForceVisiblePaths((prev) => {
          if (prev.has(path)) return prev;
          const next = new Set(prev);
          next.add(path);
          return next;
        });
        setForceExpandedPaths((prev) => {
          if (prev.has(path)) return prev;
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      });

      if (anchor) {
        setFocusedAnchor(anchor);
        // Move the right panel to the target comment immediately so it stays put
        // while the center column scrolls, then scroll-spy resumes from the
        // correct anchor.
        scrollPanelToAnchor(anchor, 'auto');
      }

      const main = mainRef.current;
      const block = document.querySelector(`[data-block-path="${escapeCssIdent(path)}"]`);
      if (!main || !block) {
        finishNavigation(path, anchor);
        return;
      }

      if (!isInMainViewport(block)) {
        block.scrollIntoView({ behavior: 'auto', block: 'start' });
      }

      if (anchor) {
        const marker = document.querySelector(`.crh-main [data-anno="${escapeCssIdent(anchor)}"]`);
        if (marker instanceof HTMLElement) {
          document
            .querySelectorAll('.crh-anno-focused')
            .forEach((element) => element.classList.remove('crh-anno-focused'));
          marker.classList.add('crh-anno-focused');
          marker.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
      }

      finishNavigation(path, anchor);
    },
    [finishNavigation, isInMainViewport, scrollPanelToAnchor]
  );

  const scrollToFile = useCallback(
    (path: string) => {
      navigateToFile(path);
    },
    [navigateToFile]
  );

  // `## Review` findings → line markers, grouped by path (only refs that name a line).
  const findingAnchorsByPath = useMemo(() => {
    const map = new Map<string, FindingAnchor[]>();
    for (const finding of bundle.document.findings ?? []) {
      for (const ref of finding.refs) {
        if (!ref.range) {
          continue;
        }
        const list = map.get(ref.path) ?? [];
        list.push({
          side: ref.side,
          line: ref.range.start,
          findingId: finding.id,
          severity: finding.severity,
        });
        map.set(ref.path, list);
      }
    }
    return map;
  }, [bundle.document.findings]);

  // Paths that actually have a rendered block — a finding chip is only jumpable to one
  // of these. A ref to a file not in the review is a no-op (instead of scrolling nowhere
  // and setting a highlight no block can consume).
  const renderablePaths = useMemo(() => {
    const set = new Set<string>();
    for (const group of bundle.groups) {
      for (const block of group.blocks) {
        set.add(block.path);
      }
    }
    return set;
  }, [bundle.groups]);

  // The line range to highlight from the most recent finding-ref jump (so clicking a
  // `…:L18-L22` chip highlights all of 18–22, not just the marker). One at a time, and
  // it only FLASHES — a persistent selection band would mask the add/delete row colors,
  // so we clear it after a beat.
  const [highlightedRange, setHighlightedRange] = useState<HighlightSelection | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    []
  );

  // Finding ref chip → jump the center diff to that file/line (force-mount + expand) and
  // briefly flash the referenced line range.
  const jumpToRef = useCallback(
    (ref: ReviewFindingRef) => {
      // Verify the file is actually rendered before doing anything.
      if (!renderablePaths.has(ref.path)) {
        return;
      }
      const anchor = ref.range ? anchorKeyOf(ref.path, ref.side, ref.range.start) : undefined;
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      setHighlightedRange(
        ref.range
          ? {
              path: ref.path,
              lines: { start: ref.range.start, end: ref.range.end, side: toPierreSide(ref.side) },
            }
          : null
      );
      if (ref.range) {
        highlightTimerRef.current = window.setTimeout(() => {
          setHighlightedRange(null);
          highlightTimerRef.current = null;
        }, 1400);
      }
      navigateToFile(ref.path, anchor);
    },
    [navigateToFile, renderablePaths]
  );

  const navigateToGroup = useCallback(
    (groupId: string) => {
      if (typeof document === 'undefined') {
        return;
      }

      const group = bundle.groups.find((g) => g.id === groupId);
      if (!group) {
        return;
      }

      isNavigatingFromPanelRef.current = true;
      if (panelNavigationRafRef.current) {
        cancelAnimationFrame(panelNavigationRafRef.current);
      }

      const paths = new Set(group.blocks.map((block) => block.path));

      flushSync(() => {
        setSelectedGroupId(groupId);
        setForceVisiblePaths((prev) => {
          const next = new Set(prev);
          for (const path of paths) {
            next.add(path);
          }
          return next;
        });
        setForceExpandedPaths((prev) => {
          const next = new Set(prev);
          for (const path of paths) {
            next.add(path);
          }
          return next;
        });
      });

      const main = mainRef.current;
      const section = document.getElementById(groupDomId(groupId));
      if (!main || !section) {
        isNavigatingFromPanelRef.current = false;
        return;
      }

      const releaseForces = () => {
        setForceVisiblePaths((prev) => {
          if ([...paths].every((path) => !prev.has(path))) return prev;
          const next = new Set(prev);
          for (const path of paths) {
            next.delete(path);
          }
          return next;
        });
        setForceExpandedPaths((prev) => {
          if ([...paths].every((path) => !prev.has(path))) return prev;
          const next = new Set(prev);
          for (const path of paths) {
            next.delete(path);
          }
          return next;
        });
      };

      section.scrollIntoView({ behavior: 'auto', block: 'start' });
      recomputeScrollSync();

      let lastTop = section.getBoundingClientRect().top - main.getBoundingClientRect().top;
      let settledFrames = 0;
      let frames = 0;
      const maxFrames = 60;

      const waitForSettle = () => {
        frames += 1;
        const currentTop = section.getBoundingClientRect().top - main.getBoundingClientRect().top;
        if (Math.abs(currentTop - lastTop) > 2) {
          lastTop = currentTop;
          settledFrames = 0;
          section.scrollIntoView({ behavior: 'auto', block: 'start' });
        } else {
          settledFrames += 1;
        }

        if (settledFrames < 3 && frames < maxFrames) {
          panelNavigationRafRef.current = requestAnimationFrame(waitForSettle);
        } else {
          panelNavigationRafRef.current = 0;
          isNavigatingFromPanelRef.current = false;
          setTimeout(releaseForces, 2000);
        }
      };
      panelNavigationRafRef.current = requestAnimationFrame(waitForSettle);
    },
    [bundle.groups, recomputeScrollSync]
  );

  const focusFromPanel = useCallback(
    (anchor: string, path: string) => {
      navigateToFile(path, anchor);
    },
    [navigateToFile]
  );

  // Clear a stale click-focus highlight once its file scrolls out of view
  // (desktop only). The right panel itself stays put — it does not follow scroll.
  useEffect(() => {
    if (!isDesktop) {
      return undefined;
    }
    const main = mainRef.current;
    if (!main) {
      return undefined;
    }
    let raf = 0;
    const onScroll = () => {
      if (raf || isNavigatingFromPanelRef.current) {
        return;
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        recomputeScrollSync();
      });
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      main.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [isDesktop, recomputeScrollSync]);

  // Reviewed-driven collapse changes block heights — recompute after it settles.
  useEffect(() => {
    if (isDesktop) {
      recomputeScrollSync();
    }
  }, [reviewed, isDesktop, recomputeScrollSync]);

  const showPanel = panelVisible && hasPanelContent;
  const gridTemplateColumns = useMemo(() => {
    if (!isDesktop) return undefined;
    const parts: string[] = [];
    if (sidebarVisible) parts.push(`${columns.sidebar}px`);
    parts.push('minmax(0,1fr)');
    if (showPanel) parts.push(`${columns.panel}px`);
    return { gridTemplateColumns: parts.join(' ') };
  }, [isDesktop, sidebarVisible, showPanel, columns.sidebar, columns.panel]);

  return (
    <ErrorBoundary fallback={<ReviewRenderError />}>
      <div
        ref={shellRef}
        className={cn(
          'crh-shell dark',
          stylex.props(
            rootLayoutStyles.shell,
            sidebarVisible && showPanel
              ? rootLayoutStyles.columnsBoth
              : sidebarVisible
                ? rootLayoutStyles.columnsSidebar
                : showPanel
                  ? rootLayoutStyles.columnsPanel
                  : rootLayoutStyles.columnsMain
          ).className
        )}
        style={gridTemplateColumns}
      >
        {isDesktop && sidebarVisible && (
          <ColumnResizer
            side="left"
            label="Resize the navigation sidebar"
            offset={columns.sidebar}
            onResize={(clientX) => resizeColumn('sidebar', clientX)}
            onStep={(delta) => stepColumn('sidebar', delta)}
          />
        )}
        {isDesktop && showPanel && (
          <ColumnResizer
            side="right"
            label="Resize the review panel"
            offset={columns.panel}
            onResize={(clientX) => resizeColumn('panel', clientX)}
            onStep={(delta) => stepColumn('panel', delta)}
          />
        )}
        <aside
          className={cn(
            'crh-sidebar',
            stylex.props(rootLayoutStyles.sidebar, !sidebarVisible && rootLayoutStyles.hidden)
              .className
          )}
          aria-label="Review groups"
        >
          <div {...stylex.props(rootLayoutStyles.brand)}>
            <img src={lodyIconUrl} alt="Lody" {...stylex.props(rootLayoutStyles.logo)} />
            <h1 {...stylex.props(rootLayoutStyles.brandTitle)}>Lody Review</h1>
          </div>

          <nav {...stylex.props(rootLayoutStyles.navigation)} aria-label="Review group navigation">
            {bundle.groups.map((group) => {
              const isActive = group.id === highlightedGroupId;
              const stats = groupStatsById.get(group.id);
              const fileCount = new Set(group.blocks.map((block) => block.path)).size;
              const descriptionExpanded = expandedDescriptionIds.has(group.id);
              const description = stripGroupMetadataMarkdown(group.bodyMarkdown);
              return (
                <div key={group.id} {...stylex.props(rootLayoutStyles.group)}>
                  <div
                    className={cn(
                      stylex.props(
                        rootLayoutStyles.groupRow,
                        isActive ? rootLayoutStyles.groupActive : rootLayoutStyles.groupInactive
                      ).className
                    )}
                  >
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      {...stylex.props(
                        rootLayoutStyles.groupButton,
                        treeCommitStyles.commitControlFocus
                      )}
                      onClick={() => navigateToGroup(group.id)}
                    >
                      <span {...stylex.props(rootLayoutStyles.groupText)}>
                        <span {...stylex.props(rootLayoutStyles.groupTitle)}>{group.title}</span>
                        {stats ? (
                          <span {...stylex.props(rootLayoutStyles.groupStats)}>
                            <span {...stylex.props(rootLayoutStyles.additions)}>
                              +{stats.additions}
                            </span>{' '}
                            <span {...stylex.props(rootLayoutStyles.deletions)}>
                              −{stats.deletions}
                            </span>
                            <span {...stylex.props(rootLayoutStyles.fileCount)}>
                              {fileCount} files
                            </span>
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {description.length > 0 && (
                      <button
                        type="button"
                        aria-expanded={descriptionExpanded}
                        aria-label={
                          descriptionExpanded ? 'Hide group description' : 'Show group description'
                        }
                        {...stylex.props(
                          rootLayoutStyles.descriptionButton,
                          isActive
                            ? rootLayoutStyles.descriptionActive
                            : rootLayoutStyles.descriptionInactive,
                          treeCommitStyles.commitControlFocus
                        )}
                        onClick={() => toggleDescription(group.id)}
                      >
                        <Info {...stylex.props(rootLayoutStyles.descriptionIcon)} />
                      </button>
                    )}
                  </div>
                  {descriptionExpanded && description.length > 0 && (
                    <div {...stylex.props(rootLayoutStyles.description)}>
                      <SimpleMarkdown markdown={description} compact />
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          <Separator className="bg-sidebar-border" />

          <FileTree
            nodes={fileTree}
            reviewed={reviewed}
            fileStats={fileStatsByPath}
            onToggle={toggleNodeReviewed}
            onNavigate={scrollToFile}
          />
        </aside>

        <main
          ref={mainRef}
          className={cn('crh-main', stylex.props(rootLayoutStyles.main).className)}
        >
          <div
            ref={toolbarRef}
            className={cn('crh-toolbar', stylex.props(rootLayoutStyles.toolbar).className)}
          >
            <Button
              type="button"
              size="icon"
              variant={sidebarVisible ? 'secondary' : 'ghost'}
              width="calc(var(--spacing) * 8)"
              height="calc(var(--spacing) * 8)"
              {...stylex.props(rootLayoutStyles.toolbarNoShrink)}
              onClick={() => setSidebarVisible((v) => !v)}
              aria-pressed={sidebarVisible}
              title={sidebarVisible ? 'Hide review map' : 'Show review map'}
            >
              <PanelLeft className="size-4" />
            </Button>
            <div {...stylex.props(rootLayoutStyles.totalStats)}>
              <span {...stylex.props(rootLayoutStyles.mono)} title="Total added / removed lines">
                <span {...stylex.props(rootLayoutStyles.additions)}>+{totalStats.additions}</span>{' '}
                <span {...stylex.props(rootLayoutStyles.deletions)}>−{totalStats.deletions}</span>
              </span>
            </div>
            <DiffStyleControl diffStyle={activeDiffStyle} onDiffStyleChange={setActiveDiffStyle} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              gap="calc(var(--spacing) * 1.5)"
              paddingInline="calc(var(--spacing) * 2.5)"
              onClick={() => void copyComments()}
              aria-label={`Copy ${comments.length} comments as markdown`}
            >
              {copyState === 'copied' ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Copy failed'
                  : `Copy comments (${comments.length})`}
            </Button>
            {hasPanelContent && (
              <Button
                type="button"
                size="icon"
                variant={panelVisible ? 'secondary' : 'ghost'}
                width="calc(var(--spacing) * 8)"
                height="calc(var(--spacing) * 8)"
                {...stylex.props(rootLayoutStyles.toolbarNoShrink)}
                onClick={() => setPanelVisible((v) => !v)}
                aria-pressed={panelVisible}
                title={panelVisible ? 'Hide review thread' : 'Show review thread'}
              >
                <PanelRight className="size-4" />
              </Button>
            )}
          </div>

          <div {...stylex.props(rootLayoutStyles.content)}>
            {bundle.groups.length === 0 ? (
              <div {...stylex.props(rootLayoutStyles.empty)}>No review groups found.</div>
            ) : (
              <div {...stylex.props(rootLayoutStyles.groups)}>
                {bundle.document.title ||
                bundle.document.frontmatter.pr ||
                bundle.document.overview ? (
                  <section aria-label="Review summary" {...stylex.props(rootLayoutStyles.summary)}>
                    {bundle.document.title ? (
                      <div {...stylex.props(rootLayoutStyles.titleBlock)}>
                        <h1 {...stylex.props(rootLayoutStyles.title)}>{bundle.document.title}</h1>
                        {bundle.document.frontmatter.pr ? (
                          <a
                            href={bundle.document.frontmatter.pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            {...stylex.props(rootLayoutStyles.pullRequest)}
                          >
                            <ExternalLink {...stylex.props(rootLayoutStyles.externalIcon)} />
                            <span {...stylex.props(rootLayoutStyles.pullRequestNumber)}>
                              PR #{bundle.document.frontmatter.pr.number}
                            </span>
                            {bundle.document.frontmatter.pr.title &&
                            bundle.document.frontmatter.pr.title !== bundle.document.title ? (
                              <>
                                <span {...stylex.props(rootLayoutStyles.pullRequestSeparator)}>
                                  ·
                                </span>
                                <span {...stylex.props(rootLayoutStyles.pullRequestTitle)}>
                                  {bundle.document.frontmatter.pr.title}
                                </span>
                              </>
                            ) : null}
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                    {bundle.document.overview ? (
                      <SimpleMarkdown markdown={bundle.document.overview} tone="foreground" />
                    ) : null}
                  </section>
                ) : null}
                {bundle.groups.map((group, index) => (
                  <ReviewGroupSection
                    key={group.id}
                    index={index}
                    group={group}
                    diffStyle={activeDiffStyle}
                    commits={bundle.commits ?? {}}
                    files={bundle.files}
                    comments={comments}
                    reviewed={reviewed}
                    forceVisiblePaths={forceVisiblePaths}
                    forceExpandedPaths={forceExpandedPaths}
                    findingAnchorsByPath={findingAnchorsByPath}
                    highlightedRange={highlightedRange}
                    onToggleSnippetReviewed={toggleSnippetReviewed}
                    onToggleGroupReviewed={toggleGroupReviewed}
                    onStartDraft={startDraft}
                    onFocusComment={focusFromDiff}
                  />
                ))}
              </div>
            )}
          </div>
        </main>

        {showPanel && (
          <CommentPanel
            threads={fileThreads}
            total={threadTotal}
            findings={findings}
            files={bundle.files}
            focusedAnchor={focusedAnchor}
            draft={draft}
            onDraftBodyChange={updateDraftBody}
            onSaveDraft={saveDraft}
            onCancelDraft={cancelDraft}
            onDeleteComment={deleteComment}
            onFocus={focusFromPanel}
            onNavigate={scrollToFile}
            onJumpToRef={jumpToRef}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}

const renderErrorStyles = stylex.create({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 8)',
    color: 'hsl(var(--foreground))',
  },
  content: { maxWidth: 'var(--container-md)', textAlign: 'center' },
  title: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--tw-leading, var(--text-sm--line-height))',
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  description: {
    marginTop: 'calc(var(--spacing) * 1.5)',
    fontSize: '13px',
    '--tw-leading': 'var(--leading-relaxed)',
    lineHeight: 'var(--leading-relaxed)',
    color: 'hsl(var(--muted-foreground))',
  },
});

// Last-resort fallback if anything in the review subtree throws, so the viewer shows a
// message instead of a blank white page.
function ReviewRenderError() {
  return (
    <div className={cn('crh-shell dark', stylex.props(renderErrorStyles.root).className)}>
      <div {...stylex.props(renderErrorStyles.content)}>
        <p {...stylex.props(renderErrorStyles.title)}>
          Something went wrong rendering this review.
        </p>
        <p {...stylex.props(renderErrorStyles.description)}>
          Try reloading the page. If it keeps happening, the <code>.review.md</code> may reference
          lines that no longer exist in the diff.
        </p>
      </div>
    </div>
  );
}

function DiffStyleControl({
  diffStyle,
  onDiffStyleChange,
}: {
  readonly diffStyle: ReviewDiffStyle;
  readonly onDiffStyleChange: (diffStyle: ReviewDiffStyle) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={diffStyle}
      onValueChange={(value) => {
        if (value === 'unified' || value === 'split') {
          onDiffStyleChange(value);
        }
      }}
      aria-label="Diff view"
      className={stylex.props(rootLayoutStyles.diffControlHeight).className}
      gap="calc(var(--spacing) * 0.5)"
      padding="calc(var(--spacing) * 0.5)"
    >
      <ToggleGroupItem
        value="unified"
        aria-label="Unified diff"
        size="sm"
        gap="calc(var(--spacing) * 1.5)"
      >
        <Rows3 className="size-3.5" />
        Unified
      </ToggleGroupItem>
      <ToggleGroupItem
        value="split"
        aria-label="Split diff"
        size="sm"
        gap="calc(var(--spacing) * 1.5)"
      >
        <Columns2 className="size-3.5" />
        Split
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

const findingsStyles = stylex.create({
  section: { minWidth: 0 },
  headingRow: {
    marginBottom: 'calc(var(--spacing) * 2.5)',
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    'padding-inline': 'calc(var(--spacing) * 0.5)',
  },
  heading: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': '0.16em',
    letterSpacing: '0.16em',
    fontSize: '11px',
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
  },
  separator: {
    height: '1px',
    flex: '1',
    backgroundColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    },
  },
  list: { display: 'grid', gap: 'calc(var(--spacing) * 2)' },
  item: {
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border))',
    backgroundColor: {
      default: 'hsl(var(--card))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--card)) 60%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 3)',
    paddingBottom: 'calc(var(--spacing) * 2.5)',
    paddingTop: 'calc(var(--spacing) * 2)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  badge: {
    '--tw-leading': 1,
    lineHeight: 1,
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': 'var(--tracking-wide)',
    letterSpacing: 'var(--tracking-wide)',
    marginBottom: 'calc(var(--spacing) * 1.5)',
    display: 'inline-flex',
    height: '17px',
    alignItems: 'center',
    borderRadius: '0.25rem',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    fontSize: '10px',
    textTransform: 'uppercase',
  },
  body: {
    '--tw-leading': 1.7,
    lineHeight: 1.7,
    minWidth: 0,
    fontSize: '13px',
    color: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
    },
  },
  bodyBlocks: { display: 'grid', gap: 'calc(var(--spacing) * 1.5)' },
  refGlyph: { width: 'calc(var(--spacing) * 3)', height: 'calc(var(--spacing) * 3)' },
  refChip: {
    '--tw-leading': 1,
    lineHeight: 1,
    'margin-inline': '1px',
    display: 'inline-flex',
    maxWidth: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: '0.25rem',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--primary))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--primary)) 40%, transparent)',
        },
      },
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--muted))' },
    },
    'padding-inline': 'calc(var(--spacing) * 1)',
    'padding-block': '1px',
    verticalAlign: 'baseline',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
    color: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 85%, transparent)',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground))' },
    },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  refLabel: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden' },
  oldRefLabel: {
    '--tw-tracking': 'var(--tracking-wide)',
    letterSpacing: 'var(--tracking-wide)',
    fontSize: '8.5px',
    textTransform: 'uppercase',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted-foreground)) 80%, transparent)',
    },
  },
});

// Top-level `## Review` findings: cross-cutting P0/P1/P2 conclusions, each with
// clickable file-label chips that jump the center diff to the referenced location.
function ReviewFindingsSection({
  findings,
  files,
  onJump,
}: {
  readonly findings: readonly ReviewFinding[];
  readonly files: Record<string, ReviewResolvedFile>;
  readonly onJump: (ref: ReviewFindingRef) => void;
}) {
  if (findings.length === 0) {
    return null;
  }
  return (
    <section aria-label="Review findings" {...stylex.props(findingsStyles.section)}>
      <div {...stylex.props(findingsStyles.headingRow)}>
        <span {...stylex.props(findingsStyles.heading)}>Review</span>
        <span {...stylex.props(findingsStyles.separator)} />
      </div>
      <ul {...stylex.props(findingsStyles.list)}>
        {findings.map((finding) => (
          <FindingItem key={finding.id} finding={finding} files={files} onJump={onJump} />
        ))}
      </ul>
    </section>
  );
}

function findingSeverityLabel(severity: ReviewNoteSeverity): string {
  return severity === 'question' ? '?' : severity === 'info' ? 'info' : severity.toUpperCase();
}

function FindingItem({
  finding,
  files,
  onJump,
}: {
  readonly finding: ReviewFinding;
  readonly files: Record<string, ReviewResolvedFile>;
  readonly onJump: (ref: ReviewFindingRef) => void;
}) {
  return (
    <li
      id={findingDomId(finding.id)}
      className={cn('crh-finding', stylex.props(findingsStyles.item).className)}
    >
      <span {...stylex.props(findingsStyles.badge, SEVERITY_MARKER[finding.severity])}>
        {findingSeverityLabel(finding.severity)}
      </span>
      <div {...stylex.props(findingsStyles.body)}>
        <FindingBody markdown={finding.bodyMarkdown} files={files} onJump={onJump} />
      </div>
    </li>
  );
}

type MarkdownBlock =
  | MarkdownParagraphBlock
  | MarkdownListBlock
  | MarkdownHeadingBlock
  | MarkdownCodeBlock;

interface MarkdownParagraphBlock {
  readonly type: 'p';
  readonly text: string;
}

interface MarkdownListBlock {
  readonly type: 'ul';
  readonly items: string[];
}

interface MarkdownHeadingBlock {
  readonly type: 'heading';
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
}

interface MarkdownCodeBlock {
  readonly type: 'code';
  readonly code: string;
  readonly language?: string;
}

interface MarkdownFence {
  readonly indent: string;
  readonly marker: '`' | '~';
  readonly length: number;
  readonly language?: string;
}

interface LightMarkdownOptions {
  readonly headings?: boolean;
}

interface FindingInlineContext {
  readonly files: Record<string, ReviewResolvedFile>;
  readonly onJump: (ref: ReviewFindingRef) => void;
}

interface InlineRendererContext {
  readonly finding?: FindingInlineContext;
}

interface InlineCodeOptions {
  readonly className?: string;
}

interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language?: string;
}

function markdownCodeLanguageLabel(language: string | undefined): string {
  return language ? `${language} code block` : 'Code block';
}

function MarkdownCodeBlockView({ code, language }: MarkdownCodeBlockProps) {
  return (
    <pre
      className="crh-markdown-code"
      data-language={language}
      aria-label={markdownCodeLanguageLabel(language)}
    >
      <code>{code}</code>
    </pre>
  );
}

function normalizeFenceLanguage(info: string): string | undefined {
  const language = info
    .trim()
    .split(/\s+/u)[0]
    ?.replace(/^\{?\.?/u, '')
    .replace(/\}?$/u, '');
  return language && /^[A-Za-z0-9_+.#-]+$/u.test(language) ? language : undefined;
}

function matchMarkdownFence(line: string): MarkdownFence | null {
  const match = /^(\s*)(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match) {
    return null;
  }
  const markerRun = match[2] ?? '';
  const marker = markerRun[0] as '`' | '~';
  return {
    indent: match[1] ?? '',
    marker,
    length: markerRun.length,
    language: normalizeFenceLanguage(match[3] ?? ''),
  };
}

function isClosingMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trim();
  const match =
    fence.marker === '`' ? /^(`{3,})\s*$/u.exec(trimmed) : /^(~{3,})\s*$/u.exec(trimmed);
  return (match?.[1]?.length ?? 0) >= fence.length;
}

function stripFenceIndent(line: string, indent: string): string {
  return indent.length > 0 && line.startsWith(indent) ? line.slice(indent.length) : line;
}

// Lightweight Markdown block grouping shared by review summaries and finding bodies.
// It intentionally stays small for the standalone viewer, but preserves fenced code
// blocks so snippets do not collapse into paragraphs or lose whitespace.
function parseLightMarkdownBlocks(
  markdown: string,
  options: LightMarkdownOptions = {}
): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  let bullets: string[] | null = null;
  let fence: MarkdownFence | null = null;
  let codeLines: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: 'p', text: para.join(' ').trim() });
      para = [];
    }
  };
  const flushBullets = (): void => {
    if (bullets && bullets.length > 0) {
      blocks.push({ type: 'ul', items: bullets });
    }
    bullets = null;
  };
  const flushCode = (): void => {
    if (fence) {
      blocks.push({
        type: 'code',
        code: codeLines.join('\n'),
        ...(fence.language === undefined ? {} : { language: fence.language }),
      });
    }
    fence = null;
    codeLines = [];
  };

  for (const raw of markdown.split('\n')) {
    if (fence) {
      if (isClosingMarkdownFence(raw, fence)) {
        flushCode();
      } else {
        codeLines.push(stripFenceIndent(raw, fence.indent));
      }
      continue;
    }

    const nextFence = matchMarkdownFence(raw);
    if (nextFence) {
      flushPara();
      flushBullets();
      fence = nextFence;
      codeLines = [];
      continue;
    }

    const line = raw.trim();
    if (line === '') {
      flushPara();
      flushBullets();
      continue;
    }

    const heading = options.headings === false ? null : /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      flushPara();
      flushBullets();
      blocks.push({
        type: 'heading',
        depth: Math.min(heading[1]?.length ?? 1, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2] ?? '',
      });
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/u.exec(line);
    if (bullet) {
      flushPara();
      (bullets ??= []).push(bullet[1] ?? '');
    } else if (bullets) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line}`;
    } else {
      para.push(line);
    }
  }
  flushCode();
  flushPara();
  flushBullets();
  return blocks;
}

const markdownStyles = stylex.create({
  strong: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground))',
  },
  heading: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  compactHeading: {
    '--tw-leading': 'calc(var(--spacing) * 5)',
    fontSize: '13px',
    lineHeight: 'calc(var(--spacing) * 5)',
  },
  headingText: {
    '--tw-leading': 'calc(var(--spacing) * 6)',
    fontSize: { default: '15px', '@media (min-width: 48rem)': '16px' },
    lineHeight: 'calc(var(--spacing) * 6)',
  },
  list: { listStyleType: 'disc' },
  compactList: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 1)',
    paddingLeft: 'calc(var(--spacing) * 4)',
  },
  listInset: { paddingLeft: 'calc(var(--spacing) * 5)' },
  listSpace: {
    '--tw-space-y-reverse': 0,
    'margin-block-start': 'calc(calc(var(--spacing) * 1) * var(--tw-space-y-reverse))',
    'margin-block-end': 'calc(calc(var(--spacing) * 1) * calc(1 - var(--tw-space-y-reverse)))',
  },
  blockSpace: {
    '--tw-space-y-reverse': 0,
    'margin-block-start': 'calc(calc(var(--spacing) * 2) * var(--tw-space-y-reverse))',
    'margin-block-end': 'calc(calc(var(--spacing) * 2) * calc(1 - var(--tw-space-y-reverse)))',
  },
  findingCode: {
    borderRadius: '0.25rem',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 70%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 1)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '12px',
  },
  body: {
    '--tw-leading': '1.6',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  foreground: {
    color: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
    },
  },
  muted: { color: 'hsl(var(--muted-foreground))' },
  diagnostics: { display: 'grid', gap: 'calc(var(--spacing) * 2)' },
  diagnosticTitle: { textTransform: 'capitalize' },
});

function renderMarkdownInline(
  text: string,
  context: InlineRendererContext,
  keyPrefix: string,
  codeOptions: InlineCodeOptions = {}
): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`/gu;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] !== undefined) {
      parts.push(
        <strong key={`${keyPrefix}-${key}-b`} {...stylex.props(markdownStyles.strong)}>
          {match[1]}
        </strong>
      );
    } else {
      const token = match[2] ?? '';
      const finding = context.finding;
      const ref = finding ? parseReviewRef(token) : null;
      const isScheme = /^(old|new):\/\//iu.test(token.trim());
      if (finding && ref && (isScheme || finding.files[ref.path] !== undefined)) {
        parts.push(
          <FindingRefChip key={`${keyPrefix}-${key}-r`} refItem={ref} onJump={finding.onJump} />
        );
      } else {
        parts.push(
          <code key={`${keyPrefix}-${key}-c`} className={codeOptions.className}>
            {token}
          </code>
        );
      }
    }
    key += 1;
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function renderLightMarkdownBlock(
  block: MarkdownBlock,
  key: string,
  context: InlineRendererContext,
  options: {
    readonly compact?: boolean;
    readonly codeClassName?: string;
    readonly blockClassName?: string;
  } = {}
): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag: `h${1 | 2 | 3 | 4 | 5 | 6}` = `h${block.depth}`;
      return (
        <Tag
          key={key}
          className={cn(
            options.blockClassName,
            stylex.props(
              markdownStyles.heading,
              options.compact ? markdownStyles.compactHeading : markdownStyles.headingText
            ).className
          )}
        >
          {renderMarkdownInline(block.text, context, `${key}-h`, {
            className: options.codeClassName,
          })}
        </Tag>
      );
    }
    case 'ul':
      return (
        <ul
          key={key}
          className={cn(
            options.blockClassName,
            stylex.props(
              markdownStyles.list,
              options.compact ? markdownStyles.compactList : markdownStyles.listInset
            ).className
          )}
        >
          {block.items.map((item, itemIndex) => (
            <li
              key={itemIndex}
              {...stylex.props(
                !options.compact && itemIndex < block.items.length - 1 && markdownStyles.listSpace
              )}
            >
              {renderMarkdownInline(item, context, `${key}-${itemIndex}`, {
                className: options.codeClassName,
              })}
            </li>
          ))}
        </ul>
      );
    case 'code':
      return <MarkdownCodeBlockView key={key} code={block.code} language={block.language} />;
    case 'p':
    default:
      return (
        <p key={key} className={options.blockClassName}>
          {renderMarkdownInline(block.text, context, key, { className: options.codeClassName })}
        </p>
      );
  }
}

function FindingBody({
  markdown,
  files,
  onJump,
}: {
  readonly markdown: string;
  readonly files: Record<string, ReviewResolvedFile>;
  readonly onJump: (ref: ReviewFindingRef) => void;
}) {
  const blocks = parseLightMarkdownBlocks(markdown, { headings: false });
  return (
    <div {...stylex.props(findingsStyles.bodyBlocks)}>
      {blocks.map((block, index) =>
        renderLightMarkdownBlock(
          block,
          String(index),
          { finding: { files, onJump } },
          {
            compact: true,
            codeClassName: stylex.props(markdownStyles.findingCode).className,
          }
        )
      )}
    </div>
  );
}

function FindingRefChip({
  refItem,
  onJump,
}: {
  readonly refItem: ReviewFindingRef;
  readonly onJump: (ref: ReviewFindingRef) => void;
}) {
  const lineLabel = refItem.range
    ? `:${refItem.range.start}${
        refItem.range.end !== refItem.range.start ? `-${refItem.range.end}` : ''
      }`
    : '';
  return (
    <button
      type="button"
      onClick={() => onJump(refItem)}
      title={`Jump to ${refItem.path}${refItem.range ? ` line ${refItem.range.start}` : ''}`}
      className={cn(
        'crh-ref-chip translate-y-[0.18em]',
        stylex.props(findingsStyles.refChip).className
      )}
    >
      <FileIcon filePath={refItem.path} {...stylex.props(findingsStyles.refGlyph)} />
      <span {...stylex.props(findingsStyles.refLabel)}>
        {fileBaseName(refItem.path)}
        {lineLabel}
      </span>
      {refItem.side === 'old' ? (
        <span {...stylex.props(findingsStyles.oldRefLabel)}>old</span>
      ) : null}
    </button>
  );
}

const groupSectionStyles = stylex.create({
  section: {
    display: 'flex',
    minWidth: 0,
    flexDirection: 'column',
    gap: 'calc(var(--spacing) * 3.5)',
    borderTopStyle: 'var(--tw-border-style)',
    borderTopWidth: '1px',
    borderColor: 'hsl(var(--border))',
    paddingTop: 'calc(var(--spacing) * 6)',
  },
  header: {
    position: 'sticky',
    top: 'var(--crh-toolbar-h)',
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 3)',
    backgroundColor: 'hsl(var(--background))',
    'padding-block': 'calc(var(--spacing) * 2.5)',
  },
  headingRow: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
  },
  index: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 10%, transparent)',
    },
    fontSize: '13px',
    color: 'hsl(var(--foreground))',
  },
  heading: {
    '--tw-leading': 'var(--leading-snug)',
    lineHeight: {
      default: 'var(--leading-snug)',
      '@media (width >= 48rem)': 'var(--tw-leading,var(--text-lg--line-height))',
    },
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': 'var(--tracking-tight)',
    letterSpacing: 'var(--tracking-tight)',
    minWidth: 0,
    overflowWrap: 'break-word',
    fontSize: { default: '17px', '@media (width >= 48rem)': 'var(--text-lg)' },
  },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
  stats: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '12px',
  },
  additions: { color: 'hsl(var(--github-addition))' },
  deletions: { color: 'hsl(var(--github-deletion))' },
  fileCount: { fontSize: '12px', color: 'hsl(var(--muted-foreground))' },
  body: { display: 'grid', minWidth: 0, gap: 'calc(var(--spacing) * 3.5)' },
  files: { display: 'grid', gap: 'calc(var(--spacing) * 3)' },
});

const ReviewGroupSection = memo(function ReviewGroupSection({
  index,
  group,
  diffStyle,
  commits,
  files,
  comments,
  reviewed,
  forceVisiblePaths,
  forceExpandedPaths,
  findingAnchorsByPath,
  highlightedRange,
  onToggleSnippetReviewed,
  onToggleGroupReviewed,
  onStartDraft,
  onFocusComment,
}: {
  readonly index: number;
  readonly group: ReviewResolvedGroup;
  readonly diffStyle: ReviewDiffStyle;
  readonly commits: Record<string, ReviewResolvedCommit>;
  readonly files: Record<string, ReviewResolvedFile>;
  readonly comments: readonly ReviewUserComment[];
  readonly reviewed: ReadonlySet<string>;
  readonly forceVisiblePaths: ReadonlySet<string>;
  readonly forceExpandedPaths: ReadonlySet<string>;
  readonly findingAnchorsByPath: ReadonlyMap<string, readonly FindingAnchor[]>;
  readonly highlightedRange: HighlightSelection | null;
  readonly onToggleSnippetReviewed: (snippetId: string, checked: boolean) => void;
  readonly onToggleGroupReviewed: (snippetIds: readonly string[], checked: boolean) => void;
  readonly onStartDraft: (path: string, side: ReviewSide, lineNumber: number) => void;
  readonly onFocusComment: (anchor: string) => void;
}) {
  const summaryMarkdown = stripGroupMetadataMarkdown(group.bodyMarkdown);
  const headingId = `${groupDomId(group.id)}-heading`;
  const groupBlockIds = useMemo(() => group.blocks.map((block) => block.id), [group.blocks]);
  const reviewState = snippetsCheckState(reviewed, groupBlockIds);
  const groupFilePaths = useMemo(
    () => [...new Set(group.blocks.map((block) => block.path))],
    [group.blocks]
  );
  const groupFiles = useMemo(
    () =>
      groupFilePaths
        .map((path) => files[path])
        .filter((file): file is ReviewResolvedFile => file !== undefined),
    [groupFilePaths, files]
  );
  const groupStats = useMemo(() => sumFileStats(groupFiles), [groupFiles]);

  const onReviewedChange = useCallback(
    (checked: boolean) => onToggleGroupReviewed(groupBlockIds, checked),
    [groupBlockIds, onToggleGroupReviewed]
  );

  // Bulk collapse/expand all file blocks in this group (from the ⋯ menu). The
  // bumped nonce signals every block; `.collapsed` is the target state.
  const [bulkCollapse, setBulkCollapse] = useState({ nonce: 0, collapsed: false });
  const collapseAll = useCallback(
    () => setBulkCollapse((prev) => ({ nonce: prev.nonce + 1, collapsed: true })),
    []
  );
  const expandAll = useCallback(
    () => setBulkCollapse((prev) => ({ nonce: prev.nonce + 1, collapsed: false })),
    []
  );

  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // Keep nested file block headers sticky below this group header by exposing
  // the header height as a CSS variable scoped to this section.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const header = headerRef.current;
    if (!section || !header) {
      return undefined;
    }
    const sync = () => {
      section.style.setProperty('--crh-group-header-h', `${header.offsetHeight}px`);
    };
    sync();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    return observeResizeOnAnimationFrame(header, () => sync());
  }, []);

  return (
    <section
      ref={sectionRef}
      id={groupDomId(group.id)}
      data-group-id={group.id}
      aria-labelledby={headingId}
      className={cn('crh-group-section', stylex.props(groupSectionStyles.section).className)}
    >
      <header
        ref={headerRef}
        className={cn('crh-group-header', stylex.props(groupSectionStyles.header).className)}
      >
        <div {...stylex.props(groupSectionStyles.headingRow)}>
          <span {...stylex.props(groupSectionStyles.index)}>{index + 1}</span>
          <span id={headingId} {...stylex.props(groupSectionStyles.heading)}>
            {group.title}
          </span>
        </div>
        <div {...stylex.props(groupSectionStyles.actions)}>
          <span {...stylex.props(groupSectionStyles.stats)}>
            <span {...stylex.props(groupSectionStyles.additions)}>+{groupStats.additions}</span>{' '}
            <span {...stylex.props(groupSectionStyles.deletions)}>−{groupStats.deletions}</span>
          </span>
          <span {...stylex.props(groupSectionStyles.fileCount)}>{groupFiles.length} files</span>
          <GroupMenu
            reviewState={reviewState}
            onMarkAllViewed={() => onReviewedChange(true)}
            onUnmarkAll={() => onReviewedChange(false)}
            onCollapseAll={collapseAll}
            onExpandAll={expandAll}
          />
        </div>
      </header>

      <div {...stylex.props(groupSectionStyles.body)}>
        {summaryMarkdown.length > 0 && (
          <SimpleMarkdown markdown={summaryMarkdown} tone="foreground" />
        )}

        <GroupCommits refs={group.commits} commits={commits} />

        {group.diagnostics.length > 0 && <Diagnostics diagnostics={group.diagnostics} />}

        <div {...stylex.props(groupSectionStyles.files)}>
          {group.blocks.map((block) => (
            <ReviewDiffBlock
              key={block.id}
              block={block}
              diffStyle={diffStyle}
              comments={comments}
              reviewed={reviewed.has(block.id)}
              forceVisible={forceVisiblePaths.has(block.path)}
              forceExpanded={forceExpandedPaths.has(block.path)}
              bulkCollapse={bulkCollapse}
              findingAnchors={findingAnchorsByPath.get(block.path) ?? EMPTY_FINDING_ANCHORS}
              selectedLines={highlightedRange?.path === block.path ? highlightedRange.lines : null}
              onToggleReviewed={onToggleSnippetReviewed}
              onStartDraft={onStartDraft}
              onFocusComment={onFocusComment}
            />
          ))}
        </div>
      </div>
    </section>
  );
});

const checkboxStyles = stylex.create({
  input: {
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    margin: 'calc(var(--spacing) * 0)',
    cursor: 'pointer',
    opacity: 0,
  },
  glyph: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
  },
});

function Checkbox({
  state,
  onChange,
  ariaLabel,
  className,
}: {
  readonly state: ReviewCheckState;
  readonly onChange: (checked: boolean) => void;
  readonly ariaLabel?: string;
  readonly className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const checked = state === 'checked';
  const indeterminate = state === 'indeterminate';
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);
  return (
    <span
      className={cn(
        'relative inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
        checked || indeterminate
          ? 'border-foreground bg-foreground text-background'
          : 'border-foreground/30 bg-transparent hover:border-foreground/60',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-background',
        className
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.currentTarget.checked)}
        onClick={(event) => event.stopPropagation()}
        className={stylex.props(checkboxStyles.input).className}
      />
      {indeterminate ? (
        <Minus className={stylex.props(checkboxStyles.glyph).className} strokeWidth={3.5} />
      ) : checked ? (
        <Check className={stylex.props(checkboxStyles.glyph).className} strokeWidth={3.5} />
      ) : null}
    </span>
  );
}

const reviewCheckStyles = stylex.create({
  base: {
    display: 'flex',
    flexShrink: 0,
    cursor: 'pointer',
    userSelect: 'none',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    fontSize: '11px',
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
  },
});

function ReviewCheck({
  state,
  onChange,
  label,
}: {
  readonly state: ReviewCheckState;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label
      className={cn(
        stylex.props(reviewCheckStyles.base).className,
        'transition-colors hover:bg-foreground/5 hover:text-foreground has-[:checked]:border-foreground/30 has-[:checked]:bg-foreground/10 has-[:checked]:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/45'
      )}
    >
      <Checkbox state={state} onChange={onChange} ariaLabel={label} />
      {label}
    </label>
  );
}

function GroupMenu({
  reviewState,
  onMarkAllViewed,
  onUnmarkAll,
  onCollapseAll,
  onExpandAll,
}: {
  readonly reviewState: ReviewCheckState;
  readonly onMarkAllViewed: () => void;
  readonly onUnmarkAll: () => void;
  readonly onCollapseAll: () => void;
  readonly onExpandAll: () => void;
}) {
  const allViewed = reviewState === 'checked';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          width="calc(var(--spacing) * 7)"
          height="calc(var(--spacing) * 7)"
          labelColor="var(--crh-muted-button-label)"
          className={stylex.props(privateButtonStyles.mutedInk).className}
          aria-label="Group actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>This group</DropdownMenuLabel>
        {allViewed ? (
          <DropdownMenuItem onSelect={onUnmarkAll}>
            <Square />
            Unmark all files
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onMarkAllViewed}>
            <CheckCheck />
            Mark all files viewed
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCollapseAll}>
          <ChevronsDownUp />
          Collapse all files
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExpandAll}>
          <ChevronsUpDown />
          Expand all files
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnResizer({
  side,
  label,
  offset,
  onResize,
  onStep,
}: {
  readonly side: 'left' | 'right';
  readonly label: string;
  readonly offset: number;
  readonly onResize: (clientX: number) => void;
  readonly onStep: (delta: number) => void;
}) {
  const draggingRef = useRef(false);
  const [active, setActive] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      style={side === 'left' ? { left: `${offset}px` } : { right: `${offset}px` }}
      className={cn(
        'crh-resizer',
        stylex.props(rootLayoutStyles.resizerVisibility).className,
        side === 'left' ? 'crh-resizer-left' : 'crh-resizer-right',
        active && 'crh-resizer-active'
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // ignore: synthetic events / unsupported environments
        }
        draggingRef.current = true;
        setActive(true);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) {
          onResize(event.clientX);
        }
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        setActive(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setActive(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onStep(side === 'left' ? -16 : 16);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onStep(side === 'left' ? 16 : -16);
        }
      }}
    />
  );
}

const treeCommitStyles = stylex.create({
  tree: {
    'margin-inline': 'calc(var(--spacing) * -1)',
    display: 'grid',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  heading: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': '0.14em',
    letterSpacing: '0.14em',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-bottom': 'calc(var(--spacing) * 1)',
    fontSize: '10px',
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
  },
  dirContainer: {
    minWidth: 'calc(var(--spacing) * 0)',
  },
  treeRow: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'var(--radius)',
    'padding-block': 'calc(var(--spacing) * 1)',
    'padding-right': 'calc(var(--spacing) * 2)',
    backgroundColor: {
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--foreground))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
        },
      },
    },
  },
  dirToggle: {
    display: 'flex',
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(var(--radius) - 2px)',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': {
        ':hover': 'hsl(var(--foreground))',
      },
    },
  },
  fileGlyph: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  treeChevron: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
  },
  folderButton: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    textAlign: 'left',
  },
  folderGlyph: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  folderLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '13px',
    color: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 85%, transparent)',
    },
  },
  leafSpacer: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
  },
  fileButton: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    textAlign: 'left',
  },
  fileLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '13px',
  },
  fileLabelChecked: {
    color: 'hsl(var(--muted-foreground))',
  },
  fileLabelUnchecked: {
    color: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
    },
  },
  stats: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    '--tw-leading': '1',
    lineHeight: '1',
    'margin-left': 'auto',
    flexShrink: 0,
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '10px',
  },
  additions: {
    color: 'hsl(var(--github-addition))',
  },
  deletions: {
    color: 'hsl(var(--github-deletion))',
  },
  commitsToggle: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-tracking': '0.1em',
    letterSpacing: '0.1em',
    'margin-bottom': 'calc(var(--spacing) * 1.5)',
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '10px',
    textTransform: 'uppercase',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': {
        ':hover': 'hsl(var(--foreground))',
      },
    },
  },
  commitsChevron: {
    width: 'calc(var(--spacing) * 3)',
    height: 'calc(var(--spacing) * 3)',
  },
  commitList: {
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 70%, transparent)',
    },
  },
  showMore: {
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderTopStyle: 'var(--tw-border-style)',
    borderTopWidth: '1px',
    borderColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 30%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--foreground))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
        },
      },
    },
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    fontSize: '11px',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': {
        ':hover': 'hsl(var(--foreground))',
      },
    },
  },
  summary: {
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
  },
  subject: {
    '--tw-leading': 'var(--leading-tight)',
    lineHeight: 'var(--leading-tight)',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12.5px',
    color: 'hsl(var(--foreground))',
  },
  author: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  commitFrame: {
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: {
      default: '1px',
      ':last-child': 0,
    },
    borderColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--card))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--card)) 40%, transparent)',
    },
  },
  commitRow: {
    display: 'flex',
    width: '100%',
    minWidth: 'calc(var(--spacing) * 0)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
    backgroundColor: {
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--foreground))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
        },
      },
    },
  },
  summaryButton: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    borderRadius: 'calc(var(--radius) - 2px)',
    textAlign: 'left',
  },
  commitChevron: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  bodylessSummary: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    textAlign: 'left',
  },
  summarySpacer: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
  tooltipBody: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 2)',
    padding: 'calc(var(--spacing) * 3)',
  },
  tooltipSubject: {
    '--tw-leading': 'var(--leading-snug)',
    lineHeight: 'var(--leading-snug)',
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
    fontSize: '12.5px',
    color: 'hsl(var(--foreground))',
  },
  tooltipMetadata: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  tooltipAuthor: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tooltipMessage: {
    '--tw-leading': 'calc(var(--spacing) * 5)',
    lineHeight: 'calc(var(--spacing) * 5)',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 6,
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    fontSize: '11.5px',
    color: 'hsl(var(--muted-foreground))',
  },
  tooltipSha: {
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '10.5px',
    color: 'hsl(var(--muted-foreground))',
  },
  copyButton: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': {
        ':hover': 'hsl(var(--foreground))',
      },
    },
  },
  commitControlFocus: {
    '--tw-outline-style': 'none',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    '--tw-ring-shadow': {
      default: null,
      ':focus-visible':
        'var(--tw-ring-inset,) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color,currentcolor)',
    },
    '--tw-ring-color': {
      default: null,
      ':focus-visible': {
        default: 'hsl(var(--ring))',
        '@supports (color: color-mix(in lab, red, red))':
          'color-mix(in oklab, hsl(var(--ring)) 45%, transparent)',
      },
    },
    boxShadow: {
      default: null,
      ':focus-visible':
        'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',
    },
  },
  commitControlInset: {
    '--tw-ring-inset': { default: null, ':focus-visible': 'inset' },
  },
  commitTransitionColors: {
    transitionProperty:
      'color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to',
    transitionTimingFunction: 'var(--tw-ease,var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration,var(--default-transition-duration))',
  },
  collapsedChevron: { rotate: '-90deg' },
  commitTransitionTransform: {
    transitionProperty: 'transform,translate,scale,rotate',
    transitionTimingFunction: 'var(--tw-ease,var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration,var(--default-transition-duration))',
  },
  copiedGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    color: 'hsl(var(--primary))',
  },
  copyGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
  },
  expandedBody: {
    '--tw-leading': 'calc(var(--spacing) * 5)',
    lineHeight: 'calc(var(--spacing) * 5)',
    whiteSpace: 'pre-wrap',
    borderTopStyle: 'var(--tw-border-style)',
    borderTopWidth: '1px',
    borderColor: {
      default: 'hsl(var(--border))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--border)) 40%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    fontSize: '12px',
    color: 'hsl(var(--muted-foreground))',
  },
  avatar: {
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    display: 'flex',
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '3.40282e38px',
    fontSize: '10px',
    color: 'var(--color-white)',
  },
});

function FileTree({
  nodes,
  reviewed,
  fileStats,
  onToggle,
  onNavigate,
}: {
  readonly nodes: readonly FileTreeNode[];
  readonly reviewed: ReadonlySet<string>;
  readonly fileStats: ReadonlyMap<string, { additions: number; deletions: number }>;
  readonly onToggle: (node: FileTreeNode, checked: boolean) => void;
  readonly onNavigate: (path: string) => void;
}) {
  if (nodes.length === 0) {
    return null;
  }
  return (
    <nav {...stylex.props(treeCommitStyles.tree)} aria-label="Changed files">
      <p {...stylex.props(treeCommitStyles.heading)}>Files</p>
      {nodes.map((node) => (
        <FileTreeRow
          key={node.path}
          node={node}
          depth={0}
          reviewed={reviewed}
          fileStats={fileStats}
          onToggle={onToggle}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

function FileTreeRow({
  node,
  depth,
  reviewed,
  fileStats,
  onToggle,
  onNavigate,
}: {
  readonly node: FileTreeNode;
  readonly depth: number;
  readonly reviewed: ReadonlySet<string>;
  readonly fileStats: ReadonlyMap<string, { additions: number; deletions: number }>;
  readonly onToggle: (node: FileTreeNode, checked: boolean) => void;
  readonly onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const state = nodeCheckState(reviewed, node);
  const indent = depth * 14;

  if (node.type === 'dir') {
    return (
      <div {...stylex.props(treeCommitStyles.dirContainer)}>
        <div
          style={{ paddingLeft: `${indent + 8}px` }}
          className={
            stylex.props(treeCommitStyles.treeRow, treeCommitStyles.commitTransitionColors)
              .className
          }
        >
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            {...stylex.props(
              treeCommitStyles.dirToggle,
              treeCommitStyles.commitControlFocus,
              treeCommitStyles.commitTransitionColors
            )}
          >
            <ChevronDown
              className={cn(
                stylex.props(
                  treeCommitStyles.treeChevron,
                  treeCommitStyles.commitTransitionTransform,
                  !open && treeCommitStyles.collapsedChevron
                ).className
              )}
            />
          </button>
          <Checkbox
            state={state}
            onChange={(checked) => onToggle(node, checked)}
            ariaLabel={`Mark ${node.name} reviewed`}
          />
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            {...stylex.props(treeCommitStyles.folderButton, treeCommitStyles.commitControlFocus)}
          >
            <Folder {...stylex.props(treeCommitStyles.folderGlyph)} />
            <span {...stylex.props(treeCommitStyles.folderLabel)}>{node.name}</span>
          </button>
        </div>
        {open &&
          node.children.map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              reviewed={reviewed}
              fileStats={fileStats}
              onToggle={onToggle}
              onNavigate={onNavigate}
            />
          ))}
      </div>
    );
  }

  const stats = fileStats.get(node.path);

  return (
    <div
      style={{ paddingLeft: `${indent + 8}px` }}
      className={
        stylex.props(treeCommitStyles.treeRow, treeCommitStyles.commitTransitionColors).className
      }
    >
      <span aria-hidden {...stylex.props(treeCommitStyles.leafSpacer)} />
      <Checkbox
        state={state}
        onChange={(checked) => onToggle(node, checked)}
        ariaLabel={`Mark ${node.name} reviewed`}
      />
      <button
        type="button"
        onClick={() => onNavigate(node.path)}
        title={node.path}
        {...stylex.props(treeCommitStyles.fileButton, treeCommitStyles.commitControlFocus)}
      >
        <FileIcon filePath={node.path} {...stylex.props(treeCommitStyles.fileGlyph)} />
        <span
          className={cn(
            stylex.props(treeCommitStyles.fileLabel).className,
            state === 'checked'
              ? stylex.props(treeCommitStyles.fileLabelChecked).className
              : stylex.props(treeCommitStyles.fileLabelUnchecked).className
          )}
        >
          {node.name}
        </span>
        {stats ? (
          <span {...stylex.props(treeCommitStyles.stats)}>
            <span {...stylex.props(treeCommitStyles.additions)}>+{stats.additions}</span>{' '}
            <span {...stylex.props(treeCommitStyles.deletions)}>−{stats.deletions}</span>
          </span>
        ) : null}
      </button>
    </div>
  );
}

const VISIBLE_COMMITS = 4;

function GroupCommits({
  refs,
  commits,
}: {
  readonly refs: readonly string[];
  readonly commits: Record<string, ReviewResolvedCommit>;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  if (refs.length === 0) {
    return null;
  }
  const overflowing = refs.length > VISIBLE_COMMITS;
  const visibleRefs = !open ? [] : expanded ? refs : refs.slice(0, VISIBLE_COMMITS);
  const hiddenCount = refs.length - VISIBLE_COMMITS;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          stylex.props(
            treeCommitStyles.commitsToggle,
            treeCommitStyles.commitControlFocus,
            treeCommitStyles.commitTransitionColors
          ).className
        )}
      >
        <ChevronDown
          className={cn(
            stylex.props(
              treeCommitStyles.commitsChevron,
              treeCommitStyles.commitTransitionTransform,
              !open && treeCommitStyles.collapsedChevron
            ).className
          )}
        />
        {refs.length} {refs.length === 1 ? 'commit' : 'commits'}
      </button>
      {open && (
        <TooltipProvider delayDuration={250} disableHoverableContent>
          <div {...stylex.props(treeCommitStyles.commitList)}>
            {visibleRefs.map((commitRef) => (
              <CommitRow key={commitRef} commitRef={commitRef} commit={commits?.[commitRef]} />
            ))}
            {overflowing && (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className={cn(
                  stylex.props(
                    treeCommitStyles.showMore,
                    treeCommitStyles.commitControlFocus,
                    treeCommitStyles.commitControlInset,
                    treeCommitStyles.commitTransitionColors
                  ).className
                )}
              >
                {expanded
                  ? 'Show fewer commits'
                  : `Show ${hiddenCount} more ${hiddenCount === 1 ? 'commit' : 'commits'}`}
              </button>
            )}
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}

function CommitRow({
  commitRef,
  commit,
}: {
  readonly commitRef: string;
  readonly commit: ReviewResolvedCommit | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sha = commit?.sha ?? commitRef;
  const shortSha = commit?.shortSha ?? commitRef.slice(0, 10);
  const subject = commit?.subject ?? commitRef;
  const author = commit?.authorName ?? '';
  const body = commit?.body?.trim() ?? '';
  const date = commit?.authorDate ? commit.authorDate.slice(0, 10) : '';
  const seed = commit?.authorEmail ?? commitRef;
  // Only commits with a message body are collapsible; bodyless ones render as a plain,
  // non-expandable row (no chevron, no toggle).
  const hasBody = body.length > 0;

  const summary = (
    <>
      <CommitAvatar name={author} seed={seed} />
      <span {...stylex.props(treeCommitStyles.summary)}>
        <span {...stylex.props(treeCommitStyles.subject)}>{subject}</span>
        {author ? (
          <span {...stylex.props(treeCommitStyles.author)}>
            {author}
            {date ? ` · ${date}` : ''}
          </span>
        ) : null}
      </span>
    </>
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }, [sha]);

  return (
    <div {...stylex.props(treeCommitStyles.commitFrame)}>
      <div {...stylex.props(treeCommitStyles.commitRow, treeCommitStyles.commitTransitionColors)}>
        <Tooltip>
          <TooltipTrigger asChild>
            {hasBody ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                {...stylex.props(
                  treeCommitStyles.summaryButton,
                  treeCommitStyles.commitControlFocus
                )}
              >
                <ChevronDown
                  className={cn(
                    stylex.props(
                      treeCommitStyles.commitChevron,
                      treeCommitStyles.commitTransitionTransform,
                      !expanded && treeCommitStyles.collapsedChevron
                    ).className
                  )}
                />
                {summary}
              </button>
            ) : (
              <div {...stylex.props(treeCommitStyles.bodylessSummary)}>
                {/* Spacer keeps the avatar/subject aligned with collapsible rows. */}
                <span aria-hidden {...stylex.props(treeCommitStyles.summarySpacer)} />
                {summary}
              </div>
            )}
          </TooltipTrigger>
          <TooltipContent side="left" align="start" className="w-72 max-w-[18rem] p-0">
            <div {...stylex.props(treeCommitStyles.tooltipBody)}>
              <p {...stylex.props(treeCommitStyles.tooltipSubject)}>{subject}</p>
              <p {...stylex.props(treeCommitStyles.tooltipMetadata)}>
                <CommitAvatar name={author} seed={seed} />
                <span {...stylex.props(treeCommitStyles.tooltipAuthor)}>
                  {author || 'Unknown author'}
                  {date ? ` · ${date}` : ''}
                </span>
              </p>
              {body ? <p {...stylex.props(treeCommitStyles.tooltipMessage)}>{body}</p> : null}
              <code {...stylex.props(treeCommitStyles.tooltipSha)}>{sha}</code>
            </div>
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy commit id ${shortSha}`}
          title="Copy commit id"
          {...stylex.props(
            treeCommitStyles.copyButton,
            treeCommitStyles.commitControlFocus,
            treeCommitStyles.commitTransitionColors
          )}
        >
          {shortSha}
          {copied ? (
            <Check {...stylex.props(treeCommitStyles.copiedGlyph)} />
          ) : (
            <Copy {...stylex.props(treeCommitStyles.copyGlyph)} />
          )}
        </button>
      </div>
      {hasBody && expanded && <div {...stylex.props(treeCommitStyles.expandedBody)}>{body}</div>}
    </div>
  );
}

function CommitAvatar({ name, seed }: { readonly name: string; readonly seed: string }) {
  const initials = getInitials(name);
  const hue = hashHue(seed);
  return (
    <span
      aria-hidden
      {...stylex.props(treeCommitStyles.avatar)}
      style={{ backgroundColor: `hsl(${hue} 42% 40%)` }}
    >
      {initials}
    </span>
  );
}

const diffBlockStyles = stylex.create({
  block: {
    minWidth: 'calc(var(--spacing) * 0)',
    borderRadius: 'var(--radius)',
    transitionProperty: 'opacity',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  collapsed: { overflow: 'hidden' },
  reviewed: { opacity: 0.65 },
  header: {
    position: 'sticky',
    top: 'calc(var(--crh-toolbar-h) + var(--crh-group-header-h,0px))',
    zIndex: 10,
  },
  headerInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 2.5)',
    'border-top-left-radius': 'var(--radius)',
    'border-top-right-radius': 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  bottomCorners: {
    'border-bottom-right-radius': 'var(--radius)',
    'border-bottom-left-radius': 'var(--radius)',
  },
  toggle: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'calc(var(--radius) - 2px)',
    textAlign: 'left',
  },
  fileGlyph: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
  chevron: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    transitionProperty: 'transform, translate, scale, rotate',
    transitionTimingFunction: 'var(--tw-ease, var(--default-transition-timing-function))',
    transitionDuration: 'var(--tw-duration, var(--default-transition-duration))',
  },
  path: {
    '--tw-font-weight': 'var(--font-weight-medium)',
    fontWeight: 'var(--font-weight-medium)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '12.5px',
    color: 'hsl(var(--foreground))',
  },
  tools: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
  },
  stats: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  additions: { color: 'hsl(var(--github-addition))' },
  deletions: { color: 'hsl(var(--github-deletion))' },
  body: {
    overflow: 'hidden',
    'border-inline-style': 'var(--tw-border-style)',
    'border-inline-width': '1px',
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
  },
  parseErrorPadding: { padding: 'calc(var(--spacing) * 3)' },
  diagnostics: {
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 30%, transparent)',
    },
    padding: 'calc(var(--spacing) * 2.5)',
  },
});

const contextBlockStyles = stylex.create({
  root: { borderTopStyle: 'var(--tw-border-style)', borderTopWidth: '1px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 20%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'padding-block': 'calc(var(--spacing) * 1)',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  icon: { width: 'calc(var(--spacing) * 3)', height: 'calc(var(--spacing) * 3)' },
  scroll: { overflowX: 'auto', padding: 'calc(var(--spacing) * 2)' },
  table: {
    '--tw-leading': 'calc(var(--spacing) * 5)',
    lineHeight: 'calc(var(--spacing) * 5)',
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '12.5px',
  },
  range: {
    backgroundColor: {
      default: 'hsl(var(--foreground))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground)) 5%, transparent)',
    },
  },
  lineNumber: {
    width: 'calc(var(--spacing) * 12)',
    minWidth: 'calc(var(--spacing) * 12)',
    userSelect: 'none',
    'padding-right': 'calc(var(--spacing) * 3)',
    textAlign: 'right',
    color: 'hsl(var(--muted-foreground))',
  },
  source: { whiteSpace: 'pre', color: 'hsl(var(--foreground))' },
  status: {
    '--tw-tracking': 'var(--tracking-wide)',
    letterSpacing: 'var(--tracking-wide)',
    flexShrink: 0,
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '10px',
    textTransform: 'uppercase',
    color: 'hsl(var(--muted-foreground))',
  },
});

const ReviewDiffBlock = memo(function ReviewDiffBlock({
  block,
  diffStyle,
  comments,
  reviewed,
  forceVisible,
  forceExpanded,
  bulkCollapse,
  findingAnchors,
  selectedLines,
  onToggleReviewed,
  onStartDraft,
  onFocusComment,
}: {
  readonly block: ReviewResolvedBlock;
  readonly diffStyle: ReviewDiffStyle;
  readonly comments: readonly ReviewUserComment[];
  readonly reviewed: boolean;
  readonly forceVisible: boolean;
  readonly forceExpanded: boolean;
  readonly bulkCollapse: { readonly nonce: number; readonly collapsed: boolean };
  readonly findingAnchors: readonly FindingAnchor[];
  readonly selectedLines: {
    readonly start: number;
    readonly end: number;
    readonly side: PierreSide;
  } | null;
  readonly onToggleReviewed: (snippetId: string, checked: boolean) => void;
  readonly onStartDraft: (path: string, side: ReviewSide, lineNumber: number) => void;
  readonly onFocusComment: (anchor: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Collapse follows the (shared) reviewed state so checking a file/folder in
  // the sidebar collapses its snippets here; the chevron still toggles manually.
  useEffect(() => setCollapsed(reviewed), [reviewed]);
  // Group-level "collapse all / expand all" (from the group ⋯ menu) drives every
  // block via a bumped nonce, without marking them reviewed.
  useEffect(() => {
    if (bulkCollapse.nonce > 0) {
      setCollapsed(bulkCollapse.collapsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkCollapse.nonce]);
  // Panel-initiated navigation can force a block to render/expand synchronously.
  // We also persist the expansion by clearing the local collapsed state so the
  // block does not snap shut when the temporary force flag is released.
  useEffect(() => {
    if (forceExpanded) {
      setCollapsed(false);
    }
  }, [forceExpanded]);
  const isExpanded = forceExpanded || !collapsed;
  const fileComments = useMemo(
    () => comments.filter((comment) => comment.anchor.path === block.path),
    [comments, block.path]
  );
  const annotations = useMemo(
    () => buildLineAnnotations(block, fileComments, findingAnchors),
    [block, fileComments, findingAnchors]
  );
  // Highlight the referenced line range when this block is a finding-ref jump target.
  // Validate the range against the file on the requested side first: an out-of-range
  // selection makes @pierre's LineSelectionManager throw ("No valid rowRange").
  const pierreSelectedLines = useMemo(() => {
    if (!selectedLines) {
      return null;
    }
    const text = selectedLines.side === 'deletions' ? block.file?.oldText : block.file?.newText;
    const lineCount = text ? countLines(text) : 0;
    const { start, end } = selectedLines;
    if (start < 1 || end < start || (lineCount > 0 && end > lineCount)) {
      return null;
    }
    return { start, end, side: selectedLines.side, endSide: selectedLines.side };
  }, [selectedLines, block.file]);
  // @pierre throws on selecting a line it hasn't rendered (collapsed unchanged regions),
  // and that throw fires inside its async highlight pipeline where an Error Boundary
  // can't catch it. So we only hand it a selection once we've confirmed every line of
  // the range is actually present in the rendered (shadow-DOM) diff. See the effect after
  // `shouldRender`.
  const [verifiedSelection, setVerifiedSelection] = useState<{
    start: number;
    end: number;
    side: PierreSide;
    endSide: PierreSide;
  } | null>(null);
  // Lazily mount the (expensive) diff only once the block nears the viewport, so a
  // large review with many files does not parse + render every diff up front.
  // Without IntersectionObserver (jsdom/tests) render immediately.
  const blockRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const element = blockRef.current;
    if (!element) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  // Keep a collapsing block's header pinned at the top. Collapsing (or marking
  // Viewed) a tall block while reading its middle would otherwise drop the body and
  // yank later content up, scrolling past blocks we haven't read. When a collapse is
  // started while this header is at the top, re-anchor the scroll so that after the
  // body disappears the header is still exactly at its sticky position.
  const pendingScrollAnchorRef = useRef(false);
  const getScrollEnv = useCallback(() => {
    const el = blockRef.current;
    if (!el || typeof window === 'undefined') {
      return null;
    }
    const header = el.querySelector<HTMLElement>('.crh-block-header');
    if (!header) {
      return null;
    }
    const main = el.closest<HTMLElement>('.crh-main');
    const scroller: HTMLElement | Window =
      main && main.scrollHeight > main.clientHeight ? main : window;
    const stickyTop = Number.parseFloat(getComputedStyle(header).top) || 0;
    const scrollerTop =
      scroller === window ? 0 : (scroller as HTMLElement).getBoundingClientRect().top;
    return { el, header, scroller, stickyTop, scrollerTop };
  }, []);
  const isHeaderAtTop = useCallback(() => {
    const env = getScrollEnv();
    if (!env) {
      return false;
    }
    // Pinned (or scrolled above) iff the header sits at/above its sticky line.
    return env.header.getBoundingClientRect().top - env.scrollerTop <= env.stickyTop + 1;
  }, [getScrollEnv]);
  useLayoutEffect(() => {
    if (isExpanded || !pendingScrollAnchorRef.current) {
      pendingScrollAnchorRef.current = false;
      return;
    }
    pendingScrollAnchorRef.current = false;
    const env = getScrollEnv();
    if (!env) {
      return;
    }
    const delta = env.el.getBoundingClientRect().top - env.scrollerTop - env.stickyTop;
    if (Math.abs(delta) < 1) {
      return;
    }
    env.scroller.scrollBy({ top: delta, behavior: 'auto' });
  }, [isExpanded, getScrollEnv]);
  const shouldRender = forceVisible || visible;
  const parsed = useMemo(
    () =>
      !isExpanded || !shouldRender || block.kind === 'context' ? undefined : parseBlockDiff(block),
    [block, isExpanded, shouldRender]
  );
  // Apply a finding-jump selection only once every line of the range is actually rendered
  // in the diff's shadow DOM. Collapsed lines never render, and selecting them throws deep
  // in @pierre's async pipeline, leaving the diff blank. We poll briefly (the diff renders
  // async after shiki highlight) and skip the highlight if the rows never appear.
  useEffect(() => {
    if (!pierreSelectedLines || !shouldRender || !isExpanded) {
      setVerifiedSelection(null);
      return undefined;
    }
    const root = blockRef.current;
    if (!root) {
      return undefined;
    }
    const { start, end, side } = pierreSelectedLines;
    const types =
      side === 'deletions'
        ? ['change-deletion', 'context', 'context-expanded']
        : ['change-addition', 'context', 'context-expanded'];
    const allRowsRendered = (shadow: ShadowRoot): boolean => {
      for (let line = start; line <= end; line += 1) {
        const selector = types
          .map((type) => `div[data-line="${line}"][data-line-type="${type}"]`)
          .join(',');
        if (!shadow.querySelector(selector)) {
          return false;
        }
      }
      return true;
    };
    // Poll with setTimeout (not rAF — rAF pauses on hidden tabs) until the rows appear.
    let tries = 0;
    let timer = 0 as ReturnType<typeof setTimeout> | 0;
    const tick = (): void => {
      const shadow = root.querySelector('diffs-container')?.shadowRoot ?? null;
      if (shadow && allRowsRendered(shadow)) {
        setVerifiedSelection(pierreSelectedLines);
        return;
      }
      tries += 1;
      if (tries < 30) {
        timer = setTimeout(tick, 50);
      } else {
        setVerifiedSelection(null);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [pierreSelectedLines, shouldRender, isExpanded]);
  const bodyId = blockBodyDomId(block.id);
  const onReviewedChange = useCallback(
    (checked: boolean) => {
      // Marking Viewed collapses the block (via the reviewed effect); anchor first.
      if (checked && isHeaderAtTop()) {
        pendingScrollAnchorRef.current = true;
      }
      onToggleReviewed(block.id, checked);
    },
    [block.id, onToggleReviewed, isHeaderAtTop]
  );
  const commentAnchor: { side: ReviewSide; line: number } = block.newRange
    ? { side: 'new', line: block.newRange.start }
    : block.oldRange
      ? { side: 'old', line: block.oldRange.start }
      : { side: 'new', line: 1 };

  const { diffThemeName, activeTheme } = useCodeReviewTheme();

  const options = useMemo<FileDiffProps<AnnotationMeta, undefined>['options']>(
    () =>
      ({
        diffStyle,
        expandUnchanged: false,
        expansionLineCount: 18,
        hunkSeparators: 'line-info',
        lineDiffType: 'word',
        overflow: 'wrap',
        theme: diffThemeName,
        preferredHighlighter: canUseWASM() ? 'highlights' : 'shiki-js',
        themeType: activeTheme?.type === 'light' ? 'light' : 'dark',
        disableFileHeader: true,
        enableHoverUtility: true,
        onLineClick: (props: {
          readonly annotationSide: PierreSide;
          readonly lineNumber: number;
          readonly event?: { preventDefault?: () => void };
        }) => {
          props.event?.preventDefault?.();
          onStartDraft(block.path, fromPierreSide(props.annotationSide), props.lineNumber);
        },
      }) as FileDiffProps<AnnotationMeta, undefined>['options'],
    [diffStyle, diffThemeName, activeTheme?.type, onStartDraft, block.path]
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => (
      <InlineAnnotation metadata={annotation.metadata} onFocus={onFocusComment} />
    ),
    [onFocusComment]
  );

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => { side: PierreSide; lineNumber: number } | undefined) => {
      const hovered = getHoveredLine();
      if (!hovered) {
        return null;
      }
      return (
        <Button
          type="button"
          size="icon"
          variant="default"
          className="mr-1.5 mt-0.5 size-5 rounded-[5px] shadow-sm"
          aria-label="Add review comment"
          title="Add review comment"
          onClick={() => onStartDraft(block.path, fromPierreSide(hovered.side), hovered.lineNumber)}
        >
          <Plus className="size-3.5" />
        </Button>
      );
    },
    [onStartDraft, block.path]
  );

  return (
    <div
      ref={blockRef}
      className={cn(
        // Rounded card. The border lives on the header + body (not the block) so the
        // sticky header carries its own complete border and never doubles with the
        // block frame while pinned. overflow-hidden is only applied while collapsed
        // (header is then the lone child and nothing scrolls).
        'crh-block',
        stylex.props(
          diffBlockStyles.block,
          collapsed && diffBlockStyles.collapsed,
          reviewed && diffBlockStyles.reviewed
        ).className
      )}
      data-block-path={block.path}
    >
      <div className={cn('crh-block-header', stylex.props(diffBlockStyles.header).className)}>
        <div
          className={cn(
            'crh-block-header-inner',
            stylex.props(diffBlockStyles.headerInner, collapsed && diffBlockStyles.bottomCorners)
              .className
          )}
        >
          <button
            type="button"
            className={cn(
              'group',
              stylex.props(diffBlockStyles.toggle, treeCommitStyles.commitControlFocus).className
            )}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => {
              // Collapsing while the header is pinned: anchor so it stays at the top.
              if (isExpanded && isHeaderAtTop()) {
                pendingScrollAnchorRef.current = true;
              }
              setCollapsed((current) => !current);
            }}
          >
            <ChevronDown
              className={cn(
                'text-muted-foreground group-hover:text-foreground',
                stylex.props(
                  diffBlockStyles.chevron,
                  collapsed && treeCommitStyles.collapsedChevron
                ).className
              )}
            />
            <FileIcon filePath={block.path} {...stylex.props(diffBlockStyles.fileGlyph)} />
            <span {...stylex.props(diffBlockStyles.path)}>{block.path}</span>
            <FileStatusBadge file={block.file} kind={block.kind} />
          </button>
          <div {...stylex.props(diffBlockStyles.tools)}>
            {block.file && block.kind === 'change' && (
              <span {...stylex.props(diffBlockStyles.stats)}>
                <span {...stylex.props(diffBlockStyles.additions)}>+{block.file.additions}</span>{' '}
                <span {...stylex.props(diffBlockStyles.deletions)}>−{block.file.deletions}</span>
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              width="calc(var(--spacing) * 6)"
              height="calc(var(--spacing) * 6)"
              labelColor="var(--crh-muted-button-label)"
              className={stylex.props(privateButtonStyles.mutedInk).className}
              onClick={() => onStartDraft(block.path, commentAnchor.side, commentAnchor.line)}
              aria-label={`Add a review comment to ${block.path}`}
              title="Add a review comment"
            >
              <MessageSquarePlus className="size-3.5" />
            </Button>
            <ReviewCheck
              state={reviewed ? 'checked' : 'unchecked'}
              onChange={onReviewedChange}
              label="Viewed"
            />
          </div>
        </div>
      </div>

      {isExpanded && (
        <div id={bodyId} {...stylex.props(diffBlockStyles.body, diffBlockStyles.bottomCorners)}>
          {block.diagnostics.length > 0 && (
            <div {...stylex.props(diffBlockStyles.diagnostics)}>
              <Diagnostics diagnostics={block.diagnostics} />
            </div>
          )}

          {!shouldRender ? (
            <div className="crh-diff-placeholder" aria-hidden />
          ) : block.kind === 'context' ? (
            <ContextBody block={block} />
          ) : parsed?.status === 'error' ? (
            <div {...stylex.props(diffBlockStyles.parseErrorPadding)}>
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>Diff render failed</AlertTitle>
                <AlertDescription>{parsed.message}</AlertDescription>
              </Alert>
            </div>
          ) : parsed?.status === 'ready' ? (
            <div
              className={
                diffStyle === 'split' ? 'crh-pierre-diff crh-pierre-diff-split' : 'crh-pierre-diff'
              }
            >
              <ErrorBoundary
                resetKeys={[parsed.fileDiff, verifiedSelection]}
                onError={() => {
                  // Safety net for the sync selection path: drop the highlight and
                  // re-render the diff without it rather than crashing the review.
                  setVerifiedSelection(null);
                }}
                fallback={<div className="crh-diff-placeholder" aria-hidden />}
              >
                <FileDiff
                  fileDiff={parsed.fileDiff}
                  options={options}
                  lineAnnotations={annotations}
                  selectedLines={verifiedSelection}
                  renderAnnotation={renderAnnotation}
                  renderGutterUtility={renderGutterUtility}
                />
              </ErrorBoundary>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

const CONTEXT_BODY_CONTEXT_LINES = 3;

function ContextBody({ block }: { readonly block: ReviewResolvedBlock }) {
  const text = block.file?.newText ?? '';
  const range = block.newRange;
  if (!range) {
    return null;
  }
  const allLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const lineCount = allLines.length || countLines(text);
  const start = Math.max(1, range.start - CONTEXT_BODY_CONTEXT_LINES);
  const end = Math.min(lineCount, range.end + CONTEXT_BODY_CONTEXT_LINES);
  const displayLines = allLines.slice(start - 1, end);
  return (
    <div className={cn('crh-context-body', stylex.props(contextBlockStyles.root).className)}>
      <div {...stylex.props(contextBlockStyles.header)}>
        <Info {...stylex.props(contextBlockStyles.icon)} />
        <span>Context from current commit</span>
      </div>
      <div {...stylex.props(contextBlockStyles.scroll)}>
        <table {...stylex.props(contextBlockStyles.table)}>
          <tbody>
            {displayLines.map((line, index) => {
              const lineNumber = start + index;
              const inRange = lineNumber >= range.start && lineNumber <= range.end;
              return (
                <tr key={lineNumber} {...stylex.props(inRange && contextBlockStyles.range)}>
                  <td {...stylex.props(contextBlockStyles.lineNumber)}>{lineNumber}</td>
                  <td {...stylex.props(contextBlockStyles.source)}>{line || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FileStatusBadge({
  file,
  kind,
}: {
  readonly file: ReviewResolvedFile | undefined;
  readonly kind: 'change' | 'context';
}) {
  const shortLabel = kind === 'context' ? 'context' : (file?.status ?? 'unresolved');
  const detail =
    kind === 'context' ? 'Unchanged file referenced for context' : formatFileStatus(file);
  return (
    <span {...stylex.props(contextBlockStyles.status)} title={detail}>
      {shortLabel}
    </span>
  );
}

const annotationStyles = stylex.create({
  marker: {
    '--tw-shadow':
      '0 1px 3px 0 var(--tw-shadow-color,#0000001a), 0 1px 2px -1px var(--tw-shadow-color,#0000001a)',
    boxShadow:
      'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',

    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 0.5)',
    borderRadius: '0.25rem',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    'padding-inline': 'calc(var(--spacing) * 1)',
    '--crh-annotation-font-literal':
      'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", sans-serif',
    fontFamily: 'var(--crh-annotation-font-literal)',
    fontSize: '10px',
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    '--tw-leading': '1.4',
    lineHeight: '1.4',
  },
  markerGlyph: { width: 'calc(var(--spacing) * 3)', height: 'calc(var(--spacing) * 3)' },
  count: {
    '--tw-numeric-spacing': 'tabular-nums',
    fontVariantNumeric:
      'var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)',
  },
  note: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'calc(var(--spacing) * 1.5)',
    fontSize: '13px',
    '--tw-leading': 'calc(var(--spacing) * 6)',
    lineHeight: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground))',
  },
  noteGlyph: {
    marginTop: 'calc(var(--spacing) * 0.5)',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
  question: { color: 'hsl(var(--primary))' },
  minor: {
    color: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 70%, transparent)',
    },
  },
});

// Annotation content rendered below a diff line via @pierre/diffs slots.
// Info-level review notes are shown inline so they keep their line context;
// warnings/errors and user comments are kept in the right panel and reachable
// through a small marker badge.
function InlineAnnotation({
  metadata,
  onFocus,
}: {
  readonly metadata: AnnotationMeta;
  readonly onFocus: (anchor: string) => void;
}) {
  // Low-signal notes (context, questions, minor nits) render inline under the diff
  // line; P0/P1 issues get a clickable marker that opens the right-panel thread.
  const inlineNotes = metadata.notes.filter((note) => {
    const severity = note.severity ?? 'info';
    return severity === 'info' || severity === 'question' || severity === 'p2';
  });
  const panelNotes = metadata.notes.filter((note) => {
    const severity = note.severity ?? 'info';
    return severity === 'p0' || severity === 'p1';
  });
  const panelCount = panelNotes.length + metadata.comments.length;
  const hasInline = inlineNotes.length > 0;
  const hasPanel = panelCount > 0;
  // A top-level `## Review` finding that points at this line. It has no visible diff
  // marker; here it only needs an invisible `data-anno` anchor so the finding-chip jump
  // can scroll to the exact line.
  const hasFinding = metadata.findingRefs.length > 0;

  if (!hasInline && !hasPanel && !hasFinding) {
    return null;
  }

  // Finding-only line: emit a zero-size scroll anchor, nothing visible.
  if (!hasInline && !hasPanel) {
    return <span data-anno={metadata.key} aria-hidden className="crh-finding-anchor" />;
  }

  const markerSeverity: ReviewNoteSeverity = panelNotes.some((note) => note.severity === 'p0')
    ? 'p0'
    : panelNotes.length > 0
      ? 'p1'
      : 'info';

  return (
    <div className={cn('crh-line-annotation', hasInline && 'crh-line-annotation--inline')}>
      {hasFinding && !hasPanel && (
        <span data-anno={metadata.key} aria-hidden className="crh-finding-anchor" />
      )}
      {hasPanel && (
        <button
          type="button"
          data-anno={metadata.key}
          onClick={() => onFocus(metadata.key)}
          title="View in review thread"
          aria-label="View in review thread"
          className={cn(
            'crh-anno',
            stylex.props(
              annotationStyles.marker,
              SEVERITY_MARKER[markerSeverity],
              treeCommitStyles.commitTransitionColors
            ).className
          )}
        >
          {markerSeverity === 'info' ? (
            <MessageSquare {...stylex.props(annotationStyles.markerGlyph)} />
          ) : (
            <AlertTriangle {...stylex.props(annotationStyles.markerGlyph)} />
          )}
          {panelCount > 1 ? (
            <span {...stylex.props(annotationStyles.count)}>{panelCount}</span>
          ) : null}
        </button>
      )}
      {inlineNotes.map((note) => (
        <div
          key={note.id}
          className={cn('crh-inline-note', stylex.props(annotationStyles.note).className)}
        >
          {note.severity === 'question' ? (
            <HelpCircle {...stylex.props(annotationStyles.noteGlyph, annotationStyles.question)} />
          ) : note.severity === 'p2' ? (
            <AlertTriangle {...stylex.props(annotationStyles.noteGlyph, annotationStyles.minor)} />
          ) : null}
          {note.body}
        </div>
      ))}
    </div>
  );
}

const SEVERITY_MARKER = stylex.create({
  info: {
    borderColor: 'hsl(var(--border))',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 60%, transparent)',
    },
    color: {
      default: 'hsl(var(--muted-foreground))',
      '@media (hover: hover)': { ':hover': 'hsl(var(--foreground))' },
    },
  },
  question: {
    borderColor: {
      default: 'hsl(var(--primary))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--primary)) 35%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--primary))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--primary)) 10%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--primary))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--primary)) 15%, transparent)',
        },
      },
    },
    color: 'hsl(var(--primary))',
  },
  p2: {
    borderColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 30%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 8%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--status-warning))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--status-warning)) 15%, transparent)',
        },
      },
    },
    color: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 80%, transparent)',
    },
  },
  p1: {
    borderColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 45%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 12%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--status-warning))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--status-warning)) 20%, transparent)',
        },
      },
    },
    color: 'hsl(var(--status-warning))',
  },
  p0: {
    borderColor: {
      default: 'hsl(var(--status-danger))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-danger)) 45%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--status-danger))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-danger)) 12%, transparent)',
      '@media (hover: hover)': {
        ':hover': {
          default: 'hsl(var(--status-danger))',
          '@supports (color: color-mix(in lab, red, red))':
            'color-mix(in oklab, hsl(var(--status-danger)) 20%, transparent)',
        },
      },
    },
    color: 'hsl(var(--status-danger))',
  },
});

function severityRank(severity: ReviewNoteSeverity): number {
  switch (severity) {
    case 'p0':
      return 5;
    case 'p1':
      return 4;
    case 'p2':
      return 3;
    case 'question':
      return 2;
    default:
      return 1;
  }
}

function anchorKeyOf(path: string, side: ReviewSide, line: number): string {
  return `${path}::${side}::${line}`;
}

// Merge a group's multiple `changes://<same file>` diff blocks into ONE block that
// renders the whole file. The agent often splits a file into several ranged blocks;
// rendering each as its own cropped fragment hides the rest of the file (you can't
// expand context, you can miss changes, and per-fragment stats don't add up). By
// clearing the ranges we let @pierre/diffs render the full file diff with native
// collapse + expandable context, and we concatenate the notes from every fragment so
// they all anchor inside the single view (notes key on path/side/line, not block id).
// `context://` blocks (read-only snippets of UNCHANGED files) are intentionally
// partial, so they pass through untouched.
function mergeDiffBlocksByPath(bundle: ReviewBundle): ReviewBundle {
  const groups = bundle.groups.map((group) => {
    const mergedByPath = new Map<string, ReviewResolvedBlock>();
    const blocks: ReviewResolvedBlock[] = [];
    for (const block of group.blocks) {
      if (block.kind !== 'change') {
        blocks.push(block);
        continue;
      }
      const existing = mergedByPath.get(block.path);
      if (existing) {
        existing.notes.push(...block.notes);
        continue;
      }
      // Drop the line ranges so the block renders the whole file diff (parseBlockDiff
      // parses the full file; @pierre/diffs then collapses unchanged regions with an
      // expand affordance). Keep a fresh notes array so we never mutate the input.
      const { oldRange: _oldRange, newRange: _newRange, ...rest } = block;
      const merged: ReviewResolvedBlock = { ...rest, notes: [...block.notes] };
      mergedByPath.set(block.path, merged);
      blocks.push(merged);
    }
    return { ...group, blocks };
  });
  return { ...bundle, groups };
}

function sumFileStats(files: readonly (ReviewResolvedFile | undefined)[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (file) {
      additions += file.additions;
      deletions += file.deletions;
    }
  }
  return { additions, deletions };
}

function toPierreSide(side: ReviewSide): PierreSide {
  return side === 'new' ? 'additions' : 'deletions';
}

interface MutableAnnotation {
  key: string;
  side: ReviewSide;
  line: number;
  severity: ReviewNoteSeverity;
  notes: ReviewNote[];
  comments: ReviewUserComment[];
  findingRefs: FindingLineMarker[];
}

function buildLineAnnotations(
  block: ReviewResolvedBlock,
  comments: readonly ReviewUserComment[],
  findingAnchors: readonly FindingAnchor[]
): DiffLineAnnotation<AnnotationMeta>[] {
  const byKey = new Map<string, MutableAnnotation>();
  const ensure = (side: ReviewSide, line: number): MutableAnnotation => {
    const key = anchorKeyOf(block.path, side, line);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, side, line, severity: 'info', notes: [], comments: [], findingRefs: [] };
      byKey.set(key, entry);
    }
    return entry;
  };
  for (const note of block.notes) {
    const entry = ensure(note.side, note.range.start);
    entry.notes.push(note);
    const severity = note.severity ?? 'info';
    if (severityRank(severity) > severityRank(entry.severity)) {
      entry.severity = severity;
    }
  }
  for (const comment of comments) {
    const entry = ensure(comment.anchor.side, comment.anchor.lineNumber);
    entry.comments.push(comment);
  }
  for (const anchor of findingAnchors) {
    const entry = ensure(anchor.side, anchor.line);
    entry.findingRefs.push({ findingId: anchor.findingId, severity: anchor.severity });
    if (severityRank(anchor.severity) > severityRank(entry.severity)) {
      entry.severity = anchor.severity;
    }
  }
  return [...byKey.values()].map((entry) => ({
    side: toPierreSide(entry.side),
    lineNumber: entry.line,
    metadata: {
      key: entry.key,
      path: block.path,
      side: entry.side,
      line: entry.line,
      severity: entry.severity,
      notes: entry.notes,
      comments: entry.comments,
      findingRefs: entry.findingRefs,
    },
  }));
}

const commentStyles = stylex.create({
  panel: {
    zIndex: 10,
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flexDirection: 'column',
    borderColor: 'hsl(var(--sidebar-border))',
    backgroundColor: 'hsl(var(--sidebar))',
    color: 'hsl(var(--sidebar-foreground))',
    borderTopStyle: {
      default: null,
      '@media not all and (width >= 64rem)': 'var(--tw-border-style)',
    },
    borderTopWidth: {
      default: null,
      '@media not all and (width >= 64rem)': '1px',
    },
    position: {
      default: null,
      '@media (width >= 64rem)': 'sticky',
    },
    top: {
      default: null,
      '@media (width >= 64rem)': 'calc(var(--spacing) * 0)',
    },
    height: {
      default: null,
      '@media (width >= 64rem)': '100vh',
    },
    borderLeftStyle: {
      default: null,
      '@media (width >= 64rem)': 'var(--tw-border-style)',
    },
    borderLeftWidth: {
      default: null,
      '@media (width >= 64rem)': '1px',
    },
  },
  scroll: {
    flex: '1',
    overflowY: 'auto',
    padding: 'calc(var(--spacing) * 3)',
  },
  findings: {
    marginBottom: 'calc(var(--spacing) * 4)',
  },
  threadList: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 4)',
  },
  fileThreads: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 2)',
  },
  pathButton: {
    display: 'flex',
    width: '100%',
    minWidth: 'calc(var(--spacing) * 0)',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'calc(var(--radius) - 2px)',
    'padding-inline': 'calc(var(--spacing) * 0.5)',
    textAlign: 'left',
  },
  pathLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11.5px',
    color: 'hsl(var(--muted-foreground))',
  },
  threadItems: {
    display: 'grid',
    gap: 'calc(var(--spacing) * 2)',
  },
  composer: {
    '--tw-shadow':
      '0 1px 3px 0 var(--tw-shadow-color,#0000001a), 0 1px 2px -1px var(--tw-shadow-color,#0000001a)',
    boxShadow:
      'var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)',

    marginBottom: 'calc(var(--spacing) * 4)',
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--card))',
  },
  composerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  composerTitle: {
    '--tw-leading': 1,
    lineHeight: 1,
    '--tw-font-weight': 'var(--font-weight-semibold)',
    fontWeight: 'var(--font-weight-semibold)',
    fontSize: '12px',
    color: 'hsl(var(--foreground))',
  },
  composerPath: {
    'margin-left': 'auto',
    minWidth: 'calc(var(--spacing) * 0)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SF Mono", SFMono-Regular, "Berkeley Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  textarea: {
    '--tw-leading': 'calc(var(--spacing) * 6)',
    lineHeight: 'calc(var(--spacing) * 6)',
    '--tw-outline-style': 'none',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    display: 'block',
    minHeight: 'calc(var(--spacing) * 24)',
    width: '100%',
    resize: 'vertical',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: 0,
    backgroundColor: 'hsl(var(--card))',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
    '--crh-composer-font-literal':
      'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", "PingFang SC", sans-serif',
    fontFamily: 'var(--crh-composer-font-literal)',
    fontSize: '13px',
    color: {
      default: 'hsl(var(--foreground))',
      '::placeholder': 'hsl(var(--muted-foreground))',
    },
  },
  composerFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
    borderTopStyle: 'var(--tw-border-style)',
    borderTopWidth: '1px',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  threadCard: {
    overflow: 'hidden',
    borderRadius: 'var(--radius)',
    borderStyle: 'var(--tw-border-style)',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border))',
    backgroundColor: 'hsl(var(--card))',
  },
  threadHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    borderColor: 'hsl(var(--border))',
    backgroundColor: {
      default: 'hsl(var(--muted))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    },
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 1.5)',
  },
  threadJump: {
    display: 'flex',
    minWidth: 'calc(var(--spacing) * 0)',
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'calc(var(--radius) - 2px)',
    textAlign: 'left',
  },
  dangerGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--status-danger))',
  },
  warningGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--status-warning))',
  },
  mutedWarningGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: {
      default: 'hsl(var(--status-warning))',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--status-warning)) 70%, transparent)',
    },
  },
  questionGlyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--primary))',
  },
  threadDeleteOffset: { marginRight: 'calc(var(--spacing) * -1)' },
  threadLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '11px',
    color: 'hsl(var(--muted-foreground))',
  },
  glyph: {
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
  },
  threadBody: {
    '--tw-leading': 'calc(var(--spacing) * 6)',
    lineHeight: 'calc(var(--spacing) * 6)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2.5)',
    fontSize: '13px',
    color: 'hsl(var(--foreground))',
  },
});

function CommentPanel({
  threads,
  total: _total,
  findings,
  files,
  focusedAnchor,
  draft,
  onDraftBodyChange,
  onSaveDraft,
  onCancelDraft,
  onDeleteComment,
  onFocus,
  onNavigate,
  onJumpToRef,
}: {
  readonly threads: readonly FileThread[];
  readonly total: number;
  readonly findings: readonly ReviewFinding[];
  readonly files: Record<string, ReviewResolvedFile>;
  readonly focusedAnchor: string | null;
  readonly draft: DraftComment | null;
  readonly onDraftBodyChange: (body: string) => void;
  readonly onSaveDraft: () => void;
  readonly onCancelDraft: () => void;
  readonly onDeleteComment: (id: string) => void;
  readonly onFocus: (anchor: string, path: string) => void;
  readonly onNavigate: (path: string) => void;
  readonly onJumpToRef: (ref: ReviewFindingRef) => void;
}) {
  return (
    <aside
      className={cn('crh-panel', stylex.props(commentStyles.panel).className)}
      aria-label="Review comments"
    >
      <div data-cr-panel-scroll {...stylex.props(commentStyles.scroll)}>
        {findings.length > 0 && (
          <div {...stylex.props(commentStyles.findings)}>
            <ReviewFindingsSection findings={findings} files={files} onJump={onJumpToRef} />
          </div>
        )}

        {draft !== null && (
          <PanelComposer
            draft={draft}
            onChange={onDraftBodyChange}
            onSave={onSaveDraft}
            onCancel={onCancelDraft}
          />
        )}

        <div {...stylex.props(commentStyles.threadList)}>
          {threads.map((thread) => (
            <section
              key={thread.path}
              data-thread-path={thread.path}
              {...stylex.props(commentStyles.fileThreads)}
            >
              <button
                type="button"
                className={cn(
                  'group',
                  stylex.props(commentStyles.pathButton, treeCommitStyles.commitControlFocus)
                    .className
                )}
                onClick={() => onNavigate(thread.path)}
                title={`Jump to ${thread.path}`}
              >
                <FileIcon filePath={thread.path} {...stylex.props(commentStyles.glyph)} />
                <span
                  className={cn(
                    'group-hover:text-foreground',
                    stylex.props(commentStyles.pathLabel).className
                  )}
                >
                  {thread.path}
                </span>
              </button>
              <div {...stylex.props(commentStyles.threadItems)}>
                {thread.items.map((item) => (
                  <ThreadCard
                    key={item.id}
                    item={item}
                    focused={focusedAnchor === item.anchor}
                    onDelete={onDeleteComment}
                    onFocus={onFocus}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}

function PanelComposer({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  readonly draft: DraftComment;
  readonly onChange: (body: string) => void;
  readonly onSave: () => void;
  readonly onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const anchorKey = `${draft.path}:${draft.side}:${draft.lineNumber}`;

  useLayoutEffect(() => {
    if (typeof containerRef.current?.scrollIntoView === 'function') {
      containerRef.current.scrollIntoView({ block: 'nearest' });
    }
    textareaRef.current?.focus();
  }, [anchorKey]);

  return (
    <div ref={containerRef} {...stylex.props(commentStyles.composer)}>
      <header {...stylex.props(commentStyles.composerHeader)}>
        <span {...stylex.props(commentStyles.composerTitle)}>New comment</span>
        <span {...stylex.props(commentStyles.composerPath)}>{fileBaseName(draft.path)}</span>
      </header>
      <textarea
        ref={textareaRef}
        value={draft.body}
        placeholder="Leave a comment…"
        aria-label={`Comment on ${fileBaseName(draft.path)} line ${draft.lineNumber}`}
        {...stylex.props(commentStyles.textarea)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onInput={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            onSave();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div {...stylex.props(commentStyles.composerFooter)}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          height="calc(var(--spacing) * 7)"
          labelColor="var(--crh-muted-button-label)"
          className={stylex.props(privateButtonStyles.mutedInk).className}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" height="calc(var(--spacing) * 7)" onClick={onSave}>
          Save comment
        </Button>
      </div>
    </div>
  );
}

function ThreadCard({
  item,
  focused,
  onDelete,
  onFocus,
}: {
  readonly item: ThreadItem;
  readonly focused: boolean;
  readonly onDelete: (id: string) => void;
  readonly onFocus: (anchor: string, path: string) => void;
}) {
  const isNote = item.kind === 'note';
  const severity = item.severity;
  return (
    <article
      data-anchor={item.anchor}
      className={cn(
        stylex.props(commentStyles.threadCard, treeCommitStyles.commitTransitionColors).className,
        focused && 'crh-thread-focused'
      )}
    >
      <header {...stylex.props(commentStyles.threadHeader)}>
        <button
          type="button"
          onClick={() => onFocus(item.anchor, item.path)}
          title="Jump to this line in the diff"
          className={cn(
            stylex.props(commentStyles.threadJump, treeCommitStyles.commitControlFocus).className
          )}
        >
          {severity === 'p0' && <CircleAlert {...stylex.props(commentStyles.dangerGlyph)} />}
          {severity === 'p1' && <AlertTriangle {...stylex.props(commentStyles.warningGlyph)} />}
          {severity === 'p2' && (
            <AlertTriangle {...stylex.props(commentStyles.mutedWarningGlyph)} />
          )}
          {severity === 'question' && <HelpCircle {...stylex.props(commentStyles.questionGlyph)} />}
          <span {...stylex.props(commentStyles.threadLabel)}>
            {isNote
              ? severity === 'question'
                ? 'question'
                : severity === 'info'
                  ? 'note'
                  : severity.toUpperCase()
              : `commented${formatRelativeTime(item.createdAt)}`}
          </span>
        </button>
        {!isNote && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            width="calc(var(--spacing) * 6)"
            height="calc(var(--spacing) * 6)"
            labelColor="var(--crh-muted-button-label)"
            className={
              stylex.props(privateButtonStyles.mutedInk, commentStyles.threadDeleteOffset).className
            }
            onClick={() => onDelete(item.id)}
            aria-label="Delete comment"
            title="Delete comment"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </header>
      <div className={cn('crh-line-annotation', stylex.props(commentStyles.threadBody).className)}>
        {item.body}
      </div>
    </article>
  );
}

function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ReviewDiagnostic[] }) {
  return (
    <div {...stylex.props(markdownStyles.diagnostics)}>
      {diagnostics.map((diagnostic, index) => {
        const Icon = diagnostic.severity === 'info' ? CircleAlert : AlertTriangle;
        return (
          <Alert
            key={`${diagnostic.code ?? 'diagnostic'}-${index}`}
            variant={
              diagnostic.severity === 'error'
                ? 'destructive'
                : diagnostic.severity === 'warning'
                  ? 'warning'
                  : 'info'
            }
          >
            <Icon className="size-4" />
            <AlertTitle {...stylex.props(markdownStyles.diagnosticTitle)}>
              {diagnostic.severity}
              {diagnostic.code ? `: ${diagnostic.code}` : ''}
            </AlertTitle>
            <AlertDescription>{diagnostic.message}</AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}

function SimpleMarkdown({
  markdown,
  tone = 'muted',
  compact = false,
}: {
  readonly markdown: string;
  readonly tone?: 'muted' | 'foreground';
  readonly compact?: boolean;
}) {
  const blocks = parseLightMarkdownBlocks(markdown);

  return (
    <div
      className={cn(
        'crh-markdown',
        stylex.props(
          markdownStyles.body,
          tone === 'foreground' ? markdownStyles.foreground : markdownStyles.muted
        ).className
      )}
    >
      {blocks.map((block, index) =>
        renderLightMarkdownBlock(
          block,
          String(index),
          {},
          {
            compact,
            blockClassName: stylex.props(index < blocks.length - 1 && markdownStyles.blockSpace)
              .className,
          }
        )
      )}
    </div>
  );
}

function parseBlockDiff(
  block: ReviewResolvedBlock
):
  | { readonly status: 'ready'; readonly fileDiff: FileDiffMetadata }
  | { readonly status: 'error'; readonly message: string } {
  try {
    const oldText = block.file?.oldText ?? block.displayOldText;
    const newText = block.file?.newText ?? block.displayNewText;
    const fullFileDiff = parseDiffFromFile(
      {
        name: block.path,
        contents: oldText,
        lang: extensionFromPath(block.path) as never,
        cacheKey: `${block.id}:old`,
      },
      {
        name: block.path,
        contents: newText,
        lang: extensionFromPath(block.path) as never,
        cacheKey: `${block.id}:new`,
      }
    );

    return {
      status: 'ready',
      fileDiff: fullFileDiff,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatCommentsMarkdown(
  bundle: ReviewBundle,
  comments: readonly ReviewUserComment[]
): string {
  if (comments.length === 0) {
    return '# Review Comments\n\nNo comments.';
  }
  const lines = [
    '# Review Comments',
    '',
    `merge_base: ${bundle.document.frontmatter.mergeBase}`,
    `current_commit: ${bundle.document.frontmatter.currentCommit}`,
    '',
  ];
  for (const group of bundle.groups) {
    const groupComments = comments.filter((comment) =>
      group.blocks.some((block) => block.path === comment.anchor.path)
    );
    if (groupComments.length === 0) {
      continue;
    }
    lines.push(`## ${group.title}`, '');
    for (const comment of groupComments) {
      lines.push(
        `- \`${comment.anchor.path}\` ${comment.anchor.side}://L${comment.anchor.lineNumber}`
      );
      if (comment.lineText !== undefined) {
        lines.push(`  - Line: \`${comment.lineText.trim()}\``);
      }
      lines.push(`  - Comment: ${comment.body}`, '');
    }
  }
  return lines.join('\n').trimEnd();
}

function groupDomId(groupId: string): string {
  return `review-group-${groupId}`;
}

function blockBodyDomId(blockId: string): string {
  return `review-block-body-${blockId}`;
}

function createDefaultStorageKey(bundle: ReviewBundle): string {
  return [
    'review-helper-comments',
    bundle.reviewFilePath ?? 'anonymous',
    bundle.document.frontmatter.mergeBase,
    bundle.document.frontmatter.currentCommit,
  ].join(':');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isDesktopViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(min-width: 1024px)').matches
  );
}

function loadColumnWidths(): ColumnWidths {
  if (typeof window === 'undefined') {
    return DEFAULT_COLUMNS;
  }
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_COLUMNS;
    }
    const parsed = JSON.parse(raw) as Partial<ColumnWidths>;
    return {
      sidebar: clamp(Number(parsed.sidebar) || DEFAULT_COLUMNS.sidebar, SIDEBAR_MIN, SIDEBAR_MAX),
      panel: clamp(Number(parsed.panel) || DEFAULT_COLUMNS.panel, PANEL_MIN, PANEL_MAX),
    };
  } catch {
    return DEFAULT_COLUMNS;
  }
}

function saveColumnWidths(columns: ColumnWidths): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // ignore persistence failures (private mode, quota, etc.)
  }
}

function loadComments(key: string): ReviewUserComment[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isReviewUserComment) : [];
  } catch {
    return [];
  }
}

function saveComments(key: string, comments: readonly ReviewUserComment[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(comments));
}

function isReviewUserComment(value: unknown): value is ReviewUserComment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'anchor' in value &&
    'body' in value &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { body?: unknown }).body === 'string'
  );
}

function fromPierreSide(side: PierreSide): ReviewSide {
  return side === 'additions' ? 'new' : 'old';
}

function escapeCssIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function formatRelativeTime(createdAt: number | undefined): string {
  if (createdAt === undefined || !Number.isFinite(createdAt)) {
    return '';
  }
  const deltaMs = Date.now() - createdAt;
  if (deltaMs < 45_000) {
    return ' · just now';
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return ` · ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return ` · ${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return ` · ${days}d ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return ` · ${months}mo ago`;
  }
  return ` · ${Math.floor(months / 12)}y ago`;
}

function fileBaseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return (parts[0] ?? '').slice(0, 2).toUpperCase();
  }
  return `${(parts[0] ?? '')[0] ?? ''}${(parts[parts.length - 1] ?? '')[0] ?? ''}`.toUpperCase();
}

function hashHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }
  return hash;
}

// Strip the structured metadata lines out of a group's body so only the prose
// description renders. Besides `Commits:`/`Changed lines:` (rendered separately or
// dropped), this also removes the legacy reading-guidance lines some older
// `.review.md` files carry (`Bottom line:` / `How to read:` / `If you check one
// thing:`) — the format no longer emits those, but stripping them keeps old files
// readable instead of dumping the meta into the description.
const GROUP_METADATA_LINE =
  /^\s*\*{0,2}(Changed lines|Commits|Focus|Bottom line|How to read|If you check one thing)\b/iu;

function stripGroupMetadataMarkdown(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !GROUP_METADATA_LINE.test(line))
    .join('\n')
    .trim();
}

function formatFileStatus(file: ReviewResolvedFile | undefined): string {
  if (!file) {
    return 'unresolved file';
  }
  if (file.status === 'renamed' && file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return `renamed from ${file.oldPath}`;
  }
  return file.status;
}

function extensionFromPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? undefined : filePath.slice(dot + 1).toLowerCase();
}
