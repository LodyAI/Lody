import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { motion } from 'framer-motion';
import type { AgentConfigCliType } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { AgentIcon } from '@/components/icons/agent-icon';
import { TourStill } from '../tour/tour-still';
import type { CameraShot } from '../tour/camera';
import type { TourAppTracks, TourConfigurationState } from '../tour/tour-app';
import { DEFAULT_TOUR_IDENTITY } from '../tour/tour-fixtures';
import { AnchoredPanel, FieldOverlay, PressOverlay } from './anchored-panel';
import { AnswerFlight, type Flight } from './answer-flight';
import { AgentDeck, ProjectDeck, Question, SuggestionBubbles } from './questions';
import { resolveAnchor } from '../tour/camera';
import { playClick, playCut, playReveal, playSelect } from '../ceremony/ui-sounds';
import { SketchLayer, type BlueprintRegion } from './sketch-layer';

// Blueprint onboarding.
//
// The whole of setup happens on ONE object: the Lody window, standing on the
// desk. It opens as a pencil drawing traced from the real product, and every
// answer inks the part of the window it configures — the agent inks the
// run-config control, the project inks the sidebar, the first task inks the
// composer and then the conversation. Nothing is explained in a separate
// card: the camera goes to the control, the question opens from it, and the
// answer appears in the real UI.

export type BlueprintChapter = 'agent' | 'project' | 'task';
type Phase = 'opening' | BlueprintChapter | 'handoff';

export type BlueprintAgent = {
  id: string;
  name: string;
  cliType: AgentConfigCliType;
  agentType: string;
  /** Where the agent comes from — the second line of its row. */
  origin: 'detected' | 'managed' | 'configured';
  status: 'ready' | 'installing' | 'needs-sign-in' | 'failed' | 'available';
  percent?: number;
  detail?: string;
};

export type BlueprintProject = { id: string; name: string; path: string; kind: 'local' | 'github' };

export type BlueprintOnboardingProps = {
  agents: BlueprintAgent[];
  projects: BlueprintProject[];
  suggestions: string[];
  initialPhase?: Phase;
  initialAgentId?: string | null;
  initialProjectId?: string | null;
  initialPrompt?: string;
  /** Called with the finished configuration; the host enters the product. */
  onFinish?: (result: { agentId: string | null; projectId: string | null; prompt: string }) => void;
  onAddAgent?: () => void;
  onChooseFolder?: () => void;
  onRetryAgent?: (id: string) => void;
  onSignInAgent?: (id: string) => void;
  /** Picking an agent Lody has not installed yet starts its install. */
  onInstallAgent?: (id: string) => void;
};

const ORDER: BlueprintChapter[] = ['agent', 'project', 'task'];

/** The desk kept around the window while it is being set up, in stage pixels. */
const DESK_MARGIN_X = 40;
const DESK_MARGIN_Y = 28;
/** Below this the product's own layout stops being itself; the camera scales down instead. */
const MIN_WINDOW = { width: 1024, height: 640 };
const MAX_WINDOW = { width: 1700, height: 1080 };

// One object, whole. During setup the window is laid out to fit the screen
// with a margin of desk around it, so it is always seen entire — title bar,
// edges, shadow — and never cropped into a strip. The opening stands back a
// little; every question is asked at 1:1; the handoff grows the window into
// the screen.
const OPENING: CameraShot = { anchor: 'window', padding: 88, maxScale: 1 };
const SETUP: CameraShot = { anchor: 'window', padding: DESK_MARGIN_Y - 8, maxScale: 1 };

/** Height of the drawn window's title bar, in window pixels. */
const CHROME = 36;

// A fresh Lody: no sessions in the sidebar, nothing in the conversation. The
// empty conversation is where the questions are asked, and where the first
// message will land.
const TRACKS: Partial<TourAppTracks> = { tasks: 0, childTabs: 0, reveal: 0 };

