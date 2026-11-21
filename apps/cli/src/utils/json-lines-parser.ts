import { Transform, TransformCallback } from 'stream';

/**
 * Parses newline-delimited JSON (JSONL) stream
 */
export class JsonLinesParser extends Transform {
  private buffer: string = '';

  constructor() {
    super({ objectMode: true });
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: string,
    callback: TransformCallback
  ): void {
    this.buffer += chunk.toString();

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const parsed = JSON.parse(line);
          this.push(parsed);
        } catch {}
      }
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.trim()) {
      try {
        const parsed = JSON.parse(this.buffer);
        this.push(parsed);
      } catch {
        this.emit('error', new Error(`Invalid JSON: ${this.buffer}`));
      }
    }
    callback();
  }

  reset(): void {
    this.buffer = '';
  }

  getBuffer(): string {
    return this.buffer;
  }
}
