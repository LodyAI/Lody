import type { AgentConfigCliType } from '@lody/shared';

import type { ErrorBoundaryReportEnvironment } from '@/lib/error-boundary-report';
import type { ProviderTestActivityPhase } from './provider-test-state';

/**
 * The pasteable account of a setup that has run long enough to be worth asking
 * about.
 *
 * A user whose agent has been "Taking longer" for two minutes can tell us that
 * much in their own words; what they cannot tell us is which stage it stalled
 * in, which build they are on, or how long it actually ran. So the escalation
 * hands them one block to paste instead of a conversation where we ask for
 * those three things one at a time.
 *
 * Deliberately NOT localized. The user's language is theirs; this text is read
 * by whoever answers in the chat, and a translated stage name is a stage name
 * we cannot grep for. The button that produces it is localized.
 *
 * Stages travel as their internal phase ids for the same reason — `Stage:
 * probing-provider` names the ACP handshake exactly, where "Starting" is a word
 * chosen for a badge.
 */
export type ProviderWaitReportInput = {
  agentName: string;
  cliType: AgentConfigCliType;
  agentType: string;
  phase: ProviderTestActivityPhase;
  /** Elapsed for the whole setup request, which is what the UI counts. */
  elapsedSeconds: number;
  /** Only ever present while downloading, the one stage with a denominator. */
  percent?: number | null;
  environment?: ErrorBoundaryReportEnvironment;
};

const REPORT_TITLE = 'Lody: agent setup is taking longer than usual';

function formatOnline(online: boolean | null | undefined): string | undefined {
  if (online === true) return 'yes';
  if (online === false) return 'no';
  return undefined;
}

export function buildProviderWaitReport(input: ProviderWaitReportInput): string {
  const environment = input.environment ?? {};
  const fields: Array<[string, string | undefined]> = [
    ['Agent', `${input.agentName} (${input.cliType}/${input.agentType})`],
    ['Stage', input.phase],
    // The counter is request-scoped, so the report says so rather than letting
    // the number read as time spent in the stage above it.
    ['Setup elapsed', `${Math.max(0, Math.floor(input.elapsedSeconds))}s`],
    [
      'Download',
      typeof input.percent === 'number' && Number.isFinite(input.percent)
        ? `${Math.min(100, Math.max(0, Math.round(input.percent)))}%`
        : undefined,
    ],
    ['Runtime', environment.runtime],
    ['OS', environment.os],
    ['App version', environment.appVersion],
    ['Build', environment.build],
    ['Language', environment.language],
    ['Online', formatOnline(environment.online)],
    ['Time', environment.timestamp],
  ];

  const body = fields
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');

  return `${REPORT_TITLE}\n\n${body}`;
}
