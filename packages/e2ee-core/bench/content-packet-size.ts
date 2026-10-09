/** Encoded request-body sizes, not a network traffic benchmark.
 * Optional argv[2]: baseline packages/e2ee-core/src directory; argv[3]: label (default v1). */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import {
  StreamsCrdt,
  createLoroDocAdapter,
  InMemoryRemoteCursorStore,
} from '@loro-dev/streams-crdt/loro';
import { ContentCipher } from '../src/content';
import { createStreamsContentProvider } from '../src/streams-content';
import { toHex } from '../src/wire';

const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const device = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const author = { actor: '11'.repeat(32), memberInstance: '22'.repeat(16), device };
const scope = {
  genesis: '33'.repeat(32),
  resource: 'doc-1',
  epoch: 0,
  purpose: 'doc-update' as const,
};
const epochKey = new Uint8Array(32).fill(7);
const baseline = process.argv[2];
const baselineLabel = process.argv[3] ?? 'v1';
const modules = [{ version: 'v2', ContentCipher, createStreamsContentProvider }];
if (baseline) {
  const oldCipher = (await import(
    pathToFileURL(resolve(baseline, 'content.ts')).href
  )) as typeof import('../src/content');
  const oldProvider = (await import(
    pathToFileURL(resolve(baseline, 'streams-content.ts')).href
  )) as typeof import('../src/streams-content');
  modules.unshift({
    version: baselineLabel,
    ContentCipher: oldCipher.ContentCipher,
    createStreamsContentProvider: oldProvider.createStreamsContentProvider,
  });
}
const results = [];
for (const count of [1, 5]) {
  const doc = new LoroDoc();
  doc.setPeerId('1');
  const updates: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const from = doc.version();
    doc.getText('text').insert(i, String(i));
    doc.commit();
    updates.push(doc.export({ mode: 'update', from }));
  }
  for (const module of modules) {
    const cipher = new module.ContentCipher({ authorize: () => device });
    const provider = module.createStreamsContentProvider({
      cipher,
      genesis: scope.genesis,
      resource: scope.resource,
      model: 'loro',
      writeEpoch: 0,
      author,
      signingKey: pair.privateKey,
      readKey: () => epochKey,
      mayWriteDocument: () => true,
    });
    let packet = new Uint8Array();
    let batch = new Uint8Array();
    let sdkAad = 0;
    const writerDoc = new LoroDoc();
    writerDoc.setPeerId('1');
    const base = createLoroDocAdapter(writerDoc);
    const writer = new StreamsCrdt({
      streamUrl: 'https://synthetic.example.test/ds/doc',
      adapter: {
        ...base,
        exportUpdates(from) {
          const exported = base.exportUpdates(from);
          return exported ? { ...exported, updates } : exported;
        },
      },
      payloadProtectionRequired: true,
      e2ee: {
        provider: {
          ...provider,
          async seal(input) {
            batch = new Uint8Array(input.plaintext);
            return provider.seal({
              ...input,
              additionalData(header) {
                const aad = input.additionalData(header);
                sdkAad = aad.byteLength;
                return aad;
              },
            });
          },
        },
        readPolicy: 'encrypted-only',
        writePolicy: 'encrypt',
      },
      fetch: async (_url, init) => {
        packet = new Uint8Array(await new Response(init?.body).arrayBuffer());
        return new Response(null, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Stream-Next-Offset': 'tail',
            'Stream-Up-To-Date': 'true',
          },
        });
      },
    });
    for (let i = 0; i < count; i++) {
      writerDoc.getText('text').insert(i, String(i));
      writerDoc.commit();
    }
    const append = await writer.appendWriteOnly();
    if (!append.ok) throw new Error('measurement-append-failed');
    if (module.version === 'v2' && packet.byteLength - batch.byteLength !== 156)
      throw new Error('unexpected-v2-sdk-overhead');
    const directFrame = await cipher.seal({
      scope,
      author,
      epochKey,
      signingKey: pair.privateKey,
      plaintext: batch,
    });
    const restored = new LoroDoc();
    const cursorStore = new InMemoryRemoteCursorStore();
    await cursorStore.save({
      streamUrl: 'https://synthetic.example.test/ds/doc',
      nextOffset: '-1',
      serverLowerBoundVersion: {},
      updatedAtMs: 0,
    });
    const reader = new StreamsCrdt({
      remoteCursorStore: cursorStore,
      streamUrl: 'https://synthetic.example.test/ds/doc',
      adapter: createLoroDocAdapter(restored),
      payloadProtectionRequired: true,
      e2ee: { provider, readPolicy: 'encrypted-only', writePolicy: 'encrypt' },
      fetch: async () =>
        new Response(packet, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Stream-Next-Offset': 'tail',
            'Stream-Up-To-Date': 'true',
          },
        }),
    });
    const caught = await reader.catchup();
    if (!caught.ok || JSON.stringify(restored.toJSON()) !== JSON.stringify(doc.toJSON()))
      throw new Error('measurement-roundtrip-failed: ' + JSON.stringify(caught));
    results.push({
      version: module.version,
      updates: count,
      rawUpdateBytes: updates.reduce((n, u) => n + u.byteLength, 0),
      batchBytes: batch.byteLength,
      innerPacketBytes: directFrame.byteLength,
      innerOverheadBytes: directFrame.byteLength - batch.byteLength,
      sdkAadBytes: sdkAad,
      sdkRequestBodyBytes: packet.byteLength,
      sdkBodyOverheadBytes: packet.byteLength - batch.byteLength,
    });
    await writer.close();
    await reader.close();
    restored.free();
    writerDoc.free();
  }
  doc.free();
}
epochKey.fill(0);
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
