import { anchorOfRow, deriveAnchor, resolveAnchor } from './anchor';
import { Geometry, type SavedSizes } from './geometry';
import {
  FIXED_ROW_KINDS,
  type CycleDiagnostic,
  type EngineRow,
  type Intent,
  type MovementClass,
  type ReadingAnchor,
  type ScrollSnapshot,
  type StickyMode,
} from './types';

/**
 * The conversation scroll engine's transaction logic, independent of React and
 * of the DOM. The adapter (`use-conversation-scroll-engine.tsx`) and the model
 * tests' simulator both drive it through {@link ScrollHost}.
 *
 * Design, invariants I1–I8 and the coverage lemma:
 * `.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md`.
 */

/** Pixels of rows rendered beyond each edge of the viewport. */
export const ENGINE_OVERSCAN_PX = 800;
/**
 * The smallest height any row outside the fixed rows may have. Its only job is
 * to bound the worst-case window (coverage lemma); rows below it are reported
 * in development.
 */
export const ENGINE_MIN_ROW_PX = 20;
/** Supplementary commits per pass (coverage lemma). */
const MAX_SUPPLEMENTARY_COMMITS = 2;
/** A downward scroll that ends this close to the real bottom re-arms follow. */
const REARM_DISTANCE_PX = 4;
/** Scroll ranges remembered per scroll sequence (see {@link ScrollGesture}). */
const MAX_GESTURE_BOTTOMS = 32;
/** How long a send (or a smooth jump) takes to glide to its target. */
const GLIDE_MS = 360;
/** Differences below this are sub-pixel rounding, not movement. */
const EPSILON_PX = 1;

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

/** Navigation writes are absolute; every other write compensates layout relatively. */
const NAVIGATION_REASONS = new Set([
  'scroll-to-bottom',
  'jump',
  'send',
  'glide-start',
  'glide',
  'glide-end',
  'glide-missing',
  'anchor-row-gone',
]);

export interface ScrollHost {
  readScrollTop(): number;
  readScrollHeight(): number;
  /** The viewport's height (`clientHeight`). */
  readViewportHeight(): number;
  /** The rows container's top in the viewport's scroll coordinates. */
  readContentTop(): number;
  readPaddingBottom(): number;
  /** Current heights of the given mounted rows; undefined for a row not in the DOM. */
  measure(keys: readonly string[]): ReadonlyArray<number | undefined>;
  setExtent(px: number): void;
  setReplyRoom(px: number): void;
  writeScrollTop(value: number): void;
  scrollBy(delta: number): void;
  /**
   * Re-render the list from {@link ScrollController.plan}; the commit's layout
   * effect must call {@link ScrollController.afterCommit}. `sync` asks for a
   * commit before this task ends (callers outside React use `flushSync`).
   */
  requestCommit(sync: boolean): void;
  /** Follow-output is suppressed by a deliberate reading-position change. */
  isSuppressed(): boolean;
  prefersReducedMotion(): boolean;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface ControllerCallbacks {
  onStickyChange?(sticky: boolean): void;
  onFirstCycle?(): void;
  onScroll?(scrollTop: number): void;
  onDiagnostic?(diagnostic: CycleDiagnostic): void;
  /** A row outside the fixed rows measured below {@link ENGINE_MIN_ROW_PX}. */
  onMinRowViolation?(key: string, height: number): void;
  /** A momentum scroll ended; counts of compensation writes during it (P4 evidence). */
  onMomentumEnd?(stats: MomentumStats): void;
}

/**
 * Compensation writes during post-touch momentum, the data P4 needs to decide
 * whether WebKit's fling interruption matters. A write counts as having ended
 * the fling when `scrollend` arrives with no scroll event after it.
 */
export interface MomentumStats {
  compensations: number;
  interruptions: number;
}

export interface RenderPlan {
  /** Row indexes to mount, ascending. */
  indices: number[];
  keys: string[];
  /** Item-space top of each mounted row. */
  offsets: number[];
  sizes: number[];
  geometryRevision: number;
}

interface Glide {
  rowKey: string;
  fromScreenY: number;
  toScreenY: number;
  startedAt: number | null;
  frame: number;
  /** The intent to settle into when the glide ends. */
  settle: Intent;
}

/**
 * One scroll sequence, from its first scroll event to `scrollend`. The
 * compositor clamps a fling against the scroll range of the last frame it
 * received; rows measured during the fling can grow the range after that, so
 * the fling stops at a bottom that was real while it ran. `bottoms` holds
 * every maximum offset the range had during the sequence.
 */
interface ScrollGesture {
  bottoms: number[];
  /** The last movement in the sequence was downward. */
  down: boolean;
}

interface Transaction {
  reason: string;
  pass: 1 | 2;
  supplementary: number;
  worstCase: boolean;
  /** Keys mounted by the first supplementary commit; the window never shrinks after it. */
  frozen: string[] | null;
  freezeNextPlan: boolean;
  /** The DOM offset this transaction started from. */
  sampled: number;
  movement: MovementClass;
  /** Writes are relative only for layout compensation of a reading position. */
  relative: boolean;
}

interface Observed {
  scrollTop: number;
  maxScrollTop: number;
  geometryRevision: number;
}

export interface ControllerOptions {
  host: ScrollHost;
  callbacks?: ControllerCallbacks;
  initialIntent?: Extract<Intent, { kind: 'follow' | 'read' }>;
  savedSizes?: SavedSizes | null;
  layoutVersion?: string;
  /** Viewport height to plan the very first render with, before the viewport is mounted. */
  initialViewportHeight?: number;
  overscanPx?: number;
  minRowPx?: number;
}

export class ScrollController {
  private host: ScrollHost;
  private callbacks: ControllerCallbacks;
  private readonly overscan: number;
  private readonly minRow: number;
  readonly geometry: Geometry;
  private rows: EngineRow[] = [];
  private intent: Intent;
  private glide: Glide | null = null;
  private viewportHeight: number;
  private contentTop = 0;
  private paddingBottom = 0;
  private viewportKnown = false;
  private extent = 0;
  private replyRoom = 0;
  private lastObserved: Observed | null = null;
  private pendingExternalMove = false;
  private tx: Transaction | null = null;
  private lastPlan: RenderPlan | null = null;
  private committedPlan: RenderPlan | null = null;
  private readonly dirty = new Set<string>();
  private mustMount: readonly number[] = [];
  private firstCycleComplete = false;
  private sticky: boolean;
  private pointerHeld = false;
  private touchActive = false;
  /** Touch ended and no `scrollend` yet: any scrolling now is momentum. */
  private momentum = false;
  private gesture: ScrollGesture | null = null;
  private momentumStats: MomentumStats = { compensations: 0, interruptions: 0 };
  private compensationPendingCheck = false;
  private scrolledSinceCompensation = false;
  private sourceGeneration = 0;
  private disposed = false;
  /** The viewport has no layout box (a `display: none` tab or a collapsed panel). */
  private hidden = false;
  /** Shown again since the last transaction: the DOM position is not the reader's. */
  private reshown = false;
  private readonly reportedMinRow = new Set<string>();
  private lastReportedScroll: number | null = null;

