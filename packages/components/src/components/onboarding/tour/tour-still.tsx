import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  cameraAtRest,
  centreFromPose,
  createCameraMotion,
  measureAnchor,
  poseFromMotion,
  resolveAnchor,
  solvePose,
  stepCamera,
  type CameraShot,
} from './camera';
import { TourApp, type TourAppTracks, type TourConfigurationState } from './tour-app';
import { DEFAULT_TOUR_IDENTITY, type TourIdentity } from './tour-fixtures';

// The setup screens' right-hand panel: the same window the film is about,
// standing still.
//
// It shares `TourApp` with the tour rather than having a preview of its own,
// because the previous pair — a hand-assembled `SessionShowcase` here and the
// real thing somewhere else — is exactly how the old panel ended up showing a
// pull-request badge the product had deleted and a composer footer that was a
// line of dead text. One implementation, one place to be wrong.
//
// It uses the tour's camera solver AND physical integrator, so "look at the
// file tree while they pick a project" is the same statement here as it is in
// the film: name a `data-tour-anchor`, solve against the live node, then let one
// camera carry its position and velocity into the next form state. Unlike the
// film it has no story playhead or cursor; its rAF exists only while the camera
// is travelling and stops once the spring has converged.

/** The window's authored size. Scaled to whatever the panel gives it. */
const WINDOW_WIDTH = 1700;
const WINDOW_HEIGHT = 1080;

/** A settled, mid-run state: enough on screen that the window looks lived-in. */
const STILL_TRACKS: TourAppTracks = {
  reveal: 9,
  tasks: 4,
  archived: 0,
  childTabs: 1,
  subagents: 0,
  panel: 0,
  changes: 0,
  terminal: 0,
  annotation: 0,
  pr: 0,
  typing: 0,
};

export interface TourStillDebugOptions {
  showAnchors?: boolean;
  activeAnchor?: string;
}

