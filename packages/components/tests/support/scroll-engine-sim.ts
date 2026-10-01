import {
  ScrollController,
  type ControllerOptions,
  type RenderPlan,
  type ScrollHost,
} from '../../src/lib/conversation-scroll/controller';
import type { EngineRow, FixedRowKind } from '../../src/lib/conversation-scroll/types';

/**
 * A browser-semantics simulator for the scroll engine's model tests.
 *
 * It implements {@link ScrollHost} over a fake DOM with the semantics the
 * scroll-engine note requires the model to follow literally:
 *
 * - a `scrollTop` write clamps to the scroll range at the moment of the write;
 *   `scrollBy` adds to the current value;
 * - a frame dispatches at most one scroll event, when the offset changed since
 *   the last frame (even if it changed back);
 * - scroll steps run before ResizeObserver delivery;
 * - the observer delivers a mounted row only when its size differs from the
 *   size last delivered for it;
 * - commits requested during a task run at the end of that task, in order
 *   (React processes layout-effect updates before paint);
 * - a hidden viewport (`display: none`) has no box: every offset and size reads
 *   0, writes are dropped, and hiding loses the scroll offset.
 *
 * Rows have a true height the engine never sees except by measuring mounted
 * rows. The scroll range is the content top, the rows container (its extent,
 * or the lowest mounted row if a row overflows — the container clips, so it
 * cannot), the reply room and the bottom padding.
 */
export interface SimRow {
  key: string;
  turnId: string | null;
  turnIndex: number;
  itemIndex?: number | null;
  fixed?: FixedRowKind | null;
  placeholder?: boolean;
  height: number;
  estimate: number;
}

export class ScrollSim implements ScrollHost {
  controller: ScrollController;
  rows: SimRow[];
  viewport: number;
  contentTop = 24;
  paddingBottom = 24;
  top = 0;
  extent = 0;
  replyRoom = 0;
  mounted = new Map<string, number>();
  delivered = new Map<string, number>();
  commits = 0;
  commitsThisTask = 0;
  maxCommitsPerTask = 0;
  writes: Array<{ kind: 'write' | 'by'; value: number }> = [];
  pendingScroll = false;
  suppressed = false;
  reducedMotion = true;
  hidden = false;
  /** Applied to every `scrollBy`: models a scrollbar drag overriding it. */
  dragOverride: number | null = null;
  private queued = false;
  private frames: Array<(time: number) => void> = [];
  private time = 0;
  private sourceGeneration = 1;

  constructor(rows: SimRow[], viewport: number, options: Omit<ControllerOptions, 'host'> = {}) {
    this.rows = rows;
    this.viewport = viewport;
    this.controller = new ScrollController({
      ...options,
      host: this,
      initialViewportHeight: viewport,
    });
  }

  // ---- ScrollHost ---------------------------------------------------------

  readScrollTop() {
    return this.hidden ? 0 : Math.min(this.top, this.maxTop());
  }
  readScrollHeight() {
    if (this.hidden) return 0;
    return this.contentTop + this.extent + this.replyRoom + this.paddingBottom;
  }
  readViewportHeight() {
    return this.hidden ? 0 : this.viewport;
  }
  readContentTop() {
    return this.hidden ? 0 : this.contentTop;
  }
  readPaddingBottom() {
    return this.paddingBottom;
  }
  measure(keys: readonly string[]) {
    return keys.map((key) =>
      this.mounted.has(key)
        ? this.hidden
          ? 0
          : this.rows.find((row) => row.key === key)?.height
        : undefined
    );
  }
  setExtent(px: number) {
    this.extent = px;
    this.clampNow();
  }
  setReplyRoom(px: number) {
    this.replyRoom = px;
    this.clampNow();
  }
  writeScrollTop(value: number) {
    this.writes.push({ kind: 'write', value });
    if (this.hidden) return;
    this.setTop(value);
  }
  scrollBy(delta: number) {
    this.writes.push({ kind: 'by', value: delta });
    if (this.hidden) return;
    if (this.dragOverride !== null) {
      // A held scrollbar thumb maps to an absolute offset and wins.
      this.setTop(this.dragOverride);
      return;
    }
    this.setTop(this.readScrollTop() + delta);
  }
  requestCommit() {
    this.queued = true;
  }
  isSuppressed() {
    return this.suppressed;
  }
  prefersReducedMotion() {
    return this.reducedMotion;
  }
  requestFrame(callback: (time: number) => void) {
    this.frames.push(callback);
    return this.frames.length;
  }
  cancelFrame(handle: number) {
    this.frames[handle - 1] = () => {};
  }

  // ---- Driving ------------------------------------------------------------

  engineRows(): EngineRow[] {
    return this.rows.map((row) => ({
      key: row.key,
      turnId: row.turnId,
      turnIndex: row.turnIndex,
      itemIndex: row.itemIndex ?? null,
      itemIdentity: null,
      firstItemIndex: row.itemIndex ?? null,
      placeholder: row.placeholder ?? false,
      fixed: row.fixed ?? null,
      estimate: row.estimate,
    }));
  }