  constructor(options: ControllerOptions) {
    this.host = options.host;
    this.callbacks = options.callbacks ?? {};
    this.overscan = options.overscanPx ?? ENGINE_OVERSCAN_PX;
    this.minRow = options.minRowPx ?? ENGINE_MIN_ROW_PX;
    this.geometry = new Geometry(options.layoutVersion ?? '', options.savedSizes);
    this.intent = options.initialIntent ?? { kind: 'follow' };
    this.viewportHeight = options.initialViewportHeight ?? 800;
    this.sticky = this.intent.kind !== 'read';
  }

  setHost(host: ScrollHost): void {
    this.host = host;
  }

  setCallbacks(callbacks: ControllerCallbacks): void {
    this.callbacks = callbacks;
  }

  // ---- Inputs from render -------------------------------------------------

  /**
   * The rows of this render. Called during render; idempotent for the same
   * rows. A change of rows abandons a transaction in flight: the new commit
   * starts a fresh one.
   */
  syncRows(rows: readonly EngineRow[], sourceGeneration: number): void {
    if (sourceGeneration !== this.sourceGeneration) {
      this.sourceGeneration = sourceGeneration;
      this.tx = null;
    }
    this.rows = rows.slice();
    if (this.geometry.setRows(rows) && this.tx) {
      this.tx = null;
    }
  }

  /** Rows native selection needs mounted (Virtua indexes: the list's own indexes). */
  setMustMount(indices: readonly number[]): void {
    this.mustMount = indices;
  }

  setLayoutVersion(version: string): void {
    this.geometry.setLayoutVersion(version);
  }

  /**
   * Whether the viewport is off screen with no layout box. Called during
   * render. A hidden viewport reads every offset and size as 0 and drops
   * writes, so nothing it reports is a position or a size: the engine runs no
   * transactions and reports no scroll until it is shown again, then resolves
   * the intent it kept. Without this, the adapter's per-commit transaction
   * accepted the hidden offset 0 and reported it to the view, whose
   * position-derived state (hydration window, outline) re-rendered the list,
   * whose commit reported 0 again: an unbounded synchronous loop.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.tx = null;
      this.gesture = null;
      this.cancelGlide();
    } else {
      this.reshown = true;
    }
  }

  /** The rows to mount and where. Called during render. */
  plan(): RenderPlan {
    const length = this.rows.length;
    let indices: number[];
    const frozen = this.tx?.frozen;
    if (frozen) {
      indices = frozen
        .map((key) => this.geometry.indexOfKey(key))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b);
    } else {
      const target = this.targetScrollTop();
      const set = new Set<number>();
      const [start, end] = this.rangeFor(target);
      for (let index = start; index <= end; index += 1) set.add(index);
      if (this.tx?.worstCase) {
        const [windowStart, windowEnd] = this.worstCaseWindow();
        for (let index = windowStart; index <= windowEnd; index += 1) set.add(index);
      }
      for (const index of this.mustMount) if (index >= 0 && index < length) set.add(index);
      indices = [...set].sort((a, b) => a - b);
      if (this.tx?.freezeNextPlan) {
        this.tx.frozen = indices.map((index) => this.rows[index]!.key);
        this.tx.freezeNextPlan = false;
      }
    }
    const plan: RenderPlan = {
      indices,
      keys: indices.map((index) => this.rows[index]!.key),
      offsets: indices.map((index) => this.geometry.offset(index)),
      sizes: indices.map((index) => this.geometry.size(index)),
      geometryRevision: this.geometry.revision,
    };
    this.lastPlan = plan;
    return plan;
  }

