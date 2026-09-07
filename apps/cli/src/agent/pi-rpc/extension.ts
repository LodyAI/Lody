/** Loaded inside Pi. Identity travels as native custom-message metadata, never model text. */
type Content = Array<
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
>;
type Context = { isIdle(): boolean; ui: { notify(message: string, type: 'info'): void } };
type Pi = {
  on(event: 'session_start', handler: (event: unknown, ctx: Context) => void): void;
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: Context): Promise<void>;
    }
  ): void;
  sendMessage(
    message: {
      customType: string;
      content: Content;
      display: boolean;
      details: { steerId: string };
    },
    options: { deliverAs: 'steer' }
  ): void;
};
export default function lodySteering(pi: Pi): void {
  const emit = (ctx: Context, event: unknown) =>
    ctx.ui.notify('lody-rpc:' + JSON.stringify(event), 'info');
  pi.on('session_start', (_event, ctx) => {
    emit(ctx, { type: 'lody_steer_ready', version: 1 });
  });
  pi.registerCommand('lody-steer', {
    description: 'Lody internal steering transport',
    async handler(args, ctx) {
      const request = JSON.parse(args) as { steerId: string; content: Content };
      if (typeof request.steerId !== 'string' || !Array.isArray(request.content))
        throw new Error('Invalid Lody steer request');
      // No await between this check and insertion. An idle session must refuse rather
      // than silently store input for some future prompt or start an unowned run.
      if (ctx.isIdle()) {
        emit(ctx, { type: 'lody_steer_refused', steerId: request.steerId });
        return;
      }
      pi.sendMessage(
        {
          customType: 'lody-steer',
          content: request.content,
          display: true,
          details: { steerId: request.steerId },
        },
        { deliverAs: 'steer' }
      );
    },
  });
}
