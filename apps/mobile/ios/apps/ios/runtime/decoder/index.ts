import { decodeFrames } from '../../../../packages/cloud-runtime/src/frames.ts';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { decompress } from 'fzstd';
import { projectRows } from '@lody/cloud-runtime/protocol/catalog';

const bytes = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
Object.assign(globalThis, {
  decodeFlock(snapshot: string, updates: string[], mode: string) {
    const flock = new Flock('lody-ios-reader');
    if (snapshot) {
      const value = bytes(snapshot);
      flock.importFile(
        value[0] === 0x28 &&
          value[1] === 0xb5 &&
          value[2] === 0x2f &&
          value[3] === 0xfd
          ? decompress(value)
          : value,
      );
    }
    for (const update of updates)
      for (const item of decodeFrames(bytes(update)))
        flock.importJson(JSON.parse(new TextDecoder().decode(item)));
    return JSON.stringify(projectRows(flock.scan(), mode));
  },
});
(
  globalThis as unknown as {
    webkit?: {
      messageHandlers: { decoderReady: { postMessage(value: boolean): void } };
    };
  }
).webkit?.messageHandlers.decoderReady.postMessage(true);
