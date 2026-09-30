import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  IOS_SIMULATOR_VIEWER_INIT,
  IOS_SIMULATOR_VIEWER_VISIBILITY,
  getIosSimulatorAspectRatio,
  parseIosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-model';
import {
  IOS_SIMULATOR_CAPTURE_TIMEOUT_MS,
  IOS_SIMULATOR_VIEWER_CAPTURE,
  parseIosSimulatorCaptureResult,
  type IosSimulatorCaptureResult,
} from '@/lib/ios-simulator/ios-simulator-controls';
import type {
  IosSimulatorButtonName,
  IosSimulatorHardware,
  IosSimulatorHardwareButton,
  IosSimulatorQuarterTurns,
} from '@/lib/ios-simulator/ios-simulator-hardware';
import type { IosSimulatorViewerState } from '@/lib/ios-simulator/ios-simulator-types';
import { IosSimulatorDeviceFrame } from './ios-simulator-device-frame';

const styles = stylex.create({
  frame: {
    display: 'block',
    width: '100%',
    height: '100%',
    borderWidth: 0,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
});

export type IosSimulatorViewerHandle = {
  /** Asks the viewer for the pixels it is showing now. Never rejects. */
  capture: () => Promise<IosSimulatorCaptureResult>;
  toggleFullscreen: () => void;
};

export type IosSimulatorViewerProps = {
  viewerUrl: string;
  /** Exact origin of `viewerUrl`, already checked not to be the app's own. */
  viewerOrigin: string;
  operationId: string;
  title: string;
  hardware: IosSimulatorHardware;
  turns: IosSimulatorQuarterTurns;
  bezel: boolean;
  /** The panel is on screen. Combined with the document's own visibility. */
  visible: boolean;
  onStateChange: (state: IosSimulatorViewerState) => void;
  /** The stream's shape changed, e.g. after the device turned. */
  onScreenAspectChange?: (aspect: number) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onPressButton?: (button: IosSimulatorButtonName) => void;
  isPressAvailable?: (button: IosSimulatorButtonName) => boolean;
  buttonLabel: (button: IosSimulatorHardwareButton) => string;
};

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

/**
 * The simulator's screen inside its device, fitted whole inside the panel. The
 * page inside is the machine's dedicated viewer, which draws frames and forwards
 * input itself; this frame sizes it and runs the handshake.
 *
 * After each load the panel sends `init` to the frame's exact origin, and from
 * then on accepts `state` and `capture-result` only from that frame's window,
 * that origin and that operation. Hiding the panel does not unmount the frame —
 * it tells the viewer it is hidden, and the viewer pauses its stream.
 */
export const IosSimulatorViewer = forwardRef<IosSimulatorViewerHandle, IosSimulatorViewerProps>(
  function IosSimulatorViewer(
    {
      viewerUrl,
      viewerOrigin,
      operationId,
      title,
      hardware,
      turns,
      bezel,
      visible,
      onStateChange,
      onScreenAspectChange,
      onFullscreenChange,
      onPressButton,
      isPressAvailable,
      buttonLabel,
    },
    ref
  ) {
    const stageRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [loaded, setLoaded] = useState(false);
    const loadedRef = useRef(false);
    loadedRef.current = loaded;
    const [screenAspect, setScreenAspect] = useState<number | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const firstFrameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const sentVisibleRef = useRef<boolean | null>(null);
    const documentVisible = useDocumentVisible();
    const effectiveVisible = visible && documentVisible;
    const visibleRef = useRef(effectiveVisible);
    visibleRef.current = effectiveVisible;
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    const onScreenAspectChangeRef = useRef(onScreenAspectChange);
    onScreenAspectChangeRef.current = onScreenAspectChange;
    const onFullscreenChangeRef = useRef(onFullscreenChange);
    onFullscreenChangeRef.current = onFullscreenChange;

    useEffect(() => {
      const receive = (event: MessageEvent) => {
        const frameWindow = frameRef.current?.contentWindow;
        if (!frameWindow || event.source !== frameWindow || event.origin !== viewerOrigin) return;
        const state = parseIosSimulatorViewerState(event.data, operationId);
        if (!state) return;
        if (state !== 'connecting') clearTimeout(firstFrameTimer.current);
        const { width, height } = event.data;
        if (
          state === 'ready' &&
          Number.isInteger(width) &&
          Number.isInteger(height) &&
          width > 0 &&
          height > 0 &&
          width <= 16384 &&
          height <= 16384
        ) {
          setScreenAspect(width / height);
          onScreenAspectChangeRef.current?.(width / height);
        }
        onStateChangeRef.current(state);
      };
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    }, [operationId, viewerOrigin]);

    // A failed iframe navigation may never send a state. Offer Restore instead of
    // leaving a blank screen indefinitely, including after returning to the panel.
    useEffect(() => {
      if (!effectiveVisible) return undefined;
      firstFrameTimer.current = setTimeout(() => onStateChangeRef.current('error'), 25_000);
      return () => clearTimeout(firstFrameTimer.current);
    }, [effectiveVisible, viewerUrl, operationId]);

    // A new address is a new document: it has to be greeted again.
    useEffect(() => {
      setLoaded(false);
      setScreenAspect(null);
    }, [viewerUrl]);

    useEffect(() => {
      if (!loaded || sentVisibleRef.current === effectiveVisible) return;
      sentVisibleRef.current = effectiveVisible;
      frameRef.current?.contentWindow?.postMessage(
        { type: IOS_SIMULATOR_VIEWER_VISIBILITY, operationId, visible: effectiveVisible },
        viewerOrigin
      );
    }, [effectiveVisible, loaded, operationId, viewerOrigin]);

    useEffect(() => {
      const update = () => {
        const next = Boolean(stageRef.current) && document.fullscreenElement === stageRef.current;
        setFullscreen(next);
        onFullscreenChangeRef.current?.(next);
      };
      document.addEventListener('fullscreenchange', update);
      return () => document.removeEventListener('fullscreenchange', update);
    }, []);

    const capture = useCallback(
      () =>
        new Promise<IosSimulatorCaptureResult>((resolve) => {
          const frameWindow = frameRef.current?.contentWindow;
          if (!frameWindow || !loadedRef.current) {
            resolve({ ok: false, error: 'unavailable' });
            return;
          }
          // One request, one answer: the id binds the reply to this click.
          const requestId = crypto.randomUUID();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const receive = (event: MessageEvent) => {
            if (event.source !== frameWindow || event.origin !== viewerOrigin) return;
            const result = parseIosSimulatorCaptureResult(event.data, operationId, requestId);
            if (result) finish(result);
          };
          const finish = (result: IosSimulatorCaptureResult) => {
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            resolve(result);
          };
          timer = setTimeout(
            () => finish({ ok: false, error: 'timeout' }),
            IOS_SIMULATOR_CAPTURE_TIMEOUT_MS
          );
          window.addEventListener('message', receive);
          frameWindow.postMessage(
            { type: IOS_SIMULATOR_VIEWER_CAPTURE, operationId, requestId },
            viewerOrigin
          );
        }),
      [operationId, viewerOrigin]
    );

    useImperativeHandle(
      ref,
      () => ({
        capture,
        toggleFullscreen: () => {
          const stage = stageRef.current;
          if (!stage) return;
          if (document.fullscreenElement === stage) void document.exitFullscreen();
          else void stage.requestFullscreen?.();
        },
      }),
      [capture]
    );

    const handleLoad = () => {
      sentVisibleRef.current = visibleRef.current;
      frameRef.current?.contentWindow?.postMessage(
        { type: IOS_SIMULATOR_VIEWER_INIT, operationId, visible: visibleRef.current },
        viewerOrigin
      );
      setLoaded(true);
    };

    return (
      <IosSimulatorDeviceFrame
        ref={stageRef}
        hardware={hardware}
        screenAspect={screenAspect ?? getIosSimulatorAspectRatio(hardware.family)}
        turns={turns}
        bezel={bezel}
        fullscreen={fullscreen}
        onPress={onPressButton}
        isPressAvailable={isPressAvailable}
        buttonLabel={buttonLabel}
      >
        <iframe
          ref={frameRef}
          {...stylex.props(styles.frame)}
          src={viewerUrl}
          title={title}
          draggable={false}
          referrerPolicy="no-referrer"
          // The handshake names the viewer's exact origin, so the frame keeps it.
          // That is safe only because `getIosSimulatorViewerOrigin` rejects a
          // viewer on the app's own origin; everything else stays sandboxed.
          // oxlint-disable-next-line react/iframe-missing-sandbox
          sandbox="allow-scripts allow-same-origin"
          onLoad={handleLoad}
        />
      </IosSimulatorDeviceFrame>
    );
  }
);
