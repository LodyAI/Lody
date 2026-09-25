import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Check, Circle, Download, Square, Trash2, X } from 'lucide-react';
import {
  ConversationOutlineRail,
  type ConversationOutlineArrivalIntentDebugEvent,
  type ConversationOutlineHoverOpenSource,
} from '@/components/ai-gui/conversation-outline-rail';
import { DEFAULT_ARRIVAL_INTENT_CONFIG } from '@/components/ai-gui/conversation-outline-arrival-intent';
import type { ConversationOutlineEntry } from '@/lib/conversation-outline';
import { Button } from '@lody/ui/button';

const meta = {
  title: 'Sessions/ConversationOutlineRail/ArrivalIntentLab',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const entries: ConversationOutlineEntry[] = Array.from({ length: 24 }, (_, index) => ({
  key: `arrival-lab-${index}`,
  messageIndex: index * 2,
  title: `Round ${index + 1}: inspect the arrival predictor`,
  preview: 'A deterministic synthetic preview used only by the Storybook interaction lab.',
  startsWithAgent: false,
  weight: (index % 4) as ConversationOutlineEntry['weight'],
}));

type TrialLabel = 'intended' | 'accidental';
type InferredOutcome = 'jumped' | 'quick-exit' | 'inspected' | 'unresolved';

interface CapturedTrial {
  id: number;
  enteredAt: number;
  leftAt: number | null;
  index: number;
  openSource: ConversationOutlineHoverOpenSource;
  cardOpenedAt: number | null;
  jumpedAt: number | null;
  inferredOutcome: InferredOutcome;
  manualLabel: TrialLabel | null;
}

interface CapturedEvent {
  sequence: number;
  event: ConversationOutlineArrivalIntentDebugEvent;
}

interface LiveReading {
  predictionActive: boolean;
  distancePx: number | null;
  recentSpeedPxPerMs: number | null;
  brakingRatio: number | null;
  headingCosine: number | null;
}

const EMPTY_READING: LiveReading = {
  predictionActive: false,
  distancePx: null,
  recentSpeedPxPerMs: null,
  brakingRatio: null,
  headingCosine: null,
};

const round = (value: number | null, digits = 3): number | null =>
  value === null ? null : Number(value.toFixed(digits));

const metric = (value: number | null, suffix = ''): string =>
  value === null ? '—' : `${value.toFixed(2)}${suffix}`;

const normalizeDebugEvent = (
  event: ConversationOutlineArrivalIntentDebugEvent,
  startedAt: number
): ConversationOutlineArrivalIntentDebugEvent => {
  const at = Math.max(0, event.at - startedAt);
  if (event.type !== 'sample') return { ...event, at };
  return {
    ...event,
    at,
    predictedUntil:
      event.predictedUntil === null ? null : Math.max(0, event.predictedUntil - startedAt),
    point: {
      xFromTarget: round(event.point.xFromTarget) ?? 0,
      yFromTarget: round(event.point.yFromTarget) ?? 0,
    },
    target: {
      width: round(event.target.width) ?? 0,
      height: round(event.target.height) ?? 0,
    },
  };
};

function ArrivalIntentLab() {
  const [activeIndex, setActiveIndex] = useState(8);
  const [recording, setRecording] = useState(false);
  const [, setRevision] = useState(0);
  const [liveReading, setLiveReading] = useState(EMPTY_READING);
  const recordingRef = useRef(false);
  const captureStartedAtRef = useRef(0);
  const eventsRef = useRef<CapturedEvent[]>([]);
  const trialsRef = useRef<CapturedTrial[]>([]);
  const activeTrialRef = useRef<CapturedTrial | null>(null);
  const nextTrialIdRef = useRef(1);
  const sequenceRef = useRef(0);
  const liveReadingRef = useRef(EMPTY_READING);
  const liveFrameRef = useRef<number | null>(null);

  const publishLiveReading = useCallback((reading: LiveReading) => {
    liveReadingRef.current = reading;
    if (liveFrameRef.current !== null) return;
    liveFrameRef.current = requestAnimationFrame(() => {
      liveFrameRef.current = null;
      setLiveReading(liveReadingRef.current);
    });
  }, []);

  useEffect(
    () => () => {
      if (liveFrameRef.current !== null) cancelAnimationFrame(liveFrameRef.current);
    },
    []
  );

  const finalizeTrial = useCallback((leftAt: number) => {
    const trial = activeTrialRef.current;
    if (!trial) return;
    trial.leftAt = leftAt;
    if (trial.jumpedAt !== null) trial.inferredOutcome = 'jumped';
    else if (trial.cardOpenedAt === null) trial.inferredOutcome = 'unresolved';
    else if (leftAt - trial.cardOpenedAt < 180) trial.inferredOutcome = 'quick-exit';
    else trial.inferredOutcome = 'inspected';
    activeTrialRef.current = null;
    setRevision((value) => value + 1);
  }, []);

  const handleDebugEvent = useCallback(
    (event: ConversationOutlineArrivalIntentDebugEvent) => {
      if (event.type === 'sample') {
        const metrics = event.evaluation.metrics;
        publishLiveReading({
          predictionActive: event.predictionActive,
          distancePx: metrics.distancePx,
          recentSpeedPxPerMs: metrics.recentSpeedPxPerMs,
          brakingRatio: metrics.brakingRatio,
          headingCosine: metrics.headingCosine,
        });
      }

      if (!recordingRef.current) return;
      const normalized = normalizeDebugEvent(event, captureStartedAtRef.current);
      eventsRef.current.push({ sequence: sequenceRef.current, event: normalized });
      sequenceRef.current += 1;

      if (normalized.type === 'tick-enter' && activeTrialRef.current === null) {
        const trial: CapturedTrial = {
          id: nextTrialIdRef.current,
          enteredAt: normalized.at,
          leftAt: null,
          index: normalized.index,
          openSource: normalized.source,
          cardOpenedAt: null,
          jumpedAt: null,
          inferredOutcome: 'unresolved',
          manualLabel: null,
        };
        nextTrialIdRef.current += 1;
        trialsRef.current.push(trial);
        activeTrialRef.current = trial;
        setRevision((value) => value + 1);
      } else if (normalized.type === 'card-open' && activeTrialRef.current) {
        activeTrialRef.current.cardOpenedAt ??= normalized.at;
      } else if (normalized.type === 'round-jump' && activeTrialRef.current) {
        activeTrialRef.current.jumpedAt = normalized.at;
        activeTrialRef.current.inferredOutcome = 'jumped';
      } else if (normalized.type === 'rail-leave') {
        finalizeTrial(normalized.at);
      }
    },
    [finalizeTrial, publishLiveReading]
  );

  const startCapture = useCallback(() => {
    eventsRef.current = [];
    trialsRef.current = [];
    activeTrialRef.current = null;
    nextTrialIdRef.current = 1;
    sequenceRef.current = 0;
    captureStartedAtRef.current = performance.now();
    recordingRef.current = true;
    setRecording(true);
    setRevision((value) => value + 1);
  }, []);

  const stopCapture = useCallback(() => {
    finalizeTrial(Math.max(0, performance.now() - captureStartedAtRef.current));
    recordingRef.current = false;
    setRecording(false);
    setRevision((value) => value + 1);
  }, [finalizeTrial]);

  const clearCapture = useCallback(() => {
    recordingRef.current = false;
    eventsRef.current = [];
    trialsRef.current = [];
    activeTrialRef.current = null;
    nextTrialIdRef.current = 1;
    sequenceRef.current = 0;
    setRecording(false);
    setRevision((value) => value + 1);
  }, []);

  const labelLatestTrial = useCallback((label: TrialLabel) => {
    const latest = trialsRef.current.at(-1);
    if (!latest) return;
    latest.manualLabel = label;
    setRevision((value) => value + 1);
  }, []);

  const exportCapture = useCallback(() => {
    const payload = {
      schema: 'lody.conversation-outline-arrival-intent-capture',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      coordinateSpace: 'pointer coordinates relative to the rail target; time is relative ms',
      detectorConfig: DEFAULT_ARRIVAL_INTENT_CONFIG,
      events: eventsRef.current,
      trials: trialsRef.current,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `outline-arrival-intent-${new Date().toISOString().replaceAll(':', '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const trials = trialsRef.current;
  const eventCount = eventsRef.current.length;
  const latestTrial = trials.at(-1);
  const intendedCount = trials.filter((trial) => trial.manualLabel === 'intended').length;
  const accidentalCount = trials.filter((trial) => trial.manualLabel === 'accidental').length;
  const bypassCount = trials.filter((trial) => trial.openSource === 'arrival-intent').length;
  return (
    <div className="grid min-h-screen grid-cols-1 bg-background text-foreground lg:grid-cols-[minmax(640px,1fr)_320px]">
      <div className="@container relative h-[58vh] min-h-[520px] overflow-hidden border-b border-border lg:h-screen lg:min-h-[680px] lg:border-r lg:border-b-0">
        <div className="mx-auto flex h-full w-full max-w-[46rem] flex-col gap-3 overflow-hidden px-4 py-8">
          {entries.slice(activeIndex, activeIndex + 7).map((item, offset) => (
            <div
              key={item.key}
              className="border-b border-border/70 py-4"
              style={{ opacity: Math.max(1 - offset * 0.1, 0.45) }}
            >
              <div className="text-sm font-medium">{item.title}</div>
              <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {item.preview}
              </div>
            </div>
          ))}
        </div>
        <ConversationOutlineRail
          entries={entries}
          activeIndex={activeIndex}
          onJumpToRound={setActiveIndex}
          enableArrivalIntent
          onArrivalIntentDebugEvent={handleDebugEvent}
        />
      </div>

      <aside className="flex min-h-[42vh] flex-col overflow-y-auto bg-muted/15 p-4 lg:h-screen lg:min-h-[680px]">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <h2 className="text-sm font-semibold">Arrival intent lab</h2>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {recording ? 'Recording locally' : 'Idle'}
            </div>
          </div>
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              liveReading.predictionActive
                ? 'bg-emerald-500'
                : recording
                  ? 'bg-red-500'
                  : 'bg-muted-foreground/35'
            }`}
            aria-label={liveReading.predictionActive ? 'Prediction active' : 'Prediction inactive'}
          />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-border py-4 text-xs">
          <Metric label="Distance" value={metric(liveReading.distancePx, ' px')} />
          <Metric label="Speed" value={metric(liveReading.recentSpeedPxPerMs, ' px/ms')} />
          <Metric label="Braking" value={metric(liveReading.brakingRatio)} />
          <Metric label="Heading" value={metric(liveReading.headingCosine)} />
          <Metric label="Samples" value={String(eventCount)} />
          <Metric label="Trials" value={String(trials.length)} />
          <Metric label="Bypassed" value={String(bypassCount)} />
          <Metric label="Labels" value={`${intendedCount} / ${accidentalCount}`} />
        </div>

        <div className="flex flex-wrap gap-2 border-b border-border py-4">
          {recording ? (
            <Button variant="secondary" size="small" onClick={stopCapture}>
              <Square className="size-4" /> Stop
            </Button>
          ) : (
            <Button size="small" onClick={startCapture}>
              <Circle className="size-4" /> Record
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            disabled={!latestTrial}
            onClick={() => labelLatestTrial('intended')}
          >
            <Check className="size-4" /> Intended
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={!latestTrial}
            onClick={() => labelLatestTrial('accidental')}
          >
            <X className="size-4" /> Accidental
          </Button>
          <Button
            variant="ghost"
            icon
            disabled={eventCount === 0}
            aria-label="Export capture"
            title="Export capture"
            onClick={exportCapture}
          >
            <Download className="size-4" />
          </Button>
          <Button
            variant="ghost"
            icon
            disabled={eventCount === 0}
            aria-label="Clear capture"
            title="Clear capture"
            onClick={clearCapture}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 py-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Recent trials</div>
          <div className="divide-y divide-border">
            {trials
              .slice(-8)
              .reverse()
              .map((trial) => (
                <div
                  key={trial.id}
                  className="grid grid-cols-[32px_1fr_auto] items-center gap-2 py-2 text-xs"
                >
                  <span className="font-mono text-muted-foreground">#{trial.id}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{trial.openSource}</div>
                    <div className="text-muted-foreground">{trial.inferredOutcome}</div>
                  </div>
                  <span
                    className={
                      trial.manualLabel === 'intended'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : trial.manualLabel === 'accidental'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-muted-foreground'
                    }
                  >
                    {trial.manualLabel ?? 'unlabeled'}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[11px] text-foreground">{value}</div>
    </div>
  );
}

export const CaptureAndLabel: Story = {
  render: () => <ArrivalIntentLab />,
};
