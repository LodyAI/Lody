import { createCliStreamsTransport } from './streams-transport';
// Compile-only contract; never called by CLI startup.
export function cliTransportContentContract(
  options: Omit<Parameters<typeof createCliStreamsTransport>[0], 'content'>
) {
  // @ts-expect-error Content mode must be supplied by every transport owner.
  void createCliStreamsTransport(options);
}