// Memoised: the host re-renders for reasons of its own (an agent's download
// ticking in the setup panel), and each of those used to re-render the whole
// real product tree underneath.
export const TourStill = memo(function TourStill({
  identity = DEFAULT_TOUR_IDENTITY,
  shot = { anchor: 'window', padding: 26 },
  tracks,
  configurationState,
  debug,
  overlay,
  windowShadow = '0 30px 80px -30px rgba(4,12,40,0.7)',
  windowSize,
  tilt = false,
}: {
  identity?: TourIdentity;
  /** What to frame. Defaults to the whole window. */
  shot?: CameraShot;
  /** Configuration state projected into the real product fixture. */
  tracks?: Partial<TourAppTracks>;
  /** Form state projected into the real product surfaces. */
  configurationState?: TourConfigurationState;
  /** Development-only visual diagnostics for camera authoring stories. */
  debug?: TourStillDebugOptions;
  /**
   * Drawn over the window in the window's own coordinates, so it moves with
   * every shot: the onboarding blueprint's pencil layer lives here.
   */
  overlay?: ReactNode;
  /** The window's shadow on the stage it stands on. */
  windowShadow?: string;
  /**
   * Re-lays the product out at another window size. The onboarding handoff
   * uses it to make the window exactly the screen it is about to become.
   */
  windowSize?: { width: number; height: number };
  /**
   * Lean the window with the camera's velocity while it travels, as a real
   * dolly shot does, and settle level when the camera parks.
   */
  tilt?: boolean;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef(createCameraMotion());
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const inputsRef = useRef({ shot, tilt });
  inputsRef.current = { shot, tilt };
  const resolvedTracks = useMemo(() => ({ ...STILL_TRACKS, ...tracks }), [tracks]);

  const startCamera = useCallback((): void => {
    if (rafRef.current !== null) return;

    // Compose the very first shot synchronously during layout. The onboarding
    // surface should already be parked when it becomes visible; springs are
    // reserved for later shot/state changes, not initial entry.
    const initialViewport = viewportRef.current;
    const initialContent = contentRef.current;
    if (cameraRef.current.scale <= 0 && initialViewport && initialContent) {
      const size = {
        width: initialViewport.clientWidth,
        height: initialViewport.clientHeight,
      };
      if (size.width > 0 && size.height > 0) {
        const currentShot = inputsRef.current.shot;
        const rect = measureAnchor(initialContent, currentShot.anchor, 1) ?? {
          x: 0,
          y: 0,
          w: WINDOW_WIDTH,
          h: WINDOW_HEIGHT,
        };
        const target = centreFromPose(solvePose(rect, size, currentShot), size);
        cameraRef.current = {
          ...target,
          velocity: { scale: 0, centreX: 0, centreY: 0 },
        };
        const pose = poseFromMotion(cameraRef.current, size);
        initialContent.style.transform = `translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, 0) scale(${pose.scale.toFixed(4)})`;
        initialContent.style.visibility = 'visible';
      }
    }

    lastFrameRef.current = null;

    const frame = (now: number): void => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content) {
        rafRef.current = null;
        return;
      }
      const size = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (size.width === 0 || size.height === 0) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      const currentShot = inputsRef.current.shot;
      const applied = cameraRef.current.scale > 0 ? cameraRef.current.scale : 1;
      // Measure level. A perspective tilt distorts every rect under it, and a
      // camera that aims at distorted rects parks in the wrong place.
      if (viewport.style.transform) viewport.style.transform = '';
      const rect = measureAnchor(content, currentShot.anchor, applied) ?? {
        x: 0,
        y: 0,
        w: WINDOW_WIDTH,
        h: WINDOW_HEIGHT,
      };
      const target = centreFromPose(solvePose(rect, size, currentShot), size);
      const dt =
        lastFrameRef.current === null ? 0 : Math.min(0.05, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;
      cameraRef.current = stepCamera(cameraRef.current, target, dt);

      if (cameraAtRest(cameraRef.current, target)) {
        cameraRef.current = {
          ...target,
          velocity: { scale: 0, centreX: 0, centreY: 0 },
        };
      }
      const pose = poseFromMotion(cameraRef.current, size);
      content.style.transform = `translate3d(${pose.x.toFixed(2)}px, ${pose.y.toFixed(2)}px, 0) scale(${pose.scale.toFixed(4)})`;
      content.style.visibility = 'visible';
      if (inputsRef.current.tilt) {
        // Screen-space velocity, in px/s. A few degrees at the fastest pan:
        // felt as weight, not seen as a trick.
        const vx = cameraRef.current.velocity.centreX * pose.scale;
        const vy = cameraRef.current.velocity.centreY * pose.scale;
        const clamp = (value: number): number => Math.max(-3.2, Math.min(3.2, value));
        const yaw = clamp(vx * 0.0016);
        const pitch = clamp(-vy * 0.0016);
        viewport.style.transform =
          Math.abs(yaw) + Math.abs(pitch) < 0.02
            ? ''
            : `perspective(2200px) rotateY(${yaw.toFixed(3)}deg) rotateX(${pitch.toFixed(3)}deg)`;
      }

      if (cameraAtRest(cameraRef.current, target)) {
        viewport.style.transform = '';
        rafRef.current = null;
        lastFrameRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
  }, []);

  // A form-state or shot change re-aims the SAME camera. The motion state is
  // deliberately not reset, so a change mid-flight curves toward its new
  // anchor instead of restarting from an arbitrary pose.
  useLayoutEffect(startCamera, [
    configurationState,
    identity,
    resolvedTracks,
    shot.anchor,
    shot.maxScale,
    shot.minScale,
    shot.padding,
    shot.focusX,
    shot.focusY,
    shot.zoom,
    startCamera,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    // jsdom has no ResizeObserver; the first layout pass is already correct for
    // a panel that does not resize, so its absence degrades to "no live
    // updates" rather than throwing and taking the screen down.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(startCamera);
    observer.observe(viewport);
    // The window itself resizes too (`windowSize` animates), and a camera
    // parked on its old size would frame a window that is no longer there.
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [startCamera]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    []
  );

  return (
    <div ref={viewportRef} className="relative h-full w-full overflow-clip">
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: windowSize?.width ?? WINDOW_WIDTH,
          height: windowSize?.height ?? WINDOW_HEIGHT,
          // Only the size moves on its own; position and scale are the camera's.
          transition: 'width 700ms cubic-bezier(.3,0,.1,1), height 700ms cubic-bezier(.3,0,.1,1)',
          boxShadow: windowShadow,
          borderRadius: 14,
          visibility: 'hidden',
        }}
        ref={(node) => {
          contentRef.current = node;
        }}
      >
        {/* Its own stacking context: a raised node inside the product (the
            composer's card) must not climb over whatever is drawn above it. */}
        <div style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%' }}>
          <TourApp
            identity={identity}
            tracks={resolvedTracks}
            configurationState={configurationState}
            permissionAnswer="allow"
            onPermissionAnswer={() => undefined}
            activeSidePanelTab="files"
            onSidePanelTabSelect={() => undefined}
            selectedTaskId="tour-1"
            activeTabIndex={0}
            onSelectTabIndex={() => undefined}
          />
        </div>
        {overlay}
        {debug?.showAnchors ? (
          <TourAnchorDebugOverlay
            activeAnchor={debug.activeAnchor}
            cameraRef={cameraRef}
            contentRef={contentRef}
          />
        ) : null}
      </div>
    </div>
  );
});

const DEBUG_ANCHORS = [
  'window',
  'sidebar',
  'sidebar.workspace-name',
  'stream',
  'composer',
  'composer.run-config',
  'permission',
  'tab-bar',
  'info-bar',
  'side-panel',
  'terminal',
  'studio',
  'phone',
] as const;

function TourAnchorDebugOverlay({
  activeAnchor,
  cameraRef,
  contentRef,
}: {
  activeAnchor?: string;
  cameraRef: MutableRefObject<ReturnType<typeof createCameraMotion>>;
  contentRef: MutableRefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      const content = contentRef.current;
      const overlay = overlayRef.current;
      if (content && overlay) {
        const contentRect = content.getBoundingClientRect();
        const appliedScale = cameraRef.current.scale > 0 ? cameraRef.current.scale : 1;
        for (const marker of overlay.querySelectorAll<HTMLElement>('[data-debug-anchor]')) {
          const anchor = marker.dataset.debugAnchor;
          if (!anchor) continue;
          const node = resolveAnchor(content, anchor);
          if (!node) {
            marker.style.display = 'none';
            continue;
          }
          const rect = node.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) {
            marker.style.display = 'none';
            continue;
          }
          marker.style.display = 'block';
          marker.style.transform = `translate(${(rect.left - contentRect.left) / appliedScale}px, ${(rect.top - contentRect.top) / appliedScale}px)`;
          marker.style.width = `${rect.width / appliedScale}px`;
          marker.style.height = `${rect.height / appliedScale}px`;
        }
      }
      frame = requestAnimationFrame(update);
    };

    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, contentRef]);

  return (
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-[100]">
      {DEBUG_ANCHORS.map((anchor) => {
        const active = activeAnchor === anchor;
        return (
          <div
            key={anchor}
            data-debug-anchor={anchor}
            className={`absolute left-0 top-0 rounded-sm border ${
              active
                ? 'border-amber-300 bg-amber-300/15 shadow-[0_0_0_2px_rgba(251,191,36,0.22)]'
                : 'border-cyan-300/70 bg-cyan-300/5'
            }`}
          >
            <span
              className={`absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                active ? 'bg-amber-300 text-slate-950' : 'bg-cyan-300 text-slate-950'
              }`}
            >
              {anchor}
            </span>
          </div>
        );
      })}
    </div>
  );
}