  // ---- The commit protocol ------------------------------------------------

  /** Call from the layout effect of every list commit. */
  afterCommit(): void {
    if (this.disposed) return;
    const previous = this.committedPlan;
    this.committedPlan = this.lastPlan;
    if (this.rows.length === 0 || this.hidden) return;
    // A parent setState from `onScroll` (hydration, the top fade) re-commits
    // the list with the same layout. Starting a fresh cycle every time, then
    // reporting the offset again, is the React #185 nested-update loop.
    if (!this.tx) {
      if (this.isSettled()) return;
      this.beginTransaction(this.reshown ? 'reshow' : 'commit', previous);
    }
    this.continueTransaction();
  }

  /** Mounted rows changed size (ResizeObserver). */
  onRowsResized(entries: ReadonlyArray<{ key: string; height: number }>): void {
    // A hidden row measures 0; its size is unknown, not changed.
    if (this.disposed || this.hidden) return;
    let changed = false;
    for (const { key, height } of entries) {
      const index = this.geometry.indexOfKey(key);
      if (index < 0) continue;
      if (!this.geometry.isMeasured(index) || this.geometry.size(index) !== height) {
        this.dirty.add(key);
        changed = true;
      }
    }
    // Only sizes changed: measure against the committed rows first; a commit
    // follows only if positions moved.
    if (changed) this.run('resize', true, false);
  }

  /** The viewport changed size (ResizeObserver). */
  onViewportResized(layoutVersion?: string): void {
    // Hiding reads as a resize to 0 × 0; showing again resizes back.
    if (this.disposed || this.hidden) return;
    if (layoutVersion !== undefined) this.geometry.setLayoutVersion(layoutVersion);
    this.refreshViewport();
    this.run('viewport', true);
  }

  /** A native scroll event. */
  onScrollEvent(): void {
    if (this.disposed || this.hidden || this.rows.length === 0 || this.tx) return;
    if (this.reshown) {
      this.run('reshow', true);
      return;
    }
    this.refreshViewport(false);
    const scrollTop = this.host.readScrollTop();
    const last = this.lastObserved;
    // Our own write's event reports the offset we accepted: not movement.
    if (last && Math.abs(scrollTop - last.scrollTop) < 0.5 && !this.pendingExternalMove) return;
    if (this.compensationPendingCheck) this.scrolledSinceCompensation = true;
    const previous = last?.scrollTop ?? scrollTop;
    const movement = this.classify(scrollTop);
    this.applyMovement(movement, scrollTop, this.committedPlan);
    // Re-arm follow: a downward scroll reaching the real bottom.
    const maxNow = Math.max(0, this.host.readScrollHeight() - this.viewportHeight);
    this.gesture ??= { bottoms: last ? [last.maxScrollTop] : [], down: false };
    this.gesture.down = scrollTop > previous;
    this.recordBottom(maxNow);
    if (
      this.intent.kind === 'read' &&
      !this.glide &&
      scrollTop > previous &&
      !this.host.isSuppressed() &&
      this.replyRoom === 0 &&
      maxNow - scrollTop <= REARM_DISTANCE_PX
    ) {
      this.setIntent({ kind: 'follow' });
    }
    if (this.intent.kind !== 'read') {
      // A move that was not the reader's: the mode's position wins.
      if (Math.abs(this.targetScrollTop() - scrollTop) > EPSILON_PX) {
        this.run('scroll', true);
        return;
      }
    }
    if (this.intent.kind === 'read' && this.replyRoom > 0) this.shrinkReplyRoom(scrollTop);
    const covered = this.isCovered(scrollTop, this.committedPlan);
    const [start, end] = this.rangeFor(scrollTop);
    const plan = this.committedPlan;
    const rangeMoved =
      !plan ||
      plan.indices.length === 0 ||
      start < plan.indices[0]! ||
      end > plan.indices[plan.indices.length - 1]!;
    if (!covered) {
      this.run('scroll', true);
      return;
    }
    this.pendingExternalMove = false;
    this.lastObserved = {
      scrollTop,
      maxScrollTop: maxNow,
      geometryRevision: this.geometry.revision,
    };
    this.reportScroll(scrollTop);
    if (rangeMoved) this.host.requestCommit(false);
  }

  // ---- Reader input -------------------------------------------------------

  /** Reader input that releases follow (upward wheel, upward keys, drag up). */
  release(_reason: string): void {
    if (this.disposed) return;
    const interruptedGlide = this.glide !== null;
    this.cancelGlide();
    // A reader already reading keeps their anchor, unless they interrupted a
    // smooth jump: then they read where the jump left them.
    if (this.intent.kind === 'read' && !interruptedGlide) return;
    const scrollTop = this.host.readScrollTop();
    const anchor = this.anchorAt(scrollTop, null);
    if (anchor) this.setIntent({ kind: 'read', anchor, screenY: 0 });
  }

  setPointerHeld(held: boolean): void {
    this.pointerHeld = held;
  }

