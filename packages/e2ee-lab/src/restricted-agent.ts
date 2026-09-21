import type { AttackAction, AttackLab, PublicReport, PublicView } from './attack-lab';
import type { AgentTurn, CollabAgent } from './scenario';
import { toHex } from './platform/bytes';
import type { LabFetch } from './services/http';

export type AgentStep = {
  op: 'observe' | 'readBackend' | 'mutateBackend' | 'submitClaim' | 'intercept' | 'finish';
  needleHex?: string;
  xor?: number;
  kind?: 'plaintext' | 'forged-accepted' | 'cursor-overrun' | string;
  evidence?: string;
  eventId?: string;
  status?: number;
  bodyHex?: string;
};

export type AgentEndpoint = {
  url: string;
  key: string;
  model: string;
};

export function listAgentEndpoints(env: NodeJS.ProcessEnv = process.env): AgentEndpoint[] {
  const endpoints: AgentEndpoint[] = [];
  if (env.XAI_API_KEY) {
    endpoints.push({
      url: 'https://api.x.ai/v1/chat/completions',
      key: env.XAI_API_KEY,
      model: 'grok-4',
    });
  }
  if (env.GROK_API_KEY) {
    endpoints.push({
      url: 'https://api.x.ai/v1/chat/completions',
      key: env.GROK_API_KEY,
      model: 'grok-4',
    });
  }
  if (env.OPENROUTER_KEY) {
    endpoints.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: env.OPENROUTER_KEY,
      model: 'openai/gpt-4o-mini',
    });
  }
  if (env.GROQ_KEY) {
    endpoints.push({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: env.GROQ_KEY,
      model: 'llama-3.1-8b-instant',
    });
  }
  if (env.DEEPSEEK_API_KEY) {
    endpoints.push({
      url: 'https://api.deepseek.com/chat/completions',
      key: env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
    });
  }
  if (env.OPENAI_API_KEY) {
    endpoints.push({
      url: 'https://api.openai.com/v1/chat/completions',
      key: env.OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });
  }
  return endpoints;
}

export function resolveAgentEndpoint(
  env: NodeJS.ProcessEnv = process.env
): AgentEndpoint | undefined {
  return listAgentEndpoints(env)[0];
}

const SYSTEM_ATTACK = [
  'You attack an E2EE lab through AttackLab only.',
  'Return JSON {op,needleHex?,xor?,kind?,evidence?,eventId?,status?,bodyHex?}.',
  'op is observe|readBackend|mutateBackend|submitClaim|intercept|finish.',
  'Prefer a multi-step hunt: observe → readBackend → mutateBackend (needle from diskPrefix) or intercept a pending eventId.',
  'observe, readBackend, submitClaim, and finish are not destructive hits.',
  'Do not guess plaintext. Prefer finish when no leak or hit evidence exists.',
  'Budget exhaustion is not a finding. Never invent success.',
].join(' ');

