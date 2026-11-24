import { z } from 'zod';
import { compilePlugin } from './plugin-build';

const esbuildFailure = z.object({
  errors: z.array(
    z.object({
      text: z.string(),
      location: z.object({ file: z.string(), line: z.number(), column: z.number() }).nullable(),
    })
  ),
});
process.on('message', (message) => {
  void compilePlugin(message).then(
    (result) => process.send?.({ ok: true, ...result }),
    (error: unknown) => {
      const parsed = esbuildFailure.safeParse(error);
      const diagnostics = parsed.success
        ? parsed.data.errors.map(({ text, location }) => ({ message: text, ...location }))
        : [];
      process.send?.({ ok: false, message: String(error), diagnostics });
    }
  );
});
