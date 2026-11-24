import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Layer } from 'effect';
import { platformLayer } from '../platform/process-options';
import { DevPluginCompiler, PluginBuildError } from '../plugins/workflow/dev-plugin-compiler';

/** Validate with the same isolated compiler as link, without registering or executing a generation. */
export async function checkPlugin(sourceDir: string) {
  const output = await mkdtemp(join(tmpdir(), 'lody-plugin-doctor-'));
  try {
    return await Effect.runPromise(
      Effect.flatMap(DevPluginCompiler, (c) => c.build(sourceDir, output)).pipe(
        Effect.map(({ manifest, clientDigest, machineDigest }) => ({
          ok: true,
          id: manifest.id,
          clientDigest,
          machineDigest,
        })),
        Effect.catch((e) =>
          Effect.fail(
            e instanceof PluginBuildError
              ? new Error(
                  JSON.stringify({
                    ok: false,
                    diagnostics: e.diagnostics.length ? e.diagnostics : [{ message: e.message }],
                  })
                )
              : e
          )
        ),
        Effect.provide(DevPluginCompiler.layer.pipe(Layer.provide(platformLayer({}))))
      )
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}
