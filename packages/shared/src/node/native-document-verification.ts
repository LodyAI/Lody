import { mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DocSchema, JsonValue } from '@loro-dev/loro-repo-client';
import { IndependentNativeRepoHostLegacy } from './native-repo-independent-legacy';
import type { NativeRepoSdkCompatibility } from './native-repo-sdk-compatibility';

type Input = {
  readonly sources: readonly Uint8Array[];
  readonly target: Uint8Array;
  readonly schema: DocSchema;
};
/** Node-only complete binary verifier. An isolated short-lived engine supplies
 * exact i64/bytes/literal values without a copied private codec or a permanent
 * staging room in the business engine. Resolution includes actual child close. */
export class NativeLoroDocumentVerifierLegacy {
  private closed = false;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly directories = new Set<string>();
  private readonly hosts = new Set<{ host: IndependentNativeRepoHostLegacy; directory: string }>();
  constructor(
    private readonly options: {
      readonly directory: string;
      readonly launch: { executable: string; entry: string };
      readonly compatibility: NativeRepoSdkCompatibility;
      assertCurrent?(): void;
    }
  ) {
    if (
      !isAbsolute(options.directory) ||
      !options.compatibility.losslessWireI64 ||
      !options.compatibility.artifactId
    )
      throw new Error('Trusted native document verification scope required');
  }
  private check() {
    if (this.closed) throw new Error('Native document verifier retired');
    this.options.assertCurrent?.();
  }
  verify(input: Input): Promise<JsonValue> {
    this.check();
    const work = this.run(input);
    this.jobs.add(work);
    void work.finally(() => this.jobs.delete(work)).catch(() => {});
    return work;
  }
  private async run(input: Input): Promise<JsonValue> {
    if (
      !input.sources.length ||
      input.sources.some((bytes) => !bytes.byteLength) ||
      !input.target.byteLength
    )
      throw new Error('Complete present document binary required');
    const directory = join(this.options.directory, randomUUID());
    this.directories.add(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      this.check();
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      this.directories.delete(directory);
      throw error;
    }
    const host = new IndependentNativeRepoHostLegacy({
      dataDir: directory,
      binding: `complete-document-verifier:${randomUUID()}`,
      requiredSdkArtifactId: this.options.compatibility.artifactId,
      ...this.options.launch,
    });
    const retained = { host, directory };
    this.hosts.add(retained);
    let primary: unknown;
    try {
      const client = await host.client();
      this.check();
      const namespace = 'complete-document-verification';
      const expected = { kind: 'loro_doc' as const, id: 'expected' },
        target = { kind: 'loro_doc' as const, id: 'target' };
      await client.createRoom(namespace, expected, 'plaintext', { docSchema: input.schema });
      await client.createRoom(namespace, target, 'plaintext', { docSchema: input.schema });
      for (const snapshot of input.sources) {
        this.check();
        await client.importRoomState(namespace, expected, { snapshot, enqueueOutbox: false });
      }
      await client.importRoomState(namespace, target, {
        snapshot: input.target,
        enqueueOutbox: false,
      });
      this.check();
      const a = (await client.readDoc(namespace, expected)).value,
        b = (await client.readDoc(namespace, target)).value;
      this.check();
      if (!isDeepStrictEqual(a, b)) throw new Error('Complete lossless document states differ');
      return a;
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await host.close();
        await rm(directory, { recursive: true, force: true });
        this.hosts.delete(retained);
        this.directories.delete(directory);
      } catch (cleanup) {
        throw new AggregateError(
          primary ? [primary, cleanup] : [cleanup],
          'Native document verification cleanup unconfirmed'
        );
      }
    }
  }
  async close() {
    this.closed = true;
    const closeHosts = () =>
      Promise.allSettled(
        [...this.hosts].map(async (entry) => {
          await entry.host.close();
          await rm(entry.directory, { recursive: true, force: true });
          this.hosts.delete(entry);
          this.directories.delete(entry.directory);
        })
      );
    await closeHosts();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.jobs]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native document verification remains pending')),
            15000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const last = await closeHosts();
    const orphaned = await Promise.allSettled(
      [...this.directories]
        .filter((directory) => ![...this.hosts].some((entry) => entry.directory === directory))
        .map(async (directory) => {
          await rm(directory, { recursive: true, force: true });
          this.directories.delete(directory);
        })
    );
    const failed = [...last, ...orphaned].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failed.length || this.hosts.size)
      throw new AggregateError(failed, 'Native document verification cleanup unconfirmed');
  }
  retryCleanup() {
    return this.close();
  }
}
