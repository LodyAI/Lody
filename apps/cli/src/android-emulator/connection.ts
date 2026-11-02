import { AndroidStream } from './input-stream';
import { androidEncoderOptions, createAndroidViewerIdleTimeout } from './preview-policy';
import { runAndroidControl, setAndroidAppearance } from './control-task';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { AdbServerClient } from '@yume-chan/adb';
import { createAdbConnector } from './adb-connector';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import type { AndroidKeyCode } from '@yume-chan/scrcpy';
import { ReadableStream } from '@yume-chan/stream-extra';
import type { AndroidEmulatorQuality, DevicePreviewControl } from '@lody/shared';
import type { DevicePreviewBackend } from '../device-preview/backend';
import { createDevicePreviewGateway } from '../device-preview/gateway';
import type { DeviceConnection } from '../device-preview/service';
import { annexBToAvcc, avcConfiguration } from './h264';
import { resolveAndroidSerial } from './devices';
import { verifyScrcpy } from './runtime';

export async function openAndroidConnection(
  runtime: string,
  name: string,
  signal: AbortSignal,
  quality?: AndroidEmulatorQuality
): Promise<DeviceConnection> {
  const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const bytes = await readFile(runtime);
  verifyScrcpy(bytes);
  const serial = await resolveAndroidSerial(name, startupSignal);
  const lifetime = new AbortController();
  const connector = createAdbConnector(lifetime.signal);
  const client = new AdbServerClient(connector);
  const abort = () => lifetime.abort();
  startupSignal.addEventListener('abort', abort, { once: true });
  let scrcpy:
    | Awaited<ReturnType<typeof AdbScrcpyClient.start<AdbScrcpyOptions3_3_3<true>>>>
    | undefined;
  try {
    startupSignal.throwIfAborted();
    const adb = await client.createAdb({ serial });
    const remoteFile = '/data/local/tmp/lody-scrcpy-3.3.3.jar';
    await AdbScrcpyClient.pushServer(
      adb,
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      remoteFile
    );
    scrcpy = await AdbScrcpyClient.start(
      adb,
      remoteFile,
      new AdbScrcpyOptions3_3_3({
        video: true,
        audio: false,
        control: true,
        tunnelForward: true,
        videoCodec: 'h264',
        ...androidEncoderOptions(quality),
        clipboardAutosync: false,
        scid: randomBytes(4).readUInt32BE(0).toString(16).slice(0, 7),
      })
    );
    const capture = scrcpy;
    const controller = capture.controller!;
    const output = capture.output.getReader();
    const drainOutput = (async () => {
      try {
        while (!(await output.read()).done) {
          /* Never retain guest output. */
        }
      } finally {
        output.releaseLock();
      }
    })();
    void drainOutput.catch(abort);
    const video = await capture.videoStream;
    const reader = video.stream.getReader();
    const viewers = new Set<AndroidStream>();
    let finishIdle = () => {};
    const idleClosed = new Promise<void>((resolve) => {
      finishIdle = resolve;
    });
    const idle = createAndroidViewerIdleTimeout(() => finishIdle());
    let configuration: Buffer | undefined;
    let nextPointer = 1n;
    let clipboardSequence = 1n;
    let resetting: Promise<void> | undefined;
    const reset = () =>
      (resetting ??= controller.resetVideo().finally(() => {
        resetting = undefined;
      }));
    const openStream = () => {
      const pointer = nextPointer++ * 2n;
      const leave = idle.attach();
      const stream = new AndroidStream({
        open: async () => {
          if (configuration) stream.emit('message', configuration, true);
          await reset();
        },
        write: async (message) => {
          const m = JSON.parse(message);
          if (m.type === 'force_idr') {
            await reset();
            return;
          }
          // One fixed encoder budget per device; per-viewer credits remain in the common gateway.
          if (!String(m.type).startsWith('touch')) return;
          const action = m.type.endsWith('-up') ? 1 : m.type.endsWith('-down') ? 0 : 2;
          const points = m.type.startsWith('touch2')
            ? [
                [m.x1, m.y1],
                [m.x2, m.y2],
              ]
            : [[m.x, m.y]];
          for (let i = 0; i < points.length; i++)
            await controller.injectTouch({
              action,
              pointerId: pointer + BigInt(i),
              pointerX: Math.round(points[i]![0]),
              pointerY: Math.round(points[i]![1]),
              videoWidth: m.width,
              videoHeight: m.height,
              pressure: action === 1 ? 0 : 1,
              actionButton: 0,
              buttons: 0,
            });
        },
        dispose: () => {
          viewers.delete(stream);
          leave();
        },
      });
      viewers.add(stream);
      return stream;
    };
    const pump = (async () => {
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          const packet = result.value;
          const data = Buffer.from(packet.data);
          let message: Buffer;
          if (packet.type === 'configuration') {
            message = Buffer.concat([Buffer.from([1]), avcConfiguration(data)]);
            configuration = message;
          } else
            message = Buffer.concat([Buffer.from([packet.keyframe ? 2 : 3]), annexBToAvcc(data)]);
          for (const stream of viewers)
            if (stream.readyState === 1) stream.emit('message', message, true);
        }
      } finally {
        reader.releaseLock();
        for (const stream of viewers) stream.terminate();
      }
    })();
    void pump.catch(abort);
    const execute = async (control: DevicePreviewControl) => {
      if (control.kind === 'appearance') {
        await setAndroidAppearance(adb.subprocess.shellProtocol, control.appearance);
        return;
      }
      if (control.kind === 'text') {
        await controller.setClipboard({
          sequence: clipboardSequence++,
          paste: true,
          content: control.text,
        });
        return;
      }
      if (control.kind === 'rotate') {
        await controller.rotateDevice();
        return;
      }
      if (control.kind === 'button') {
        const key = { home: 3, back: 4, 'app-switcher': 187 }[
          control.button as 'home' | 'back' | 'app-switcher'
        ];
        if (key !== undefined) {
          for (const action of [0, 1] as const)
            await controller.injectKeyCode({
              action,
              keyCode: key as AndroidKeyCode,
              repeat: 0,
              metaState: 0,
            });
          return;
        }
      }
      throw Error('Unsupported Android control');
    };
    const backend: DevicePreviewBackend = {
      supportsMjpeg: false,
      nativeRotation: true,
      initialize: async () => {},
      rotation: () => 0,
      execute: (control, controlSignal) =>
        runAndroidControl(controlSignal, () => execute(control), abort),
      openStream,
      parseH264: () => (message) =>
        message[0] === 1
          ? [{ type: 'configuration', data: message.subarray(1) }]
          : [{ type: 'frame', key: message[0] === 2, data: message.subarray(1) }],
      exterior: async () => {
        throw Error('Android exterior unavailable');
      },
      still: async () => {
        throw Error('Android still refresh unavailable');
      },
    };
    startupSignal.removeEventListener('abort', abort);
    let stopping: Promise<void> | undefined;
    return {
      closed: Promise.race([capture.exited, pump, idleClosed]),
      stop: () =>
        (stopping ??= (async () => {
          idle.dispose();
          for (const stream of viewers) stream.close();
          await Promise.allSettled([
            reader.cancel(),
            output.cancel(),
            capture.close(),
            adb.close(),
          ]);
          lifetime.abort();
          await Promise.allSettled([pump, drainOutput, connector.close()]);
        })()),
      gateway: (context) => createDevicePreviewGateway({ ...context, backend }),
    };
  } catch (error) {
    lifetime.abort();
    await Promise.allSettled([scrcpy?.close(), connector.close()]);
    throw error;
  } finally {
    startupSignal.removeEventListener('abort', abort);
  }
}
