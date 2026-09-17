import type { AttackLab, PublicReport, PublicView } from './attack-lab';
import { toHex } from './platform/bytes';

export type AgentStep = {
  op: 'observe' | 'readBackend' | 'mutateBackend' | 'submitClaim' | 'finish';
  needleHex?: string;
  xor?: number;
  kind?: 'plaintext' | 'forged-accepted' | 'cursor-overrun';
  evidence?: string;
};

async function chooseStep(
  view: PublicView,
  diskHexPrefix: string,
  key: string
): Promise<AgentStep> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You attack an E2EE lab through AttackLab only. Return JSON {op,needleHex?,xor?,kind?,evidence?}. op is observe|readBackend|mutateBackend|submitClaim|finish. Do not guess plaintext. Prefer finish if no leak is visible. mutateBackend xor must use a needle from the provided disk prefix, not a fixed offset.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            events: view.events,
            genesisHex: view.genesisHex,
            backendBytes: view.backendBytes,
            errors: view.errors,
            diskPrefix: diskHexPrefix.slice(0, 64),
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`agent-llm-${response.status}:${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error('agent-llm-empty');
  const parsed = JSON.parse(raw) as AgentStep;
  if (
    parsed.op !== 'observe' &&
    parsed.op !== 'readBackend' &&
    parsed.op !== 'mutateBackend' &&
    parsed.op !== 'submitClaim' &&
    parsed.op !== 'finish'
  ) {
    return { op: 'finish' };
  }
  return parsed;
}

/** LLM-chosen AttackLab steps. Not the canned xor-at-offset explorer. */
export async function runRestrictedAgent(lab: AttackLab, key: string): Promise<PublicReport> {
  let view = await lab.observe();
  let disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
  for (let step = 0; step < 4; step++) {
    const choice = await chooseStep(view, toHex(disk.subarray(0, 32)), key);
    if (choice.op === 'finish') break;
    if (choice.op === 'observe') {
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'readBackend') {
      disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
      continue;
    }
    if (choice.op === 'mutateBackend' && choice.needleHex) {
      await lab.mutateBackend({
        eventId: 'barrier',
        kind: 'xor',
        needleHex: choice.needleHex,
        xor: choice.xor ?? 0xff,
      });
      break;
    }
    if (choice.op === 'submitClaim') {
      await lab.submitClaim({
        kind: choice.kind ?? 'plaintext',
        evidence: choice.evidence,
      });
    }
  }
  return lab.finish();
}