async function chooseStep(
  view: PublicView,
  diskHexPrefix: string,
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch,
  prior: readonly AgentStep[]
): Promise<AgentStep> {
  const response = await fetchImpl(endpoint.url, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_ATTACK },
        {
          role: 'user',
          content: JSON.stringify({
            events: view.events,
            genesisHex: view.genesisHex,
            backendBytes: view.backendBytes,
            errors: view.errors,
            diskPrefix: diskHexPrefix.slice(0, 128),
            priorOps: prior.map((step) => step.op),
            remainingSteps: Math.max(0, 6 - prior.length),
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
  const allowed = new Set([
    'observe',
    'readBackend',
    'mutateBackend',
    'submitClaim',
    'intercept',
    'finish',
  ]);
  if (!allowed.has(parsed.op)) return { op: 'finish' };
  return parsed;
}

export async function runRestrictedAgentWithFallback(
  lab: AttackLab,
  endpoints: readonly AgentEndpoint[] = listAgentEndpoints(),
  fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)
): Promise<{ report: PublicReport; endpoint: AgentEndpoint }> {
  if (endpoints.length === 0) throw new Error('no model key; P4 Agent run blocked');
  let last: unknown;
  for (const endpoint of endpoints) {
    try {
      return { report: await runRestrictedAgent(lab, endpoint, fetchImpl), endpoint };
    } catch (error) {
      last = error;
      const text = String(error);
      if (!/agent-llm-(401|403|404|429)|insufficient_quota|credit_balance_exhausted/.test(text)) {
        throw error;
      }
    }
  }
  throw last instanceof Error ? last : new Error('agent-llm-unavailable');
}

/** LLM-chosen AttackLab steps. Multi-step; hits require mutation/intercept receipts. */
export async function runRestrictedAgent(
  lab: AttackLab,
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)
): Promise<PublicReport> {
  let view = await lab.observe();
  let disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
  const prior: AgentStep[] = [];
  let hitEvidence = false;
  for (let step = 0; step < 6; step++) {
    const choice = await chooseStep(view, toHex(disk.subarray(0, 64)), endpoint, fetchImpl, prior);
    prior.push(choice);
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
      const receipt = await lab.mutateBackend({
        eventId: 'barrier',
        kind: 'xor',
        needleHex: choice.needleHex,
        xor: choice.xor ?? 0xff,
      });
      if (receipt.ok) hitEvidence = true;
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'intercept' && choice.eventId && choice.kind) {
      await lab.intercept({
        eventId: choice.eventId,
        kind: choice.kind as 'drop' | 'replace' | 'delay' | 'duplicate' | 'truncate',
        status: choice.status,
        bodyHex: choice.bodyHex,
      });
      hitEvidence = true;
      view = await lab.observe();
      continue;
    }
    if (choice.op === 'submitClaim') {
      // Claims without hit evidence are recorded but do not invent success.
      if (!hitEvidence && choice.kind !== 'plaintext') {
        continue;
      }
      await lab.submitClaim({
        kind: (choice.kind as 'plaintext' | 'forged-accepted' | 'cursor-overrun') ?? 'plaintext',
        evidence: choice.evidence,
      });
    }
  }
  return lab.finish();
}

type CollabPlan = {
  step?: string;
  op?: 'intercept' | 'readBackend' | 'submitClaim' | 'mutateBackend' | 'pass';
  kind?: string;
  status?: number;
  bodyHex?: string;
  evidence?: string;
  needleHex?: string;
  xor?: number;
  followUp?: CollabPlan;
};

/**
 * One-shot or two-step attack plan. The model may schedule a primary boundary
 * attack and an optional follow-up (mutate/claim) after the first hit.
 */
