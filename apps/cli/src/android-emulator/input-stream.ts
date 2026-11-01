import { DeviceStream } from '../device-preview/backend';

export class AndroidStream extends DeviceStream {
  readyState = 0;
  bufferedAmount = 0;
  private tail = Promise.resolve();
  constructor(
    private readonly options: {
      open(): Promise<void>;
      write(message: string): Promise<void>;
      dispose(): void;
    }
  ) {
    super();
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit('open');
      void options.open().catch((e) => this.fail(e));
    });
  }
  fail(error: unknown) {
    if (this.readyState === 3) return;
    // Error listeners may synchronously send touch-up while shutting down.
    this.readyState = 2;
    try {
      this.emit('error', error instanceof Error ? error : Error('Android input failed'));
    } finally {
      this.terminate();
    }
  }
  send(message: string) {
    if (this.readyState !== 1) return;
    if (this.bufferedAmount + Buffer.byteLength(message) > 65536) {
      this.fail(Error('Android input queue full'));
      return;
    }
    this.bufferedAmount += Buffer.byteLength(message);
    this.tail = this.tail
      .then(async () => {
        if (this.readyState === 3) return;
        await this.options.write(message);
      })
      .catch((e) => this.fail(e))
      .finally(() => {
        this.bufferedAmount -= Buffer.byteLength(message);
      });
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.tail.finally(() => this.terminate());
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.options.dispose();
    this.emit('close');
  }
}