  /** A tap, pinch or cancelled touch has no conversation momentum. */
  setTouchActive(active: boolean, continuesAfterRelease = true): void {
    this.touchActive = active;
    this.momentum = !active && continuesAfterRelease;
    if (active || !continuesAfterRelease) {
      this.gesture = null;
      this.compensationPendingCheck = false;
      this.momentumStats = { compensations: 0, interruptions: 0 };
    }
  }

  /** The native `scrollend` event. */
  onScrollEnd(): void {
    if (this.compensationPendingCheck && !this.scrolledSinceCompensation) {
      this.momentumStats.interruptions += 1;
    }
    if (this.momentum && this.momentumStats.compensations > 0) {
      this.callbacks.onMomentumEnd?.({ ...this.momentumStats });
    }
    this.momentum = false;
    this.compensationPendingCheck = false;
    this.momentumStats = { compensations: 0, interruptions: 0 };
    this.rearmAtGestureBottom();
  }

  // ---- Commands -----------------------------------------------------------

  scrollToBottom(): void {
    if (this.disposed) return;
    this.cancelGlide();
    this.setIntent({ kind: 'follow' });
    this.run('scroll-to-bottom', true);
  }

  /** Put row `index` at the viewport's top edge (outline and search jumps). */
  jumpToIndex(index: number, smooth = false): void {
    if (this.disposed) return;
    const row = this.rows[index];
    if (!row) return;
    this.cancelGlide();
    const anchor = this.anchorForRow(index);
    if (!anchor) return;
    const settle: Intent = { kind: 'read', anchor, screenY: 0 };
    this.setIntent(settle);
    if (smooth && !this.host.prefersReducedMotion()) {
      this.startGlide(row.key, 0, settle);
      return;
    }
    this.run('jump', true);
  }

  /** Hold a just-sent row at the top with room reserved for the reply. */
  anchorToRow(index: number): void {
    if (this.disposed) return;
    const row = this.rows[index];
    if (!row) return;
    this.cancelGlide();
    const settle: Intent = { kind: 'sent', rowKey: row.key };
    this.setIntent(settle);
    if (this.host.prefersReducedMotion()) {
      this.run('send', true);
      return;
    }
    this.refreshViewport(false);
    this.startGlide(row.key, this.contentTop, settle);
  }

  /** The sent row moved or vanished. Rows are keyed, so only a vanished row matters. */
  retargetAnchor(index: number): void {
    if (this.intent.kind !== 'sent') return;
    if (index < 0 || index >= this.rows.length) {
      this.cancelGlide();
      this.setIntent({ kind: 'follow' });
      this.run('anchor-row-gone', true);
    }
  }

  /** Stop acting on the host: the list unmounted. */
  dispose(): void {
    this.disposed = true;
    this.cancelGlide();
  }

  /**
   * Undo `dispose`. React StrictMode's development remount runs an effect's
   * cleanup and then its setup again on the same live component.
   */
  resume(): void {
    this.disposed = false;
  }

  // ---- Reads for consumers (through the list handle) ----------------------

  get isSticky(): boolean {
    return this.sticky;
  }

  get mode(): StickyMode {
    return this.intent.kind;
  }

  get hasCompletedFirstCycle(): boolean {
    return this.firstCycleComplete;
  }

  get currentIntent(): Intent {
    return this.intent;
  }

  get scrollOffset(): number {
    return this.lastObserved?.scrollTop ?? this.host.readScrollTop();
  }

  get viewportSize(): number {
    return this.viewportHeight;
  }

  get scrollSize(): number {
    return this.contentTop + this.geometry.total() + this.replyRoom + this.paddingBottom;
  }

  get snapshot(): ScrollSnapshot {
    return {
      sourceGeneration: this.sourceGeneration,
      geometryRevision: this.geometry.revision,
      scrollTop: this.scrollOffset,
      viewportHeight: this.viewportHeight,
      extent: this.extent,
      contentTop: this.contentTop,
      replyRoom: this.replyRoom,
    };
  }

  /** Item-space offset → row index (clamped), like Virtua's `findItemIndex`. */
  findItemIndex(offset: number): number {
    return Math.max(0, this.geometry.findIndex(offset));
  }

  getItemOffset(index: number): number {
    return this.geometry.offset(index);
  }

  getItemSize(index: number): number {
    return this.geometry.size(index);
  }

  /** The intent to persist: a sent message is saved as following, as today. */
  savedIntent(): Extract<Intent, { kind: 'follow' | 'read' }> {
    return this.intent.kind === 'read' ? this.intent : { kind: 'follow' };
  }

  // ---- Internals ----------------------------------------------------------

  private run(reason: string, sync: boolean, commitFirst = true): void {
    if (this.tx || this.hidden || this.rows.length === 0) return;
    this.beginTransaction(reason, this.committedPlan);
    if (commitFirst) {
      this.host.requestCommit(sync);
      return;
    }
    this.continueTransaction();
  }

