import type { AttackAction, AttackLab, PublicReport, PublicView } from './attack-lab';
import type { AgentTurn, CollabAgent } from './scenario';
import { toHex } from './platform/bytes';

export type AgentStep = {
  op: 'observe' | 'readBackend' | 'mutateBackend' | 'submitClaim' | 'finish';
  needleHex?: string;
  xor?: number;
  kind?: 'plaintext' | 'forged-accepted' | 'cursor-overrun';
  evidence?: string;
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

async function chooseStep(
  view: PublicView,
  diskHexPrefix: string,
  endpoint: AgentEndpoint
): Promise<AgentStep> {
  const response = await fetch(endpoint.url, {
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

export async function runRestrictedAgentWithFallback(
  lab: AttackLab,
  endpoints: readonly AgentEndpoint[] = listAgentEndpoints()
): Promise<{ report: PublicReport; endpoint: AgentEndpoint }> {
  if (endpoints.length === 0) throw new Error('no model key; P4 Agent run blocked');
  let last: unknown;
  for (const endpoint of endpoints) {
    try {
      return { report: await runRestrictedAgent(lab, endpoint), endpoint };
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

/** LLM-chosen AttackLab steps. Not the canned xor-at-offset explorer. */
export async function runRestrictedAgent(
  lab: AttackLab,
  endpoint: AgentEndpoint
): Promise<PublicReport> {
  let view = await lab.observe();
  let disk = await lab.readBackend({ target: 'riverrun', eventId: 'barrier' });
  for (let step = 0; step < 4; step++) {
    const choice = await chooseStep(view, toHex(disk.subarray(0, 32)), endpoint);
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

type CollabPlan = {
  step?: string;
  op?: 'intercept' | 'readBackend' | 'submitClaim' | 'pass';
  kind?: string;
  status?: number;
  bodyHex?: string;
  evidence?: string;
};

/**
 * One-shot attack plan. The model is consulted once and picks both the timing
 * (a step from `remainingSteps`) and the attack; the concrete pending event is
 * resolved at fire time from the public view. This keeps model latency out of
 * the per-step loop while the model still chooses action and boundary.
 */
async function chooseCollabPlan(turn: AgentTurn, endpoint: AgentEndpoint): Promise<CollabPlan> {
  const response = await fetch(endpoint.url, {
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
            'Pick ONE boundary from "remainingSteps" and ONE attack that runs when ' +
            'that step starts. Return JSON: ' +
            '{"step":"<name>","op":"intercept","kind":"drop|replace|delay|duplicate|truncate","status":502,"bodyHex":"..."} ' +
            '| {"step":"<name>","op":"submitClaim","evidence":"..."} ' +
            '| {"step":"<name>","op":"readBackend"}. ' +
            'intercept drops or replaces the pending response of an honest member ' +
            'at that boundary; prefer it over the other ops. ' +
            'Never guess plaintext or keys.',
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
  if (plan.op === 'submitClaim') {
    return { op: 'submitClaim', input: { kind: 'plaintext', evidence: plan.evidence } };
  }
  if (plan.op === 'readBackend') {
    return { op: 'readBackend', input: { eventId: 'barrier' } };
  }
  return 'pass';
}

/**
 * Real-model attacker for the ongoing-collaboration scenario. The model plans
 * once — one LLM call chooses the boundary step and the attack — then the
 * agent fires it at the chosen step (or the next step that exposes a matching
 * pending event). Every honest step stays deterministic.
 */
export function collabModelAgent(endpoint: AgentEndpoint): CollabAgent {
  let plan: CollabPlan | null = null;
  let planStep = -1;
  let fired = false;
  let attempts = 0;
  return {
    act: async (turn) => {
      if (fired) return 'pass';
      if (!plan) {
        if (attempts >= 3) return 'pass';
        attempts += 1;
        const choice = await chooseCollabPlan(turn, endpoint);
        const offset = turn.remainingSteps.indexOf(choice.step ?? '');
        const attackable =
          choice.op === 'intercept' || choice.op === 'readBackend' || choice.op === 'submitClaim';
        if (offset < 0 || !attackable) return 'pass';
        plan = choice;
        planStep = turn.step + offset;
      }
      if (turn.step < planStep) return 'pass';
      const action = planAction(turn, plan);
      if (action === 'wait') return 'pass';
      fired = true;
      return action;
    },
  };
}
