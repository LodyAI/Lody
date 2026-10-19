/** Optional manual tool. No imports invoke a model, and model text never supplies
 * credentials, authority, native scripts, expected verdicts or a pass criterion. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { Data, Effect, Schema } from 'effect';
import { captureLabActors, type LabActorConfiguration } from '../pure/actor-config';
import { captureModelActionPlan, LabActionPlanSchema } from './action-executor';
import { runLabScenario } from './scenario-runner';
import { replayLabActions } from './repro-runner';
import { makeLabSdkOwner } from './sdk-owner';
import { readBoundedBody } from './bounded-body';
export class LabExplorerError extends Data.TaggedError('LabExplorerError')<{
  readonly code: 'configuration' | 'response' | 'plan';
}> {}
export interface LabAttackPlanModel {
  readonly generate: (input: {
    readonly prompt: string;
    readonly schema: unknown;
  }) => Effect.Effect<string, unknown>;
}
const ModelResponse = Schema.Struct({
  status: Schema.Literal('completed'),
  output: Schema.Array(Schema.Unknown),
});
/** Responses API JSON mode plus local validation of the full action schema.
 * Explicit invocation only; the CLI obtains the key/model from environment. */
export const makeLabAttackPlanModel = Effect.fnUntraced(function* (input: {
  readonly key: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
}) {
  const key = input.key,
    model = input.model,
    transport = input.fetch ?? fetch;
  if (!key || !model || model.length > 256)
    return yield* new LabExplorerError({ code: 'configuration' });
  const native = yield* makeLabSdkOwner(({ signal }) => ({ signal, close: async () => undefined }));
  return {
    generate: ({ prompt, schema }) =>
      native.invoke(async ({ signal }) => {
        const response = await transport('https://api.openai.com/v1/responses', {
          method: 'POST',
          signal,
          redirect: 'error',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            store: false,
            max_output_tokens: 8192,
            text: { format: { type: 'json_object' } },
            instructions:
              'Return only JSON {"actions":[...]}. Propose a finite attack plan for synthetic local test actors. Do not include expect fields. No arbitrary code, paths or URLs. Follow this action JSON Schema: ' +
              JSON.stringify(schema),
            input: prompt,
          }),
        });
        const bytes = response.body ? await readBoundedBody(response.body, 256 * 1024) : undefined;
        if (!response.ok || !bytes) throw new LabExplorerError({ code: 'response' });
        const value = Schema.decodeUnknownSync(ModelResponse)(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        );
        const texts: string[] = [];
        for (const item of value.output) {
          if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'message')
            continue;
          const message = Schema.decodeUnknownSync(
            Schema.Struct({
              content: Schema.Array(
                Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })
              ),
            })
          )(item);
          for (const content of message.content)
            if (content.type === 'output_text' && content.text !== undefined)
              texts.push(content.text);
        }
        if (texts.length !== 1) throw new LabExplorerError({ code: 'response' });
        return texts[0]!;
      }),
  } satisfies LabAttackPlanModel;
});
/** A candidate becomes a finding only when an actual measured property violates
 * and a new set of native owners deterministically reproduces that violation. */
export const exploreLabAttacks = Effect.fn('Lab.exploreAttacks')(function* (input: {
  readonly directory: string;
  readonly model: LabAttackPlanModel;
  readonly actors?: readonly LabActorConfiguration[];
  readonly goal: string;
  readonly maxPlans?: number;
}) {
  const directory = input.directory,
    generate = input.model.generate.bind(input.model),
    goal = input.goal,
    maxPlans = input.maxPlans ?? 1;
  const actors = captureLabActors(input.actors);
  if (
    !isAbsolute(directory) ||
    !Number.isSafeInteger(maxPlans) ||
    maxPlans < 1 ||
    maxPlans > 8 ||
    goal.length < 1 ||
    goal.length > 4096
  )
    return yield* new LabExplorerError({ code: 'configuration' });
  const schema = Schema.toJsonSchemaDocument(LabActionPlanSchema);
  const trials: {
    plan: number;
    observed: string;
    confirmed: boolean;
    violations: readonly string[];
  }[] = [];
  for (let index = 0; index < maxPlans; index++) {
    const text = yield* generate({
      prompt: JSON.stringify({ goal, actors, previous: trials }),
      schema,
    });
    const actions = yield* Effect.try({
      try: () => {
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error('budget');
        const value = Schema.decodeUnknownSync(Schema.Struct({ actions: Schema.Unknown }))(
          JSON.parse(text)
        );
        const captured = captureModelActionPlan(value.actions);
        if (captured.some((action) => !actors.some((actor) => actor.id === action.actor)))
          throw new Error('unknown-actor');
        return captured;
      },
      catch: () => new LabExplorerError({ code: 'plan' }),
    });
    const runDirectory = join(directory, `plan-${index}`);
    yield* Effect.try({
      try: () => {
        mkdirSync(runDirectory, { mode: 0o700 });
        writeFileSync(join(runDirectory, 'model-response.json'), text, { mode: 0o600, flag: 'wx' });
      },
      catch: (cause) => cause,
    });
    const artifact = yield* runLabScenario({ directory: runDirectory, actions, actors });
    const violations = artifact.run.properties
      .filter((row) => row.verdict === 'violation')
      .map((row) => row.id);
    let confirmed = false;
    if (violations.length) {
      const replayDirectory = join(directory, `replay-${index}`);
      yield* Effect.try({
        try: () => mkdirSync(replayDirectory, { mode: 0o700 }),
        catch: (cause) => cause,
      });
      const replay = yield* replayLabActions({
        pack: artifact,
        directory: replayDirectory,
        sourceDirectory: runDirectory,
      });
      confirmed =
        replay.reproduced &&
        replay.verdict === 'violation' &&
        violations.every((id) =>
          replay.run.properties.some((row) => row.id === id && row.verdict === 'violation')
        );
      yield* Effect.try({
        try: () =>
          writeFileSync(join(runDirectory, 'replay-result.json'), JSON.stringify(replay), {
            mode: 0o600,
            flag: 'wx',
          }),
        catch: (cause) => cause,
      });
    }
    trials.push({ plan: index, observed: artifact.run.verdict, confirmed, violations });
  }
  return {
    manualOnly: true,
    plans: trials,
    confirmed: trials.filter((row) => row.confirmed).length,
  };
});