  private beginTransaction(reason: string, previousPlan: RenderPlan | null): void {
    // Shown again: the viewport may have resized, and whatever offset the
    // browser kept or reset while it was hidden is not reader movement, so the
    // kept intent is written absolutely.
    const reshown = this.reshown;
    this.reshown = false;
    this.refreshViewport(reshown || !this.viewportKnown);
    if (this.host.isSuppressed() && this.intent.kind === 'follow') this.release('suppressed');
    const sampled = this.host.readScrollTop();
    let movement: MovementClass = 'none';
    if (!reshown && this.lastObserved && Math.abs(sampled - this.lastObserved.scrollTop) >= 0.5) {
      movement = this.classify(sampled);
      this.applyMovement(movement, sampled, previousPlan);
    }
    this.tx = {
      reason,
      pass: 1,
      supplementary: 0,
      worstCase: false,
      frozen: null,
      freezeNextPlan: false,
      sampled,
      movement,
      relative:
        !reshown &&
        this.intent.kind === 'read' &&
        this.lastObserved !== null &&
        !this.glide &&
        !NAVIGATION_REASONS.has(reason),
    };
  }

  private continueTransaction(): void {
    const tx = this.tx;
    if (!tx) return;
    const changed = this.measureCommitted();
    const target = this.targetScrollTop();
    if (tx.supplementary < MAX_SUPPLEMENTARY_COMMITS) {
      const covered = this.isCovered(target, null, true);
      if (changed || !covered) {
        if (tx.supplementary === 0) {
          if (!covered) tx.worstCase = true;
          tx.freezeNextPlan = true;
        }
        tx.supplementary += 1;
        this.host.requestCommit(true);
        return;
      }
    }
    this.writePhase(tx);
  }

  private writePhase(tx: Transaction): void {
    const total = this.geometry.total();
    const bottomLimit = this.contentTop + total;
    let room = this.replyRoom;

    if (this.intent.kind === 'sent') {
      const index = this.geometry.indexOfKey(this.intent.rowKey);
      const usable = this.viewportHeight - this.contentTop - this.paddingBottom;
      if (index < 0) {
        this.cancelGlide();
        this.setIntent({ kind: 'follow' });
      } else if (this.geometry.size(index) > usable) {
        this.cancelGlide();
        this.setIntent({ kind: 'follow' });
      } else {
        const destination = this.geometry.offset(index);
        const needed = destination + this.viewportHeight - this.paddingBottom - bottomLimit;
        if (needed <= 0) {
          this.cancelGlide();
          this.setIntent({ kind: 'follow' });
        } else {
          room = needed;
        }
      }
    }
    if (this.intent.kind === 'follow') room = 0;

    const extentBefore = this.extent;
    const roomBefore = this.replyRoom;
    this.replyRoom = room;
    let target = this.targetScrollTop();
    if (this.intent.kind === 'read' && room > 0) {
      room = Math.min(
        room,
        Math.max(0, target + this.viewportHeight - this.paddingBottom - bottomLimit)
      );
      this.replyRoom = room;
      target = this.targetScrollTop();
    }

    // 1. grow, 2. write, 3. shrink, 4. read back (extent ownership).
    this.recordBottom(Math.max(0, this.host.readScrollHeight() - this.viewportHeight));
    this.host.setExtent(Math.max(extentBefore, total));
    this.host.setReplyRoom(Math.max(roomBefore, room));
    let expected: number;
    if (tx.relative) {
      const delta = target - tx.sampled;
      expected = tx.sampled + delta;
      if (Math.abs(delta) >= 0.5) {
        this.host.scrollBy(delta);
        if (this.momentum) {
          this.momentumStats.compensations += 1;
          this.compensationPendingCheck = true;
          this.scrolledSinceCompensation = false;
        }
      }
    } else {
      expected = target;
      if (Math.abs(this.host.readScrollTop() - target) >= 0.5) this.host.writeScrollTop(target);
    }
    this.host.setExtent(total);
    this.host.setReplyRoom(room);
    this.extent = total;
    const actual = this.host.readScrollTop();
    const maxNow = Math.max(0, this.host.readScrollHeight() - this.viewportHeight);
    this.recordBottom(maxNow);
    const clampedExpected = Math.min(Math.max(0, expected), maxNow);

    if (Math.abs(actual - clampedExpected) > EPSILON_PX) {
      // Movement arrived with the write: adopt it and cover it (step 7).
      if (tx.pass === 1) {
        const anchor = this.anchorAt(actual, null);
        if (anchor && this.intent.kind === 'read') {
          this.intent = { kind: 'read', anchor, screenY: 0 };
        }
        this.tx = {
          ...tx,
          pass: 2,
          supplementary: 0,
          worstCase: false,
          frozen: null,
          freezeNextPlan: false,
          sampled: actual,
          movement: 'unknown',
          relative: false,
        };
        this.host.requestCommit(true);
        return;
      }
      this.pendingExternalMove = true;
      this.finishTransaction(tx, clampedExpected, actual, false);
      return;
    }
    this.pendingExternalMove = false;
    // I3: an uncovered position is never accepted. Write can move the target
    // (sent → follow, reply-room) after the prospective coverage check; mount
    // the worst-case window instead of reporting the hole to React.
    const covered = this.isCovered(actual, this.committedPlan);
    if (!covered && this.requestCoverageCommit(tx)) return;
    if (covered) {
      this.lastObserved = {
        scrollTop: actual,
        maxScrollTop: maxNow,
        geometryRevision: this.geometry.revision,
      };
    }
    this.finishTransaction(tx, clampedExpected, actual, covered);
  }

