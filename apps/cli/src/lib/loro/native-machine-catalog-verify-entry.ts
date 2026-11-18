export {};
// This entry is a private main-owned protocol. Provider diagnostics can contain
// credentials; neither stdout nor stderr is a diagnostic sink for this helper.
const output = process.stdout.write.bind(process.stdout);
const failure = process.stderr.write.bind(process.stderr);
const discard = (_chunk: unknown, ...args: unknown[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') callback();
  return true;
};
Reflect.set(process.stdout, 'write', discard);
Reflect.set(process.stderr, 'write', discard);
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGTERM', abort);
process.once('SIGINT', abort);
try {
  if (process.argv.length !== 2) throw new Error();
  const {
    NATIVE_MACHINE_CATALOG_VERIFICATION_MAX_BYTES,
    nativeMachineCatalogVerificationInputSchema,
  } = await import('@lody/shared/native-machine-catalog-verification');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > NATIVE_MACHINE_CATALOG_VERIFICATION_MAX_BYTES) throw new Error();
    chunks.push(chunk);
  }
  const input = nativeMachineCatalogVerificationInputSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  );
  const { verifyNativeMachineCatalogCandidate } = await import('./native-machine-catalog-verify');
  const receipt = await verifyNativeMachineCatalogCandidate(input, controller.signal);
  output(JSON.stringify(receipt));
} catch {
  failure('native_machine_catalog_verification_failed\n');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGTERM', abort);
  process.removeListener('SIGINT', abort);
}
