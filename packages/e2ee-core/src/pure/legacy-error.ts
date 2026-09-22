/** Shared compatibility error, not an Effect public error channel.
 * Kept separate so platform adapters never import the JSON/hex protocol. */
export class ControlLogError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ControlLogError';
  }
}