  private finishTransaction(
    tx: Transaction,
    target: number,
    actual: number,
    accepted: boolean
  ): void {
    this.tx = null;
    const covered = this.isCovered(actual, this.committedPlan);
    this.callbacks.onDiagnostic?.({
      reason: tx.reason,
      intent: this.intent.kind,
      movement: tx.movement,
      target: Math.round(target),
      actual: Math.round(actual),
      clamped: Math.abs(target - actual) > EPSILON_PX,
      supplementaryCommits: tx.supplementary,
      passes: tx.pass,
      covered,
      pendingExternalMove: this.pendingExternalMove,
      ...this.anchorDiagnostic(),
    });
    if (!this.firstCycleComplete) {
      this.firstCycleComplete = true;
      this.callbacks.onFirstCycle?.();
    }
    if (accepted) this.reportScroll(actual);
  }

  /**
   * The last accepted cycle still holds: same geometry, the DOM is at that
   * offset, the intent's target has not moved, and the viewport is covered.
   * Used so a React re-render that did not change the list does not start a
   * new cycle (and does not re-enter `onScroll` from a layout effect).
   */
  private isSettled(): boolean {
    if (this.reshown || !this.firstCycleComplete || this.dirty.size > 0 || this.glide) {
      return false;
    }
    const plan = this.committedPlan;
    const last = this.lastObserved;
    if (!plan || !last) return false;
    if (last.geometryRevision !== this.geometry.revision) return false;
    for (let i = 0; i < plan.keys.length; i += 1) {
      const index = this.geometry.indexOfKey(plan.keys[i]!);
      if (index < 0 || !this.geometry.isMeasured(index)) return false;
    }
    this.refreshViewport(true);
    const scrollTop = this.host.readScrollTop();
    if (Math.abs(scrollTop - last.scrollTop) >= 0.5) return false;
    if (!this.isCovered(scrollTop, plan)) return false;
    return Math.abs(this.targetScrollTop() - scrollTop) <= EPSILON_PX;
  }

  /** Expand the window and commit again; false when this pass is out of commits. */
  private requestCoverageCommit(tx: Transaction): boolean {
    if (tx.supplementary >= MAX_SUPPLEMENTARY_COMMITS) return false;
    if (tx.supplementary === 0) {
      tx.worstCase = true;
      tx.freezeNextPlan = true;
    }
    tx.supplementary += 1;
    this.host.requestCommit(true);
    return true;
  }

  private reportScroll(offset: number): void {
    if (this.lastReportedScroll !== null && Math.abs(this.lastReportedScroll - offset) < 0.5) {
      return;
    }
    this.lastReportedScroll = offset;
    this.callbacks.onScroll?.(offset);
  }

  /** Read the sizes of committed rows that are new, stale or reported dirty. */
  private measureCommitted(): boolean {
    const plan = this.committedPlan;
    if (!plan) return false;
    const keys: string[] = [];
    for (let position = 0; position < plan.keys.length; position += 1) {
      const key = plan.keys[position]!;
      const index = this.geometry.indexOfKey(key);
      if (index < 0) continue;
      if (!this.geometry.isMeasured(index) || this.dirty.has(key)) keys.push(key);
    }
    if (keys.length === 0) return false;
    const heights = this.host.measure(keys);
    let changed = false;
    keys.forEach((key, position) => {
      const height = heights[position];
      this.dirty.delete(key);
      if (height === undefined) return;
      const index = this.geometry.indexOfKey(key);
      if (index < 0) return;
      const row = this.rows[index];
      if (row && !row.fixed && height < this.minRow && !this.reportedMinRow.has(key)) {
        this.reportedMinRow.add(key);
        this.callbacks.onMinRowViolation?.(key, height);
      }
      if (this.geometry.setMeasured(index, height)) changed = true;
    });
    return changed;
  }

  private refreshViewport(force = true): void {
    if (!force && this.viewportKnown) return;
    const height = this.host.readViewportHeight();
    if (height > 0) {
      this.viewportHeight = height;
      this.viewportKnown = true;
    }
    this.contentTop = this.host.readContentTop();
    this.paddingBottom = this.host.readPaddingBottom();
  }

  private maxScrollTop(): number {
    return Math.max(
      0,
      this.contentTop +
        this.geometry.total() +
        this.replyRoom +
        this.paddingBottom -
        this.viewportHeight
    );
  }

  /** The scroll position the current intent (or glide frame) resolves to. */
  private targetScrollTop(): number {
    const max = this.maxScrollTop();
    const clamp = (value: number) => Math.min(Math.max(0, value), max);
    if (this.glide) {
      const index = this.geometry.indexOfKey(this.glide.rowKey);
      if (index >= 0) {
        const progress =
          this.glide.startedAt === null ? 0 : this.glideProgress(this.glide, this.lastFrameTime);
        const screenY =
          this.glide.fromScreenY +
          (this.glide.toScreenY - this.glide.fromScreenY) * easeOutCubic(progress);
        return clamp(this.contentTop + this.geometry.offset(index) - screenY);
      }
    }
    switch (this.intent.kind) {
      case 'follow':
        return max;
      case 'sent': {
        const index = this.geometry.indexOfKey(this.intent.rowKey);
        if (index < 0) return max;
        // The sent row rests where the first row rests: at the content top.
        return clamp(this.geometry.offset(index));
      }
      case 'read': {
        const resolved = resolveAnchor(this.rows, this.intent.anchor, this.geometry);
        if (!resolved) return clamp(this.lastObserved?.scrollTop ?? 0);
        return clamp(
          this.contentTop +
            this.geometry.offset(resolved.index) +
            resolved.offsetPx -
            this.intent.screenY
        );
      }
    }
    return max;
  }