const styles = stylex.create({
  stage: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    isolation: 'isolate',
    backgroundColor: colors.secondaryBackground,
    color: colors.label,
  },
  camera: { position: 'absolute', inset: 0 },
  // --- the opening's words
  opening: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
  },
  openingTitle: {
    margin: 0,
    fontSize: '30px',
    lineHeight: 1.1,
    letterSpacing: '-0.025em',
    fontWeight: 600,
    textWrap: 'balance',
  },
  openingBody: {
    margin: 0,
    fontSize: '14px',
    lineHeight: 1.55,
    color: colors.secondaryLabel,
    maxWidth: '34ch',
  },
  openingActions: { display: 'flex', alignItems: 'center', gap: space[2], marginTop: space[2] },
  // --- the rail: the window's own title, so it is written in the title bar
  rail: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[6],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  railItem: {
    position: 'relative',
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    maxWidth: '300px',
    paddingBlock: '8px',
    paddingInline: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
  },
  railMarker: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '2px',
    borderRadius: radius.full,
    backgroundColor: colors.label,
  },
  railLabel: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.tertiaryLabel,
  },
  railLabelCurrent: { color: colors.secondaryLabel },
  railValue: {
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.label,
  },
  railValueEmpty: { color: colors.tertiaryLabel },
  flightIcon: { width: '16px', height: '16px' },
});

function useChapterLabels() {
  const { t } = useTranslation();
  return {
    agent: t('onboarding.blueprint.rail.agent', 'Agent'),
    project: t('onboarding.blueprint.rail.project', 'Project'),
    task: t('onboarding.blueprint.rail.task', 'First task'),
  } satisfies Record<BlueprintChapter, string>;
}