async function chooseCollabPlan(
  turn: AgentTurn,
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch
): Promise<CollabPlan> {
  const response = await fetchImpl(endpoint.url, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You attack an E2EE collaboration while honest members keep working. ' +
            'Pick ONE boundary from "remainingSteps" and ONE primary attack. ' +
            'Optionally add followUp for a second action after the first lands. ' +
            'Return JSON: ' +
            '{"step":"<name>","op":"intercept","kind":"drop|replace|delay|duplicate|truncate","status":502,"bodyHex":"...","followUp":{"op":"mutateBackend","needleHex":"...","xor":255}} ' +
            '| {"step":"<name>","op":"mutateBackend","needleHex":"...","xor":255} ' +
            '| {"step":"<name>","op":"submitClaim","evidence":"..."} ' +
            '| {"step":"<name>","op":"readBackend"}. ' +
            'Prefer intercept or mutateBackend. observe, readBackend, submitClaim, and finish are not hits. ' +
            'Never guess plaintext or keys. Budget exhaustion is not a finding.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            step: turn.stepName,
            remainingSteps: turn.remainingSteps,
            requested: turn.view.events.filter((event) => event.status === 'requested'),
            genesisHex: turn.view.genesisHex,
            backendBytes: turn.view.backendBytes,
            errors: turn.view.errors,
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
  try {
    return JSON.parse(raw) as CollabPlan;
  } catch {
    return { op: 'pass' };
  }
}

const INTERCEPT_KINDS = new Set(['drop', 'replace', 'delay', 'duplicate', 'truncate']);

function planAction(turn: AgentTurn, plan: CollabPlan): AttackAction | 'pass' | 'wait' {
  if (plan.op === 'intercept') {
    if (!INTERCEPT_KINDS.has(plan.kind ?? '')) return 'pass';
    const pending = turn.view.events.find((event) => event.status === 'requested');
    if (!pending) return 'wait';
    return {
      op: 'intercept',
      input: {
        eventId: pending.eventId,
        kind: plan.kind,
        status: plan.status,
        bodyHex: plan.bodyHex,
      },
    };
  }
  if (plan.op === 'mutateBackend' && plan.needleHex) {
    return {
      op: 'mutateBackend',
      input: {
        eventId: 'barrier',
        needleHex: plan.needleHex,
        xor: plan.xor ?? 0xff,
      },
    };
  }
  if (plan.op === 'submitClaim') {
    return { op: 'submitClaim', input: { kind: 'plaintext', evidence: plan.evidence } };
  }
  if (plan.op === 'readBackend') {
    return { op: 'readBackend', input: { eventId: 'barrier' } };
  }
  return 'pass';
}

/**
 * Real-model attacker for the ongoing-collaboration scenario. Plans once, may
 * fire a primary attack plus one follow-up. Every honest step stays deterministic.
 */
export function collabModelAgent(
  endpoint: AgentEndpoint,
  fetchImpl: LabFetch = globalThis.fetch.bind(globalThis)
): CollabAgent {
  let plan: CollabPlan | null = null;
  let planStep = -1;
  let phase: 'primary' | 'follow' | 'done' = 'primary';
  let attempts = 0;
  return {
    act: async (turn) => {
      if (phase === 'done') return 'pass';
      if (!plan) {
        if (attempts >= 3) return 'pass';
        attempts += 1;
        const choice = await chooseCollabPlan(turn, endpoint, fetchImpl);
        const offset = turn.remainingSteps.indexOf(choice.step ?? '');
        const attackable = choice.op === 'intercept' || choice.op === 'mutateBackend';
        if (offset < 0 || !attackable) return 'pass';
        plan = choice;
        planStep = turn.step + offset;
      }
      if (turn.step < planStep) return 'pass';
      if (phase === 'primary') {
        const action = planAction(turn, plan);
        if (action === 'wait' || action === 'pass') return 'pass';
        phase = plan.followUp ? 'follow' : 'done';
        return action;
      }
      const follow = plan.followUp;
      phase = 'done';
      if (!follow) return 'pass';
      const action = planAction(turn, follow);
      if (action === 'wait' || action === 'pass') return 'pass';
      return action;
    },
  };
}

/**
 * Scripted deep probe: drop a pending response, xor backend bytes, then finish.
 * Used when no model key is available; still exercises multi-step AttackLab use.
 */
export function collabDeepScriptAgent(needleHex?: string): CollabAgent {
  let phase: 'intercept' | 'mutate' | 'done' = 'intercept';
  return {
    act: async (turn) => {
      if (phase === 'done') return 'pass';
      if (phase === 'intercept') {
        const pending = turn.view.events.find((event) => event.status === 'requested');
        if (!pending) return 'pass';
        phase = needleHex ? 'mutate' : 'done';
        return {
          op: 'intercept',
          input: { eventId: pending.eventId, kind: 'drop', status: 502 },
        };
      }
      phase = 'done';
      if (!needleHex) return 'pass';
      return {
        op: 'mutateBackend',
        input: { eventId: 'barrier', needleHex, xor: 0xff },
      };
    },
  };
}