  /** Rows intersecting the viewport at `scrollTop`, plus the overscan. */
  private rangeFor(scrollTop: number): [number, number] {
    const length = this.rows.length;
    if (length === 0) return [0, -1];
    const top = Math.max(0, scrollTop - this.contentTop - this.overscan);
    const bottom = scrollTop - this.contentTop + this.viewportHeight + this.overscan;
    let start = Math.max(0, this.geometry.findIndex(top));
    // `findIndex` answers the LAST row starting at or before `top`; rows before
    // it that end at or after `top` are on that line too (zero-height rows).
    while (start > 0 && this.geometry.offset(start - 1) + this.geometry.size(start - 1) >= top) {
      start -= 1;
    }
    const end = Math.min(length - 1, this.geometry.findIndex(Math.max(0, bottom)));
    return [start, Math.max(start, end)];
  }

  /**
   * The coverage lemma's window: the anchor row and enough rows on each side
   * to fill `(1 + a)` viewports at the minimum row height, plus the fixed rows.
   */
  private worstCaseWindow(): [number, number] {
    const length = this.rows.length;
    const anchor = this.anchorIndex();
    const a = this.glide ? 1 : 0;
    const span = Math.ceil(((1 + a) * this.viewportHeight) / this.minRow) + FIXED_ROW_KINDS.length;
    return [Math.max(0, anchor - span), Math.min(length - 1, anchor + span)];
  }

  private anchorIndex(): number {
    const length = this.rows.length;
    if (this.glide) {
      const index = this.geometry.indexOfKey(this.glide.rowKey);
      if (index >= 0) return index;
    }
    switch (this.intent.kind) {
      case 'follow':
        return length - 1;
      case 'sent': {
        const index = this.geometry.indexOfKey(this.intent.rowKey);
        return index >= 0 ? index : length - 1;
      }
      case 'read':
        return resolveAnchor(this.rows, this.intent.anchor, this.geometry)?.index ?? 0;
    }
    return length - 1;
  }

  /**
   * Whether mounted, measured rows cover the content part of the viewport at
   * `scrollTop`. `prospective` checks the rows the next plan would mount
   * (every row in the interval must be measured and mounted by the last
   * commit or be measured already); otherwise the given committed plan.
   */
  private isCovered(scrollTop: number, plan: RenderPlan | null, prospective = false): boolean {
    const lo = Math.max(scrollTop, this.contentTop);
    const hi = Math.min(scrollTop + this.viewportHeight, this.contentTop + this.geometry.total());
    if (hi - lo <= EPSILON_PX) return true;
    const mounted = new Set((prospective ? this.committedPlan : plan)?.keys ?? []);
    const first = this.geometry.findIndex(lo - this.contentTop);
    const last = this.geometry.findIndex(hi - this.contentTop - EPSILON_PX);
    if (first < 0 || last < 0) return true;
    for (let index = first; index <= last; index += 1) {
      const key = this.rows[index]?.key;
      if (!key || !mounted.has(key) || !this.geometry.isMeasured(index)) return false;
    }
    return true;
  }

  private classify(scrollTop: number): MovementClass {
    const last = this.lastObserved;
    if (!last) return 'none';
    if (Math.abs(scrollTop - last.scrollTop) < 0.5) return 'none';
    const maxNow = Math.max(0, this.host.readScrollHeight() - this.viewportHeight);
    if (
      maxNow < last.maxScrollTop - 0.5 &&
      Math.abs(scrollTop - Math.min(Math.max(0, last.scrollTop), maxNow)) < 0.5
    ) {
      return 'clamp';
    }
    // A fast touch scroll can deliver its first offset after the finger lifts.
    // It is still the reader's movement, including when a resize samples it
    // before its scroll event. Correcting it back to follow would fight the fling.
    if (this.pointerHeld || this.touchActive || this.momentum) return 'reader';
    return 'unknown';
  }

  private applyMovement(
    movement: MovementClass,
    scrollTop: number,
    previousPlan: RenderPlan | null
  ): void {
    if (movement === 'none' || movement === 'own-write') return;
    const last = this.lastObserved;
    // Reader evidence includes a held pointer and post-touch momentum.
    if (
      movement === 'reader' &&
      last &&
      scrollTop < last.scrollTop - EPSILON_PX &&
      this.intent.kind !== 'read'
    ) {
      this.release('drag-up');
      return;
    }
    if (this.intent.kind !== 'read' || movement === 'clamp') return;
    const anchor = this.anchorAt(scrollTop, previousPlan);
    if (anchor) this.intent = { kind: 'read', anchor, screenY: 0 };
  }