export function BlueprintOnboarding({
  agents,
  projects,
  suggestions,
  initialPhase = 'opening',
  initialAgentId = null,
  initialProjectId = null,
  initialPrompt = '',
  onFinish,
  onAddAgent,
  onChooseFolder,
  onRetryAgent,
  onSignInAgent,
  onInstallAgent,
}: BlueprintOnboardingProps): React.JSX.Element {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [agentId, setAgentId] = useState<string | null>(initialAgentId);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  // A chapter the person chose to leave for later, as opposed to one not reached.
  const [deferred, setDeferred] = useState<Set<BlueprintChapter>>(() => new Set());
  const [prompt, setPrompt] = useState(initialPrompt);
  const labels = useChapterLabels();
  // What the question has selected, and what has LANDED in the window. The
  // window, the ink and the rail follow the landed answer, so the product
  // changes when the answer arrives, not when it is clicked.
  const [landedAgentId, setLandedAgentId] = useState<string | null>(initialAgentId);
  const [landedProjectId, setLandedProjectId] = useState<string | null>(initialProjectId);
  const [flight, setFlight] = useState<Flight | null>(null);
  const flightCount = useRef(0);

  const agent = agents.find((candidate) => candidate.id === landedAgentId) ?? null;
  const project = projects.find((candidate) => candidate.id === landedProjectId) ?? null;
  // Anything but a failure can be chosen: an agent still arriving keeps
  // arriving after the flow moves on, and the rail says so.
  const usable = (candidate: BlueprintAgent | null): boolean =>
    candidate !== null && candidate.status !== 'failed';
  const agentUsable = usable(agent);
  const canRun = agent?.status === 'ready' && project !== null && prompt.trim().length > 0;

  // Choosing is answering: once the answer has landed and inked, the flow
  // moves on by itself. The rail is how to come back.
  const advanceTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    },
    []
  );
  const advanceAfterInk = (from: BlueprintChapter): void => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      setPhase((current) => {
        if (current !== from) return current;
        return ORDER[ORDER.indexOf(from) + 1] ?? 'handoff';
      });
    }, 1100);
  };

  const launch = (next: Omit<Flight, 'id'>): void => {
    flightCount.current += 1;
    playSelect();
    setFlight({ ...next, id: flightCount.current });
  };
  const pickAgent = (id: string, source: HTMLElement): void => {
    const picked = agents.find((candidate) => candidate.id === id);
    setAgentId(id);
    if (!picked || !usable(picked)) return;
    if (picked.status === 'available') onInstallAgent?.(id);
    launch({
      from: source.getBoundingClientRect(),
      to: () => (stageRef.current ? resolveAnchor(stageRef.current, 'composer.run-config') : null),
      label: (
        <>
          <AgentIcon
            cliType={picked.cliType}
            agentType={picked.agentType}
            className={stylex.props(styles.flightIcon).className}
          />
          {picked.name}
        </>
      ),
      onLand: () => {
        setLandedAgentId(id);
        playReveal();
        advanceAfterInk('agent');
      },
    });
  };
  const pickProject = (id: string, source: HTMLElement): void => {
    const picked = projects.find((candidate) => candidate.id === id);
    setProjectId(id);
    if (!picked) return;
    const shownName = project?.name ?? DEFAULT_TOUR_IDENTITY.projectName;
    launch({
      from: source.getBoundingClientRect(),
      // The sidebar's project header: the row that will carry this name.
      to: () => sidebarRow(stageRef.current, shownName),
      label: (
        <>
          <FolderIcon />
          {picked.name}
        </>
      ),
      onLand: () => {
        setLandedProjectId(id);
        playReveal();
        advanceAfterInk('project');
      },
    });
  };
  const pickSuggestion = (value: string, source: HTMLElement): void => {
    launch({
      from: source.getBoundingClientRect(),
      to: () => (stageRef.current ? resolveAnchor(stageRef.current, 'composer.input') : null),
      label: value,
      onLand: () => setPrompt(value),
    });
  };

  // Every camera move is a cut in the score; the opening's own entrance is not.
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    playCut();
  }, [phase]);

  const reached = (chapter: BlueprintChapter): boolean =>
    phase === 'handoff' ||
    (phase !== 'opening' && ORDER.indexOf(chapter) <= ORDER.indexOf(phase as BlueprintChapter));

  const regions = useMemo<BlueprintRegion[]>(() => {
    const state = (inked: boolean, current: boolean): BlueprintRegion['state'] =>
      inked ? 'ink' : current ? 'current' : 'sketch';
    const running = phase === 'handoff';
    return [
      // A choice inks its part of the window the moment it is made, behind
      // the open question, so the answer is seen landing in the real UI.
      {
        id: 'run-config',
        anchor: 'composer.run-config',
        state: state(agentUsable, phase === 'agent'),
        inkKey: landedAgentId ?? undefined,
      },
      {
        id: 'info-bar',
        anchor: 'info-bar',
        state: state(project !== null, phase === 'project'),
        inkFrom: 'info-bar',
        inkKey: landedProjectId ?? undefined,
      },
      {
        id: 'composer',
        anchor: 'composer',
        state: state(phase === 'task' || running, false),
        inkFrom: 'composer.input',
      },
      {
        id: 'sidebar',
        anchor: 'sidebar',
        state: state(project !== null, phase === 'project'),
        // From the project header, where the chosen row landed.
        inkAt: { x: 0.35, y: 0.14 },
        inkKey: landedProjectId ?? undefined,
      },
      { id: 'tab-bar', anchor: 'tab-bar', state: state(running, false) },
      { id: 'chrome', anchor: 'window.chrome', state: state(running, false) },
      { id: 'stream', anchor: 'stream', state: state(running, false), inkFrom: 'composer' },
    ];
  }, [agentUsable, landedAgentId, landedProjectId, phase, project]);

  const identity = useMemo(
    () => ({
      ...DEFAULT_TOUR_IDENTITY,
      projectName: project?.name ?? DEFAULT_TOUR_IDENTITY.projectName,
      ...(agent
        ? { agentName: agent.name, agentType: agent.agentType, agentCliType: agent.cliType }
        : {}),
    }),
    [agent, project]
  );

  const configurationState = useMemo<TourConfigurationState>(
    () => ({
      step: phase === 'agent' ? 'providers' : phase === 'project' ? 'projects' : 'firstTask',
      workspaceStatus: 'ready',
      agentStatus:
        agent?.status === 'installing'
          ? 'preparing'
          : agent?.status === 'needs-sign-in'
            ? 'awaiting-auth'
            : agent?.status === 'failed'
              ? 'failed'
              : agent
                ? 'ready'
                : 'missing',
      projectStatus: project ? 'ready' : 'missing',
      promptValue: prompt,
      conversationStatus: phase === 'handoff' ? 'starting' : prompt.trim() ? 'draft' : 'empty',
    }),
    [agent, phase, project, prompt]
  );

  const tracks = useMemo<Partial<TourAppTracks>>(
    // The run starts clean: the drawing shows what a conversation looks like,
    // the ink shows only what is actually happening.
    () => (phase === 'handoff' ? { ...TRACKS, reveal: 0 } : TRACKS),
    [phase]
  );

  // The screen the window stands on. Setup lays the window out to fit it.
  const [screen, setScreen] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = (): void =>
      setScreen((previous) =>
        previous?.width === stage.clientWidth && previous.height === stage.clientHeight
          ? previous
          : { width: stage.clientWidth, height: stage.clientHeight }
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // The handoff lands: once the last region has inked, the window grows until
  // it is the screen, so the window being configured becomes the app window
  // instead of cutting to it.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (phase !== 'handoff') {
      setLanded(false);
      return undefined;
    }
    const land = window.setTimeout(() => setLanded(true), 1300);
    const finish = window.setTimeout(
      () =>
        onFinish?.({
          agentId: landedAgentId,
          projectId: landedProjectId,
          prompt: canRun ? prompt : '',
        }),
      2900
    );
    return () => {
      window.clearTimeout(land);
      window.clearTimeout(finish);
    };
  }, [canRun, landedAgentId, landedProjectId, onFinish, phase, prompt]);
  // Landing re-lays the real window out at the screen's size, one to one, with
  // its drawn title bar above the top edge: the real window has its own.
  const windowSize = useMemo(() => {
    if (!screen) return undefined;
    if (landed) return { width: screen.width, height: screen.height + CHROME };
    const clamp = (value: number, min: number, max: number): number =>
      Math.round(Math.min(max, Math.max(min, value)));
    return {
      width: clamp(screen.width - DESK_MARGIN_X * 2, MIN_WINDOW.width, MAX_WINDOW.width),
      height: clamp(screen.height - DESK_MARGIN_Y * 2, MIN_WINDOW.height, MAX_WINDOW.height),
    };
  }, [landed, screen]);
  const shot = useMemo<CameraShot>(
    () =>
      landed && screen
        ? {
            anchor: 'window',
            padding: 0,
            minScale: 1,
            maxScale: 1,
            focusX: 0.5,
            focusY: 0.5 - CHROME / 2 / screen.height,
          }
        : phase === 'opening'
          ? OPENING
          : SETUP,
    [landed, phase, screen]
  );
  const overlay = useMemo(
    () => <SketchLayer regions={regions} drawOn={initialPhase === 'opening'} />,
    [initialPhase, regions]
  );

  const advance = (from: BlueprintChapter): void => {
    const next = ORDER[ORDER.indexOf(from) + 1];
    setPhase(next ?? 'handoff');
  };
  const defer = (chapter: BlueprintChapter): void => {
    setDeferred((previous) => new Set(previous).add(chapter));
    if (chapter === 'agent') {
      setAgentId(null);
      setLandedAgentId(null);
    }
    if (chapter === 'project') {
      setProjectId(null);
      setLandedProjectId(null);
    }
    advance(chapter);
  };

  const railValue = (chapter: BlueprintChapter): { text: string; empty: boolean } => {
    if (chapter === 'agent') {
      if (agent) return { text: agentRailText(agent, t), empty: false };
      return deferred.has('agent')
        ? { text: t('onboarding.blueprint.rail.later', 'Later, in Settings'), empty: true }
        : { text: '', empty: true };
    }
    if (chapter === 'project') {
      if (project) return { text: project.name, empty: false };
      return deferred.has('project')
        ? { text: t('onboarding.blueprint.rail.later', 'Later, in Settings'), empty: true }
        : { text: '', empty: true };
    }
    return prompt.trim() ? { text: prompt.trim(), empty: false } : { text: '', empty: true };
  };

  const chapter = phase === 'opening' || phase === 'handoff' ? null : phase;
  const taskBlocked =
    agent?.status !== 'ready'
      ? agent
        ? t(
            'onboarding.blueprint.task.agentPending',
            '{{agent}} is still arriving. Your task will wait for it in Lody.',
            { agent: agent.name }
          )
        : t('onboarding.blueprint.task.noAgent', 'Add an agent in Settings to run tasks.')
      : project === null
        ? t('onboarding.blueprint.task.noProject', 'Add a project in Settings to run tasks.')
        : null;

  return (
    <div ref={stageRef} {...stylex.props(styles.stage)} data-blueprint-phase={phase}>
      <motion.div
        {...stylex.props(styles.camera)}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
      >
        {/* Mounted once the screen is known: the window is laid out for it
            from its first frame instead of shrinking into it. */}
        {windowSize ? (
          <TourStill
            identity={identity}
            shot={shot}
            windowSize={windowSize}
            tilt
            tracks={tracks}
            configurationState={configurationState}
            windowShadow={
              '0 0 0 0.5px hsl(225 10% 11% / 0.08), 0 2px 6px -2px hsl(225 10% 11% / 0.08), 0 36px 80px -24px hsl(225 10% 11% / 0.28)'
            }
            overlay={overlay}
          />
        ) : null}
      </motion.div>

      {phase === 'opening' ? (
        <AnchoredPanel stageRef={stageRef} anchor="stream" placement="center" width={400} bare>
          <motion.div
            {...stylex.props(styles.opening)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.2, duration: 0.6, ease: [0.2, 0, 0, 1] }}
          >
            <h1 {...stylex.props(styles.openingTitle)}>
              {t(
                'onboarding.blueprint.opening.title',
                'Three answers, and Lody can start working.'
              )}
            </h1>
            <p {...stylex.props(styles.openingBody)}>
              {t(
                'onboarding.blueprint.opening.body',
                'Pick an agent, point it at a project, give it a first task.'
              )}
            </p>
            <div {...stylex.props(styles.openingActions)}>
              <Button size="large" autoFocus onClick={() => setPhase('agent')}>
                {t('onboarding.blueprint.opening.begin', 'Begin')}
              </Button>
              <Button size="large" variant="ghost" onClick={() => setPhase('handoff')}>
                {t('onboarding.blueprint.opening.skip', 'Skip setup')}
              </Button>
            </div>
          </motion.div>
        </AnchoredPanel>
      ) : null}

      {phase !== 'opening' ? (
        // Written in the window's title bar: the answers are the window's title.
        <AnchoredPanel
          stageRef={stageRef}
          anchor="window.chrome"
          placement="center"
          width={720}
          bare
        >
          <motion.ol
            {...stylex.props(styles.rail)}
            initial={{ opacity: 0 }}
            animate={{ opacity: phase === 'handoff' ? 0 : 1 }}
            // At the handoff the finished rail holds for a beat before it goes.
            transition={{ duration: 0.4, delay: phase === 'handoff' ? 1.3 : 0 }}
          >
            {ORDER.map((item) => {
              const current = item === phase;
              const value = railValue(item);
              return (
                <li key={item}>
                  <button
                    type="button"
                    disabled={!reached(item) || phase === 'handoff'}
                    onClick={() => setPhase(item)}
                    aria-current={current ? 'step' : undefined}
                    {...stylex.props(styles.railItem)}
                  >
                    {current ? (
                      <motion.span
                        layoutId="blueprint-rail-marker"
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                        {...stylex.props(styles.railMarker)}
                      />
                    ) : null}
                    <span {...stylex.props(styles.railLabel, current && styles.railLabelCurrent)}>
                      {labels[item]}
                    </span>
                    {value.text ? (
                      <span
                        {...stylex.props(styles.railValue, value.empty && styles.railValueEmpty)}
                      >
                        {value.text}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </motion.ol>
        </AnchoredPanel>
      ) : null}

      {chapter === 'agent' ? (
        // Above the composer, on its edges: the deck of agents the chip can hold.
        <AnchoredPanel
          key="agent"
          stageRef={stageRef}
          anchor="composer"
          placement="above-start"
          alignTo="composer.card"
          matchWidth="composer.card"
          width={700}
          gap={40}
          bare
        >
          <motion.div {...questionMotion}>
            <Question
              title={t('onboarding.blueprint.agent.title', 'Which agent does the work?')}
              body={t(
                'onboarding.blueprint.agent.body',
                'Ink is what is on this Mac; pencil is what Lody will fetch.'
              )}
              onSkip={() => defer('agent')}
            >
              <AgentDeck
                agents={agents}
                pickedId={agentId}
                onPick={pickAgent}
                onRetry={onRetryAgent}
                onSignIn={onSignInAgent}
                onAddAgent={onAddAgent}
              />
            </Question>
          </motion.div>
        </AnchoredPanel>
      ) : null}

      {chapter === 'project' ? (
        // Asked where every question is asked, in the empty conversation. The
        // answer flies to the sidebar, where the project will live.
        <AnchoredPanel
          key="project"
          stageRef={stageRef}
          anchor="composer"
          placement="above-start"
          alignTo="composer.card"
          matchWidth="composer.card"
          width={700}
          gap={40}
          bare
        >
          <motion.div {...questionMotion}>
            <Question
              title={t('onboarding.blueprint.project.title', 'Where should it work?')}
              body={t(
                'onboarding.blueprint.project.body',
                'Pick a folder. Its sessions will live in the sidebar.'
              )}
              onSkip={() => defer('project')}
            >
              <ProjectDeck
                projects={projects}
                pickedId={projectId}
                onPick={pickProject}
                onChooseFolder={onChooseFolder}
              />
            </Question>
          </motion.div>
        </AnchoredPanel>
      ) : null}

      {chapter === 'task' ? (
        // The empty conversation above the composer: the suggestions sit where
        // the first message will.
        <AnchoredPanel
          key="task"
          stageRef={stageRef}
          anchor="composer"
          placement="above-start"
          alignTo="composer.card"
          matchWidth="composer.card"
          width={700}
          gap={32}
          bare
        >
          <motion.div {...questionMotion}>
            <Question
              title={t('onboarding.blueprint.task.title', 'What should it do first?')}
              body={
                taskBlocked ??
                t('onboarding.blueprint.task.body', 'Write it in the composer, or pick one.')
              }
              onSkip={() => {
                setPrompt('');
                setPhase('handoff');
              }}
            >
              {taskBlocked ? null : (
                <SuggestionBubbles suggestions={suggestions} onPick={pickSuggestion} />
              )}
            </Question>
          </motion.div>
        </AnchoredPanel>
      ) : null}

      <AnswerFlight stageRef={stageRef} flight={flight} />

      {phase === 'task' ? (
        <PressOverlay
          stageRef={stageRef}
          anchor="composer.send"
          label={t('onboarding.blueprint.task.run', 'Run')}
          onPress={() => {
            if (!canRun) return;
            playClick();
            setPhase('handoff');
          }}
        />
      ) : null}
      {phase === 'task' ? (
        <FieldOverlay
          stageRef={stageRef}
          anchor="composer.input"
          value={prompt}
          onChange={setPrompt}
          onSubmit={() => {
            if (!canRun) return;
            playClick();
            setPhase('handoff');
          }}
          autoFocus
        />
      ) : null}
    </div>
  );
}

/** The sidebar row that currently shows `name`: the project header. */
function sidebarRow(stage: HTMLElement | null, name: string): HTMLElement | null {
  const sidebar = stage?.querySelector('[data-tour-anchor="sidebar"]');
  if (!sidebar) return null;
  for (const node of sidebar.querySelectorAll<HTMLElement>('span, div')) {
    if (node.childElementCount === 0 && node.textContent?.trim() === name) return node;
  }
  return null;
}

function agentRailText(agent: BlueprintAgent, t: ReturnType<typeof useTranslation>['t']): string {
  switch (agent.status) {
    case 'installing':
      return t('onboarding.blueprint.rail.installing', '{{name}} · installing {{percent}}%', {
        name: agent.name,
        percent: Math.round(agent.percent ?? 0),
      });
    case 'needs-sign-in':
      return t('onboarding.blueprint.rail.signIn', '{{name}} · sign-in needed', {
        name: agent.name,
      });
    case 'failed':
      return t('onboarding.blueprint.rail.failed', '{{name}} · needs attention', {
        name: agent.name,
      });
    default:
      return agent.name;
  }
}

function FolderIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

const questionMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: 0.45, duration: 0.4, ease: [0.2, 0, 0, 1] as const },
};
