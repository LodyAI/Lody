import type { Writable } from 'stream';
import { getLogger, type Logger } from './logger';

/**
 * Creates a WritableStream that writes to a Node.js Writable stream with proper backpressure handling.
 *
 * This handles the case where:
 * 1. The underlying stream applies backpressure (write returns false)
 * 2. The stream closes or errors before 'drain' fires
 *
 * Without proper handling of case 2, the returned Promise would never resolve,
 * causing the caller to hang indefinitely.
 *
 * @param stdin - The Node.js Writable stream to write to
 * @returns A Web WritableStream that properly handles backpressure
 */
export function createStdinWritableStream(stdin: Writable): WritableStream<Uint8Array> {
  // Attach error handler to prevent uncaught EPIPE errors when the process exits
  // while we're still writing. Without this, Node.js would throw an uncaught exception.
  stdin.on('error', (err: NodeJS.ErrnoException) => {
    // EPIPE is expected when the process exits - silently ignore it
    if (err.code !== 'EPIPE') {
      // For other errors, we can't do much here since we don't have access to a logger.
      // The error will be surfaced through the WritableStream's write() rejection.
      getLogger('stream').debug(`[stream] stdin error: ${err.message}`);
    }
  });

  return new WritableStream({
    write(chunk) {
      if (stdin.destroyed) {
        return Promise.resolve();
      }
      // Handle backpressure: if write() returns false, wait for 'drain' event.
      // Also listen for 'close'/'error' to avoid hanging if the process exits
      // before 'drain' fires.
      const canContinue = stdin.write(chunk);
      if (!canContinue) {
        return new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            stdin.off('drain', onDrain);
            stdin.off('close', onClose);
            stdin.off('error', onError);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            resolve(); // Resolve instead of reject to allow graceful shutdown
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          stdin.once('drain', onDrain);
          stdin.once('close', onClose);
          stdin.once('error', onError);
        });
      }
      return Promise.resolve();
    },
    close() {
      if (!stdin.destroyed) {
        stdin.end();
      }
    },
  });
}

/**
 * Creates a ReadableStream from a Node.js Readable stream with buffering to prevent data loss.
 *
 * This handles the race condition where:
 * 1. The Node.js stream starts emitting data immediately after spawn
 * 2. But ReadableStream.start() is called asynchronously
 *
 * Data emitted before start() is called is buffered and flushed when the stream is ready.
 *
 * @param stdout - The Node.js Readable stream to read from
 * @returns A Web ReadableStream that buffers early data
 */
export function createStdoutReadableStream(
  stdout: NodeJS.ReadableStream
): ReadableStream<Uint8Array> {
  // Buffer any data received before the ReadableStream is ready to consume it
  const bufferedChunks: Buffer[] = [];
  let streamStarted = false;
  let pendingController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stdoutEnded = false;
  let controllerClosed = false;

  const onData = (chunk: Buffer): void => {
    if (controllerClosed) return;
    if (streamStarted && pendingController) {
      pendingController.enqueue(chunk);
    } else {
      bufferedChunks.push(chunk);
    }
  };

  const closeController = (): void => {
    if (!pendingController || controllerClosed) return;
    controllerClosed = true;
    const controller = pendingController;
    pendingController = null;
    controller.close();
  };

  const onEnd = (): void => {
    stdoutEnded = true;
    if (streamStarted) closeController();
    detach();
  };

  const detach = (): void => {
    stdout.removeListener('data', onData);
    stdout.removeListener('end', onEnd);
  };

  stdout.on('data', onData);
  stdout.on('end', onEnd);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      pendingController = controller;
      // Flush any buffered data that arrived before the stream was ready
      for (const chunk of bufferedChunks) {
        controller.enqueue(chunk);
      }
      bufferedChunks.length = 0;
      streamStarted = true;

      // If stdout already ended before we started, close the controller
      if (stdoutEnded) {
        closeController();
      }
    },
    cancel() {
      // A consumer can cancel before the Node stream emits `end`. Detach so a
      // later child-process shutdown cannot close or enqueue into an already
      // cancelled Web Stream controller.
      controllerClosed = true;
      pendingController = null;
      bufferedChunks.length = 0;
      detach();
    },
  });
}