  /**
   * The reading anchor at DOM offset `scrollTop`. The DOM shows the layout of
   * the last committed plan, so the anchor is taken from that plan's offsets
   * when it has the row; otherwise from the current geometry.
   */
  private anchorAt(scrollTop: number, plan: RenderPlan | null): ReadingAnchor | null {
    const y = scrollTop - this.contentTop;
    if (plan && plan.keys.length > 0) {
      for (let position = plan.keys.length - 1; position >= 0; position -= 1) {
        const top = plan.offsets[position]!;
        if (top > y) continue;
        const index = this.geometry.indexOfKey(plan.keys[position]!);
        if (index >= 0 && y - top < (plan.sizes[position] ?? 0)) {
          const row = this.rows[index];
          if (row) return anchorOfRow(row, y - top);
        }
        break;
      }
    }
    return deriveAnchor(this.rows, this.geometry, y);
  }

  private anchorForRow(index: number): ReadingAnchor | null {
    const row = this.rows[index];
    if (!row) return null;
    return anchorOfRow(row, 0);
  }

  private anchorDiagnostic(): { anchorKey: string | null; resolvedKey: string | null } {
    if (this.intent.kind !== 'read') return { anchorKey: null, resolvedKey: null };
    const anchor = this.intent.anchor;
    const resolved = resolveAnchor(this.rows, anchor, this.geometry);
    return {
      anchorKey: anchor.kind === 'turn' ? anchor.rowKey : anchor.fixed,
      resolvedKey: resolved ? (this.rows[resolved.index]?.key ?? null) : null,
    };
  }

  private recordBottom(maxScrollTop: number): void {
    const bottoms = this.gesture?.bottoms;
    if (!bottoms || bottoms[bottoms.length - 1] === maxScrollTop) return;
    bottoms.push(maxScrollTop);
    if (bottoms.length > MAX_GESTURE_BOTTOMS) bottoms.shift();
  }

  /**
   * A downward scroll sequence that came to rest at a bottom the range had
   * while it ran reached the end the reader was scrolling to: follow again,
   * even though the rows measured on the way have moved the end further.
   */
  private rearmAtGestureBottom(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (
      !gesture?.down ||
      this.disposed ||
      this.hidden ||
      this.rows.length === 0 ||
      this.tx ||
      this.intent.kind !== 'read' ||
      this.glide ||
      this.pointerHeld ||
      this.host.isSuppressed() ||
      this.replyRoom !== 0
    ) {
      return;
    }
    const scrollTop = this.host.readScrollTop();
    if (!gesture.bottoms.some((bottom) => Math.abs(bottom - scrollTop) <= REARM_DISTANCE_PX)) {
      return;
    }
    this.setIntent({ kind: 'follow' });
    this.run('rearm', true);
  }

  private shrinkReplyRoom(scrollTop: number): void {
    const needed =
      scrollTop +
      this.viewportHeight -
      this.paddingBottom -
      (this.contentTop + this.geometry.total());
    const next = Math.min(this.replyRoom, Math.max(0, needed));
    if (next !== this.replyRoom) {
      this.replyRoom = next;
      this.host.setReplyRoom(next);
    }
  }

  private setIntent(intent: Intent): void {
    this.intent = intent;
    // Explicit navigation or reaching the bottom supersedes the old fling.
    // This also bounds input evidence on hosts without `scrollend` support.
    if (intent.kind !== 'read') this.momentum = false;
    const sticky = intent.kind !== 'read';
    if (sticky !== this.sticky) {
      this.sticky = sticky;
      this.callbacks.onStickyChange?.(sticky);
    }
  }

  // ---- Glide ----------------------------------------------------------------

  private lastFrameTime = 0;

  private glideProgress(glide: Glide, time: number): number {
    if (glide.startedAt === null) return 0;
    return Math.min(1, (time - glide.startedAt) / GLIDE_MS);
  }

  private startGlide(rowKey: string, toScreenY: number, settle: Intent): void {
    // Hidden: the settled intent is already set and is written when shown.
    if (this.hidden) return;
    const index = this.geometry.indexOfKey(rowKey);
    if (index < 0) {
      this.run('glide-missing', true);
      return;
    }
    this.refreshViewport(false);
    const scrollTop = this.host.readScrollTop();
    let fromScreenY = this.contentTop + this.geometry.offset(index) - scrollTop;
    // A glide covers at most one viewport: jump to that distance first.
    const limit = this.viewportHeight;
    if (Math.abs(fromScreenY - toScreenY) > limit) {
      fromScreenY = toScreenY + Math.sign(fromScreenY - toScreenY) * limit;
    }
    this.glide = { rowKey, fromScreenY, toScreenY, startedAt: null, frame: 0, settle };
    this.run('glide-start', true);
    if (this.glide) this.glide.frame = this.host.requestFrame(this.stepGlide);
  }

  private readonly stepGlide = (time: number): void => {
    const glide = this.glide;
    if (!glide || this.disposed) return;
    glide.startedAt ??= time;
    this.lastFrameTime = time;
    const progress = this.glideProgress(glide, time);
    this.run('glide', true);
    if (this.glide !== glide) return;
    if (progress < 1) {
      glide.frame = this.host.requestFrame(this.stepGlide);
      return;
    }
    this.glide = null;
    if (this.intent.kind === glide.settle.kind) this.run('glide-end', true);
  };

  private cancelGlide(): void {
    const glide = this.glide;
    if (!glide) return;
    this.host.cancelFrame(glide.frame);
    this.glide = null;
  }
}
