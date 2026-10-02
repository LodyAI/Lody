import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  IosSimulatorExteriorSchema,
  IOS_SIMULATOR_BEZEL_MAX_BYTES,
  isIosSimulatorBezelPng,
  type IosSimulatorExterior,
  type IosSimulatorDeviceControl,
} from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import {
  IOS_SIMULATOR_VIEWER_INIT,
  IOS_SIMULATOR_VIEWER_VISIBILITY,
  getIosSimulatorAspectRatio,
  parseIosSimulatorViewerState,
} from '@/lib/ios-simulator/ios-simulator-model';
import {
  IOS_SIMULATOR_CAPTURE_TIMEOUT_MS,
  IOS_SIMULATOR_CONTROL_TIMEOUT_MS,
  IOS_SIMULATOR_VIEWER_CONTROL,
  parseIosSimulatorControlResult,
  type IosSimulatorControlResult,
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
  control: (control: IosSimulatorDeviceControl) => Promise<IosSimulatorControlResult>;
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
  /** Mobile keeps the hardware upright while the guest interface changes orientation. */
  rotateWithDevice?: boolean;
  /** The panel is on screen. Combined with the document's own visibility. */
  visible: boolean;
  onStateChange: (state: IosSimulatorViewerState) => void;
  /** The stream's shape changed, e.g. after the device turned. */
  onRotationChange?: (turns: IosSimulatorQuarterTurns) => void;
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
      rotateWithDevice = true,
      visible,
      onStateChange,
      onRotationChange,
      onFullscreenChange,
      onPressButton,
      isPressAvailable,
      buttonLabel,
    },
    ref
  ) {
    const stageRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const parentPort = useRef<MessagePort | null>(null);
    const receivePort = useRef<(event: MessageEvent) => void>(() => {});
    const [loaded, setLoaded] = useState(false);
    const loadedRef = useRef(false);
    loadedRef.current = loaded;
    const [exterior, setExterior] = useState<{
      geometry: IosSimulatorExterior;
      imageUrl: string;
    }>();
    const exteriorUrl = useRef<string | undefined>(undefined);
    useEffect(
      () => () => {
        if (exteriorUrl.current) URL.revokeObjectURL(exteriorUrl.current);
        exteriorUrl.current = undefined;
      },
      [operationId, viewerUrl]
    );
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
    const onRotationChangeRef = useRef(onRotationChange);
    onRotationChangeRef.current = onRotationChange;
    const onFullscreenChangeRef = useRef(onFullscreenChange);
    onFullscreenChangeRef.current = onFullscreenChange;

    useEffect(() => {
      const receive = (event: MessageEvent) => {
        if (
          event.data?.type === 'lody:ios-simulator:exterior' &&
          event.data.operationId === operationId
        ) {
          const parsed = IosSimulatorExteriorSchema.safeParse(event.data.geometry);
          const png: unknown = event.data.png;
          if (
            !parsed.success ||
            !(png instanceof ArrayBuffer) ||
            png.byteLength > IOS_SIMULATOR_BEZEL_MAX_BYTES ||
            png.byteLength < 8
          )
            return;
          if (!isIosSimulatorBezelPng(new Uint8Array(png), parsed.data)) return;
          if (exteriorUrl.current) URL.revokeObjectURL(exteriorUrl.current);
          const imageUrl = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
          exteriorUrl.current = imageUrl;
          setExterior({ geometry: parsed.data, imageUrl });
          return;
        }
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
          const rotation: unknown = event.data.rotation;
          if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270) {
            onRotationChangeRef.current?.(
              rotation === 90 ? 1 : rotation === 180 ? 2 : rotation === 270 ? 3 : 0
            );
          }
        }
        onStateChangeRef.current(state);
      };
      receivePort.current = receive;
      const receiveWindow = (event: MessageEvent) => {
        if (
          parentPort.current ||
          event.source !== frameRef.current?.contentWindow ||
          event.origin !== viewerOrigin
        )
          return;
        receive(event);
      };
      window.addEventListener('message', receiveWindow);
      return () => {
        receivePort.current = () => {};
        window.removeEventListener('message', receiveWindow);
      };
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
      setExterior(undefined);
    }, [viewerUrl]);

    useEffect(() => {
      if (!loaded || sentVisibleRef.current === effectiveVisible) return;
      sentVisibleRef.current = effectiveVisible;
      const message = {
        type: IOS_SIMULATOR_VIEWER_VISIBILITY,
        operationId,
        visible: effectiveVisible,
      };
      if (parentPort.current) parentPort.current.postMessage(message);
      else frameRef.current?.contentWindow?.postMessage(message, viewerOrigin);
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

    const pendingReplies = useRef(new Set<() => void>());
    const controlPending = useRef(false);
    useEffect(
      () => () => {
        for (const cancel of [...pendingReplies.current]) cancel();
        parentPort.current?.close();
        parentPort.current = null;
        loadedRef.current = false;
      },
      [operationId, viewerOrigin, viewerUrl]
    );

    const requestReply = useCallback(
      <Result,>(
        type: string,
        payload: Record<string, unknown>,
        parse: (data: unknown, operation: string, request: string) => Result | null,
        unavailable: Result,
        timeoutResult: Result,
        timeoutMs: number
      ) =>
        new Promise<Result>((resolve) => {
          const frameWindow = frameRef.current?.contentWindow;
          if (!frameWindow || !loadedRef.current || !visibleRef.current) {
            resolve(unavailable);
            return;
          }
          const port = parentPort.current;
          const requestId = crypto.randomUUID();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let settled = false;
          const receive = (event: MessageEvent) => {
            if (
              port
                ? parentPort.current !== port
                : event.source !== frameWindow || event.origin !== viewerOrigin
            )
              return;
            const result = parse(event.data, operationId, requestId);
            if (result !== null) finish(result);
          };
          const finish = (result: Result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (port) port.removeEventListener('message', receive);
            else window.removeEventListener('message', receive);
            pendingReplies.current.delete(cancel);
            resolve(result);
          };
          const cancel = () => finish(unavailable);
          pendingReplies.current.add(cancel);
          timer = setTimeout(() => finish(timeoutResult), timeoutMs);
          if (port) port.addEventListener('message', receive);
          else window.addEventListener('message', receive);
          try {
            const message = { type, operationId, requestId, ...payload };
            if (port) port.postMessage(message);
            else frameWindow.postMessage(message, viewerOrigin);
          } catch {
            finish(unavailable);
          }
        }),
      [operationId, viewerOrigin]
    );

    const capture = useCallback(
      () =>
        requestReply<IosSimulatorCaptureResult>(
          IOS_SIMULATOR_VIEWER_CAPTURE,
          {},
          parseIosSimulatorCaptureResult,
          { ok: false, error: 'unavailable' },
          { ok: false, error: 'timeout' },
          IOS_SIMULATOR_CAPTURE_TIMEOUT_MS
        ),
      [requestReply]
    );
    const control = useCallback(
      async (value: IosSimulatorDeviceControl): Promise<IosSimulatorControlResult> => {
        if (controlPending.current) return { success: false, error: 'busy' };
        controlPending.current = true;
        try {
          return await requestReply<IosSimulatorControlResult>(
            IOS_SIMULATOR_VIEWER_CONTROL,
            { control: value },
            parseIosSimulatorControlResult,
            { success: false, error: 'unavailable' },
            { success: false, error: 'timeout' },
            IOS_SIMULATOR_CONTROL_TIMEOUT_MS
          );
        } finally {
          controlPending.current = false;
        }
      },
      [requestReply]
    );

    useImperativeHandle(
      ref,
      () => ({
        capture,
        control,
        toggleFullscreen: () => {
          const stage = stageRef.current;
          if (!stage) return;
          if (document.fullscreenElement === stage) void document.exitFullscreen();
          else void stage.requestFullscreen?.();
        },
      }),
      [capture, control]
    );

    const handleLoad = () => {
      for (const cancel of [...pendingReplies.current]) cancel();
      sentVisibleRef.current = visibleRef.current;
      parentPort.current?.close();
      parentPort.current = null;
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow) return;
      const init = {
        type: IOS_SIMULATOR_VIEWER_INIT,
        operationId,
        visible: visibleRef.current,
        rotateWithDevice,
      };
      // file:// has no addressable origin. The port is delivered only to this
      // viewer's exact origin and dies with this document's navigation/unmount.
      // Electron reports file:// here but serializes message origins as null.
      if (window.location.protocol === 'file:' || window.origin === 'null') {
        const channel = new MessageChannel();
        parentPort.current = channel.port1;
        channel.port1.onmessage = (event) => {
          if (parentPort.current === channel.port1) receivePort.current(event);
        };
        frameWindow.postMessage(init, viewerOrigin, [channel.port2]);
      } else frameWindow.postMessage(init, viewerOrigin);
      loadedRef.current = true;
      setLoaded(true);
    };

    return (
      <IosSimulatorDeviceFrame
        ref={stageRef}
        hardware={hardware}
        exterior={exterior}
        screenAspect={screenAspect ?? getIosSimulatorAspectRatio(hardware.family)}
        turns={rotateWithDevice ? turns : 0}
        bezel={bezel && !!exterior}
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