  /** One task: `action`, then every commit it requested, like React before paint. */
  task(action: () => void = () => {}) {
    this.commitsThisTask = 0;
    action();
    this.drain();
    this.maxCommitsPerTask = Math.max(this.maxCommitsPerTask, this.commitsThisTask);
  }

  /** A React render of new rows (props changed), then its commit. */
  render(rows?: SimRow[]) {
    if (rows) this.rows = rows;
    this.task(() => this.commit());
  }

  /** One frame: the scroll event if the offset changed, then ResizeObserver delivery. */
  frame() {
    this.time += 16;
    const callbacks = this.frames;
    this.frames = [];
    for (const callback of callbacks) this.task(() => callback(this.time));
    this.clampNow();
    if (this.pendingScroll) {
      this.pendingScroll = false;
      this.task(() => this.controller.onScrollEvent());
    }
    const entries: Array<{ key: string; height: number }> = [];
    for (const key of this.mounted.keys()) {
      const found = this.rows.find((row) => row.key === key)?.height;
      const height = found === undefined ? undefined : this.hidden ? 0 : found;
      if (height === undefined) continue;
      if (this.delivered.get(key) === height) continue;
      this.delivered.set(key, height);
      entries.push({ key, height });
    }
    if (entries.length) this.task(() => this.controller.onRowsResized(entries));
    return this.pendingScroll || entries.length > 0 || this.frames.length > 0;
  }

  /** Frames until nothing is delivered. */
  settle(limit = 40) {
    for (let i = 0; i < limit; i++) if (!this.frame()) return;
    throw new Error('the simulator did not settle');
  }

  /** The reader scrolls natively (no engine write). */
  nativeScroll(offset: number) {
    this.setTop(offset);
  }

  /**
   * Hide or show the viewport as an inactive tab is (`display: none` in the
   * commit that deactivates it), then deliver the viewport's resize.
   */
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) this.top = 0;
    this.render();
    this.task(() => this.controller.onViewportResized());
  }

  resizeViewport(height: number) {
    this.viewport = height;
    this.clampNow();
    this.task(() => this.controller.onViewportResized());
  }

  // ---- Observations for invariants ----------------------------------------

  maxTop() {
    return Math.max(0, this.readScrollHeight() - this.viewport);
  }

  /** Whether mounted rows, at their committed tops and true heights, cover the viewport's content part. */
  covered(): boolean {
    const scrollTop = this.readScrollTop();
    const lo = Math.max(scrollTop, this.contentTop) - this.contentTop;
    const hi = Math.min(scrollTop + this.viewport, this.contentTop + this.extent) - this.contentTop;
    if (hi - lo <= 1) return true;
    const spans = [...this.mounted]
      .map(([key, top]) => {
        const height = this.rows.find((row) => row.key === key)?.height ?? 0;
        return [top, top + height] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    let reach = lo;
    for (const [start, end] of spans) {
      if (start > reach + 1) break;
      reach = Math.max(reach, end);
      if (reach >= hi - 1) return true;
    }
    return reach >= hi - 1;
  }

  /** Where row `key` is on screen (its top relative to the viewport top), or null if unmounted. */
  screenTop(key: string): number | null {
    const top = this.mounted.get(key);
    return top === undefined ? null : this.contentTop + top - this.readScrollTop();
  }

  // ---- Internals ----------------------------------------------------------

  private commit() {
    this.commits += 1;
    this.commitsThisTask += 1;
    if (this.commitsThisTask > 50) throw new Error('commit loop');
    this.controller.setHidden(this.hidden);
    this.controller.syncRows(this.engineRows(), this.sourceGeneration);
    const plan: RenderPlan = this.controller.plan();
    this.mounted = new Map(plan.keys.map((key, position) => [key, plan.offsets[position]!]));
    this.controller.afterCommit();
  }

  private drain() {
    let guard = 0;
    while (this.queued) {
      this.queued = false;
      this.commit();
      if (++guard > 50) throw new Error('commit loop');
    }
  }

  private setTop(value: number) {
    const next = Number.isFinite(value) ? Math.min(Math.max(0, value), this.maxTop()) : 0;
    if (next !== this.top) this.pendingScroll = true;
    this.top = next;
  }

  private clampNow() {
    const clamped = Math.min(this.top, this.maxTop());
    if (clamped !== this.top) {
      this.top = clamped;
      this.pendingScroll = true;
    }
  }
}

export const turnRows = (
  count: number,
  height: (index: number) => number,
  estimate: (index: number) => number = () => 60,
  prefix = 't'
): SimRow[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `${prefix}${index}`,
    turnId: `${prefix}${index}`,
    turnIndex: index,
    itemIndex: null,
    height: height(index),
    estimate: estimate(index),
  }));