/**
 * Options for creating a logged ndjson stream.
 */
export interface LoggedNdJsonStreamOptions {
  /** Logger to use for logging messages */
  logger: Logger;
  /** Session ID for log prefixing */
  sessionId: string;
  /** Whether to log full message content (may be verbose) */
  logFullContent?: boolean;
}

/**
 * ACP message type for logging purposes.
 * This is a simplified version for logging - the actual SDK uses more specific types.
 */
interface AcpMessageForLogging {
  jsonrpc?: string;
  method?: string;
  id?: string | number | null;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * Wraps the ACP SDK's ndJsonStream to add logging of sent/received messages.
 * This is critical for debugging initialization hangs where we need to see
 * if messages are being sent and received properly.
 *
 * @param ndJsonStreamFn - The original ndJsonStream function from the SDK
 * @param output - The writable stream to send encoded messages to
 * @param input - The readable stream to receive encoded messages from
 * @param options - Logging options
 * @returns A Stream for bidirectional ACP communication with logging
 */
export function createLoggedNdJsonStream<
  TStream extends { readable: ReadableStream<unknown>; writable: WritableStream<unknown> },
>(
  ndJsonStreamFn: (
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>
  ) => TStream,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: LoggedNdJsonStreamOptions
): TStream {
  const { logger, sessionId, logFullContent = false } = options;

  // Create the underlying stream
  const baseStream = ndJsonStreamFn(output, input);

  // Wrap the writable stream to log outgoing messages
  const loggedWritable = new WritableStream<unknown>({
    async write(message) {
      const msg = message as AcpMessageForLogging;
      if (msg.method) {
        logger.debug(
          `[${sessionId}] ACP >>> ${msg.method} (id=${msg.id ?? 'notification'})${
            logFullContent ? ` ${JSON.stringify(message)}` : ''
          }`
        );
      } else if (msg.id !== undefined && msg.id !== null) {
        const status = msg.error ? 'error' : 'result';
        logger.debug(
          `[${sessionId}] ACP >>> response (id=${msg.id} ${status})${
            logFullContent ? ` ${JSON.stringify(message)}` : ''
          }`
        );
      }
      const writer = baseStream.writable.getWriter();
      try {
        await writer.write(message);
      } finally {
        writer.releaseLock();
      }
    },
    close() {
      logger.debug(`[${sessionId}] ACP writable stream closed`);
    },
  });

  // Wrap the readable stream to log incoming messages
  const loggedReadable = new ReadableStream<unknown>({
    async start(controller) {
      const reader = baseStream.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            logger.debug(`[${sessionId}] ACP readable stream ended`);
            controller.close();
            break;
          }
          if (value) {
            const msg = value as AcpMessageForLogging;
            if (msg.method) {
              logger.debug(
                `[${sessionId}] ACP <<< ${msg.method} (id=${msg.id ?? 'notification'})${
                  logFullContent ? ` ${JSON.stringify(value)}` : ''
                }`
              );
            } else if (msg.id !== undefined && msg.id !== null) {
              const status = msg.error ? 'error' : 'result';
              logger.debug(
                `[${sessionId}] ACP <<< response (id=${msg.id} ${status})${
                  logFullContent ? ` ${JSON.stringify(value)}` : ''
                }`
              );
            }
            controller.enqueue(value);
          }
        }
      } catch (err) {
        logger.error(`[${sessionId}] ACP readable stream error: ${err}`);
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });

  // Cast to TStream - we preserve the same type but with logging wrappers
  return { readable: loggedReadable, writable: loggedWritable } as TStream;
}
