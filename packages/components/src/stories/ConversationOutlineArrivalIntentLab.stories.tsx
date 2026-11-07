import * as stylex from '@stylexjs/stylex';
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
const sceneStyles = stylex.create({
  layout: {
    display: 'grid',
    minHeight: '100vh',
    gridTemplateColumns: {
      default: 'repeat(1, minmax(0, 1fr))',
      '@media (min-width: 64rem)': 'minmax(640px,1fr) 320px',
    },
    backgroundColor: 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  conversation: {
    containerType: 'inline-size',
    position: 'relative',
    height: { default: '58vh', '@media (min-width: 64rem)': '100vh' },
    minHeight: { default: '520px', '@media (min-width: 64rem)': '680px' },
    overflow: 'hidden',
    borderBottomWidth: { default: '1px', '@media (min-width: 64rem)': 0 },
    borderRightWidth: { default: 0, '@media (min-width: 64rem)': '1px' },
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 1)',
  },
  entry: {
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    paddingBlock: 'calc(var(--spacing) * 4)',
  },
  inspector: {
    display: 'flex',
    minHeight: { default: '42vh', '@media (min-width: 64rem)': '680px' },
    height: { default: null, '@media (min-width: 64rem)': '100vh' },
    flexDirection: 'column',
    overflowY: 'auto',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 15%, transparent)',
    padding: 'calc(var(--spacing) * 4)',
  },
  status: {
    height: 'calc(var(--spacing) * 2.5)',
    width: 'calc(var(--spacing) * 2.5)',
    borderRadius: 'calc(infinity * 1px)',
  },
  prediction: { backgroundColor: 'var(--color-emerald-500)' },
  recording: { backgroundColor: 'var(--color-red-500)' },
  idle: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 35%, transparent)',
  },
  icon: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  trials: {
    ':is(*) > :not(:last-child)': {
      borderBottomWidth: '1px',
      borderBottomStyle: 'solid',
      borderColor: 'hsl(var(--border) / 1)',
    },
  },
  trialId: {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  intended: {
    color: {
      default: 'var(--color-emerald-600)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-emerald-400)',
    },
  },
  accidental: {
    color: {
      default: 'var(--color-red-600)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'var(--color-red-400)',
    },
  },
  unlabeled: { color: 'hsl(var(--muted-foreground) / 1)' },
  metric: {
    marginTop: 'calc(var(--spacing) * 0.5)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontSize: '11px',
    color: 'hsl(var(--foreground) / 1)',
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  caption2: {
    'margin-top': 'calc(var(--spacing) * 1)',
    'font-size': '13px',
    'line-height': 'var(--leading-relaxed)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'padding-bottom': 'calc(var(--spacing) * 3)',
  },
  caption3: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  caption4: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  grid: {
    display: 'grid',
    'grid-template-columns': 'repeat(2, minmax(0, 1fr))',
    'column-gap': 'calc(var(--spacing) * 4)',
    'row-gap': 'calc(var(--spacing) * 3)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'padding-block': 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'padding-block': 'calc(var(--spacing) * 4)',
  },
  caption5: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  grid2: {
    display: 'grid',
    'grid-template-columns': '32px 1fr auto',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  section: {
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-weight': 'var(--font-weight-medium)',
  },
});

const storyLayout = stylex.create({
  stack: {
    'margin-inline': 'auto',
    display: 'flex',
    height: '100%',
    width: '100%',
    'max-width': '46rem',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
    overflow: 'hidden',
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-block': 'calc(var(--spacing) * 8)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    'padding-block': 'calc(var(--spacing) * 3)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
  },
  caption: {
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

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
    <div {...stylex.props(sceneStyles.layout)}>
      <div {...stylex.props(sceneStyles.conversation)}>
        <div {...stylex.props(storyLayout.stack)}>
          {entries.slice(activeIndex, activeIndex + 7).map((item, offset) => (
            <div
              key={item.key}
              {...stylex.props(sceneStyles.entry)}
              style={{ opacity: Math.max(1 - offset * 0.1, 0.45) }}
            >
              <div {...stylex.props(storyLayoutStyles.caption)}>{item.title}</div>
              <div {...stylex.props(storyLayoutStyles.caption2)}>{item.preview}</div>
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

      <aside {...stylex.props(sceneStyles.inspector)}>
        <div {...stylex.props(storyLayoutStyles.row)}>
          <div>
            <h2 {...stylex.props(storyLayoutStyles.caption3)}>Arrival intent lab</h2>
            <div {...stylex.props(storyLayoutStyles.caption4)}>
              {recording ? 'Recording locally' : 'Idle'}
            </div>
          </div>
          <span
            {...stylex.props(
              sceneStyles.status,
              liveReading.predictionActive
                ? sceneStyles.prediction
                : recording
                  ? sceneStyles.recording
                  : sceneStyles.idle
            )}
            aria-label={liveReading.predictionActive ? 'Prediction active' : 'Prediction inactive'}
          />
        </div>

        <div {...stylex.props(storyLayoutStyles.grid)}>
          <Metric label="Distance" value={metric(liveReading.distancePx, ' px')} />
          <Metric label="Speed" value={metric(liveReading.recentSpeedPxPerMs, ' px/ms')} />
          <Metric label="Braking" value={metric(liveReading.brakingRatio)} />
          <Metric label="Heading" value={metric(liveReading.headingCosine)} />
          <Metric label="Samples" value={String(eventCount)} />
          <Metric label="Trials" value={String(trials.length)} />
          <Metric label="Bypassed" value={String(bypassCount)} />
          <Metric label="Labels" value={`${intendedCount} / ${accidentalCount}`} />
        </div>

        <div {...stylex.props(storyLayoutStyles.row2)}>
          {recording ? (
            <Button variant="secondary" size="small" onClick={stopCapture}>
              <Square {...stylex.props(sceneStyles.icon)} /> Stop
            </Button>
          ) : (
            <Button size="small" onClick={startCapture}>
              <Circle {...stylex.props(sceneStyles.icon)} /> Record
            </Button>
          )}
          <Button
            variant="secondary"
            size="small"
            disabled={!latestTrial}
            onClick={() => labelLatestTrial('intended')}
          >
            <Check {...stylex.props(sceneStyles.icon)} /> Intended
          </Button>
          <Button
            variant="secondary"
            size="small"
            disabled={!latestTrial}
            onClick={() => labelLatestTrial('accidental')}
          >
            <X {...stylex.props(sceneStyles.icon)} /> Accidental
          </Button>
          <Button
            variant="ghost"
            icon
            disabled={eventCount === 0}
            aria-label="Export capture"
            title="Export capture"
            onClick={exportCapture}
          >
            <Download {...stylex.props(sceneStyles.icon)} />
          </Button>
          <Button
            variant="ghost"
            icon
            disabled={eventCount === 0}
            aria-label="Clear capture"
            title="Clear capture"
            onClick={clearCapture}
          >
            <Trash2 {...stylex.props(sceneStyles.icon)} />
          </Button>
        </div>

        <div {...stylex.props(storyLayout.frame)}>
          <div {...stylex.props(storyLayoutStyles.caption5)}>Recent trials</div>
          <div {...stylex.props(sceneStyles.trials)}>
            {trials
              .slice(-8)
              .reverse()
              .map((trial) => (
                <div key={trial.id} {...stylex.props(storyLayoutStyles.grid2)}>
                  <span {...stylex.props(sceneStyles.trialId)}>#{trial.id}</span>
                  <div {...stylex.props(storyLayout.section)}>
                    <div {...stylex.props(storyLayoutStyles.section)}>{trial.openSource}</div>
                    <div {...stylex.props(storyLayout.caption)}>{trial.inferredOutcome}</div>
                  </div>
                  <span
                    {...stylex.props(
                      trial.manualLabel === 'intended'
                        ? sceneStyles.intended
                        : trial.manualLabel === 'accidental'
                          ? sceneStyles.accidental
                          : sceneStyles.unlabeled
                    )}
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
    <div {...stylex.props(storyLayout.section)}>
      <div {...stylex.props(storyLayout.caption)}>{label}</div>
      <div {...stylex.props(sceneStyles.metric)}>{value}</div>
    </div>
  );
}

export const CaptureAndLabel: Story = {
  render: () => <ArrivalIntentLab />,
};
