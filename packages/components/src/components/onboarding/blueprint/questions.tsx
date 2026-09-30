import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { FolderPlus, Plus } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { AgentIcon } from '@/components/icons/agent-icon';
import { pencilRect } from './sketch';
import type { BlueprintAgent, BlueprintProject } from './blueprint-onboarding';

// The questions, drawn in the same language as the window.
//
// Nothing here is a popover of rows. An option is drawn where it will live and
// in the state it is actually in: pencil for what is not on this Mac yet, ink
// for what is. An agent Lody is still fetching is a card filling with ink from
// the bottom — the fill IS the download. Choosing is inking: the choice leaves
// the question and lands in the product.

const styles = stylex.create({
  // --- the question itself: editorial type on the canvas
  question: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  questionTitle: {
    margin: 0,
    fontSize: '26px',
    lineHeight: 1.15,
    fontWeight: 600,
    letterSpacing: '-0.022em',
    color: colors.label,
    textWrap: 'balance',
  },
  questionFoot: { display: 'flex', alignItems: 'baseline', gap: space[3] },
  questionBody: {
    margin: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },

  // --- pencil frame shared by every drawn option
  frame: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    overflow: 'visible',
    pointerEvents: 'none',
  },
  frameStroke: {
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    transitionProperty: 'stroke, opacity',
    transitionDuration: '160ms',
  },
  frameGraphite: { stroke: colors.label, opacity: 0.45 },
  frameStrong: { stroke: colors.label, opacity: 0.8 },
  frameFaint: { opacity: 0.2 },

  // --- the agent deck
  // One row, always: the deck is a hand of cards, and a wrapped hand reads as a grid.
  deck: { display: 'flex', gap: '12px', marginTop: space[4], flexWrap: 'nowrap' },
  card: {
    position: 'relative',
    boxSizing: 'border-box',
    flexShrink: 0,
    width: '152px',
    height: '168px',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    transform: { default: 'translateY(0)', ':hover': 'translateY(-3px)' },
    transitionProperty: 'transform',
    transitionDuration: '220ms',
    transitionTimingFunction: 'cubic-bezier(.2,0,0,1)',
    outlineStyle: 'none',
  },
  cardPicked: { transform: 'translateY(-6px)' },
  cardFace: {
    position: 'absolute',
    inset: 0,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '16px',
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  // Pencil face: what is not here yet. The mark is drawn, not coloured.
  cardPencil: { color: colors.secondaryLabel },
  cardPencilMark: { filter: 'grayscale(1)', opacity: 0.5 },
  // Ink face: the card rung, clipped from the bottom by how much has arrived.
  cardInk: {
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    color: colors.label,
    transitionProperty: 'clip-path, box-shadow',
    transitionDuration: '700ms, 220ms',
    transitionTimingFunction: 'cubic-bezier(.3,0,.1,1)',
  },
  cardInkLifted: { boxShadow: `0 0 0 2px ${colors.accent}, ${shadow.medium}` },
  cardMark: { width: '30px', height: '30px' },
  cardName: {
    fontSize: '15px',
    lineHeight: '20px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
  },
  cardDetail: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  cardDetailDanger: { color: colors.destructive },
  cardAdd: {
    alignItems: 'flex-start',
    color: colors.secondaryLabel,
  },

  // --- project cards: a folder on this Mac is already here, so it is ink
  cardShort: { height: '128px' },
  cardPath: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
  folderMark: { width: '22px', height: '22px', color: colors.secondaryLabel },

  // --- suggestions drawn as the first message would sit
  bubbles: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '10px',
    marginTop: space[4],
  },
  bubble: {
    position: 'relative',
    maxWidth: '70%',
    paddingBlock: '8px',
    paddingInline: '14px',
    borderWidth: 0,
    borderRadius: '16px',
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, transparent, ${colors.label} 4%)`,
    },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
  },
});

/** A pencil outline that fits whatever it sits in, drawn on when it appears. */
export function PencilFrame({
  radius: cornerRadius,
  strong = false,
  seed = 1,
}: {
  radius: number;
  strong?: boolean;
  seed?: number;
}): React.JSX.Element {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setSize({ w: rect.width, h: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const paths = size
    ? pencilRect({ x: 0.75, y: 0.75, w: size.w - 1.5, h: size.h - 1.5 }, cornerRadius, seed)
    : null;
  return (
    <svg ref={ref} aria-hidden {...stylex.props(styles.frame)}>
      {paths ? (
        <>
          <path
            d={paths[0]}
            vectorEffect="non-scaling-stroke"
            strokeWidth={1.3}
            {...stylex.props(
              styles.frameStroke,
              strong ? styles.frameStrong : styles.frameGraphite
            )}
          />
          <path
            d={paths[1]}
            vectorEffect="non-scaling-stroke"
            strokeWidth={0.8}
            {...stylex.props(styles.frameStroke, styles.frameGraphite, styles.frameFaint)}
          />
        </>
      ) : null}
    </svg>
  );
}

export function Question({
  title,
  body,
  onSkip,
  children,
}: {
  title: ReactNode;
  body: ReactNode;
  onSkip?: () => void;
  children?: ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.question)}>
      <h2 {...stylex.props(styles.questionTitle)}>{title}</h2>
      <div {...stylex.props(styles.questionFoot)}>
        <p {...stylex.props(styles.questionBody)}>{body}</p>
        {onSkip ? (
          <Button variant="ghost" size="small" onClick={onSkip}>
            {t('onboarding.blueprint.skip', 'Skip')}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** How much of an agent is on this Mac, 0..100: the card's ink level. */
function inkLevel(agent: BlueprintAgent): number {
  switch (agent.status) {
    case 'ready':
    case 'needs-sign-in':
      return 100;
    case 'installing':
      return Math.max(4, Math.min(100, agent.percent ?? 0));
    default:
      return 0;
  }
}

export function AgentDeck({
  agents,
  pickedId,
  onPick,
  onRetry,
  onSignIn,
  onAddAgent,
}: {
  agents: BlueprintAgent[];
  pickedId: string | null;
  onPick: (id: string, source: HTMLElement) => void;
  onRetry?: (id: string) => void;
  onSignIn?: (id: string) => void;
  onAddAgent?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const detail = (agent: BlueprintAgent): string => {
    switch (agent.status) {
      case 'ready':
        return agent.origin === 'managed'
          ? t('onboarding.blueprint.agent.installed', 'Installed by Lody')
          : t('onboarding.blueprint.agent.onThisMac', 'On this Mac');
      case 'installing':
        return t('onboarding.blueprint.agent.arriving', '{{percent}}% here', {
          percent: Math.round(agent.percent ?? 0),
        });
      case 'needs-sign-in':
        return t('onboarding.blueprint.agent.needsSignIn', 'Sign in once');
      case 'failed':
        return agent.detail ?? t('onboarding.blueprint.agent.failed', 'Could not start');
      default:
        return t('onboarding.blueprint.agent.managed', 'Lody installs it');
    }
  };
  return (
    <div {...stylex.props(styles.deck)} role="radiogroup">
      {agents.map((agent, index) => {
        const level = inkLevel(agent);
        const picked = agent.id === pickedId;
        const face = (inked: boolean) => (
          <>
            <AgentIcon
              cliType={agent.cliType}
              agentType={agent.agentType}
              className={stylex.props(styles.cardMark, !inked && styles.cardPencilMark).className}
            />
            <span>
              <span {...stylex.props(styles.cardName)}>{agent.name}</span>
              <br />
              <span
                {...stylex.props(
                  styles.cardDetail,
                  agent.status === 'failed' && styles.cardDetailDanger
                )}
              >
                {detail(agent)}
              </span>
            </span>
          </>
        );
        return (
          <div
            key={agent.id}
            role="radio"
            aria-checked={picked}
            tabIndex={0}
            onClick={(event) => {
              if (agent.status === 'failed') onRetry?.(agent.id);
              else if (agent.status === 'needs-sign-in' && picked) onSignIn?.(agent.id);
              else onPick(agent.id, event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onPick(agent.id, event.currentTarget);
              }
            }}
            {...stylex.props(styles.card, picked && styles.cardPicked)}
          >
            <span {...stylex.props(styles.cardFace, styles.cardPencil)}>
              <PencilFrame radius={14} seed={index * 97 + 11} strong={picked} />
              {face(false)}
            </span>
            <span
              {...stylex.props(styles.cardFace, styles.cardInk, picked && styles.cardInkLifted)}
              style={{ clipPath: `inset(${100 - level}% -8px -8px -8px round 14px)` }}
              aria-hidden={level === 0}
            >
              {face(true)}
            </span>
          </div>
        );
      })}
      <button type="button" onClick={onAddAgent} {...stylex.props(styles.card)}>
        <span {...stylex.props(styles.cardFace, styles.cardAdd)}>
          <PencilFrame radius={14} seed={503} />
          <Plus style={{ width: 22, height: 22 }} />
          <span {...stylex.props(styles.cardName)}>
            {t('onboarding.blueprint.agent.more', 'Other agents')}
          </span>
        </span>
      </button>
    </div>
  );
}

export function ProjectDeck({
  projects,
  pickedId,
  onPick,
  onChooseFolder,
}: {
  projects: BlueprintProject[];
  pickedId: string | null;
  onPick: (id: string, source: HTMLElement) => void;
  onChooseFolder?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.deck)} role="radiogroup">
      {projects.map((project) => {
        const picked = project.id === pickedId;
        return (
          <button
            key={project.id}
            type="button"
            role="radio"
            aria-checked={picked}
            onClick={(event) => onPick(project.id, event.currentTarget)}
            {...stylex.props(styles.card, styles.cardShort, picked && styles.cardPicked)}
          >
            <span
              {...stylex.props(styles.cardFace, styles.cardInk, picked && styles.cardInkLifted)}
            >
              <FolderIcon {...stylex.props(styles.folderMark)} />
              <span>
                <span {...stylex.props(styles.cardName)}>{project.name}</span>
                <span {...stylex.props(styles.cardPath)}>{project.path}</span>
              </span>
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onChooseFolder}
        {...stylex.props(styles.card, styles.cardShort)}
      >
        <span {...stylex.props(styles.cardFace, styles.cardAdd)}>
          <PencilFrame radius={14} seed={211} />
          <FolderPlus {...stylex.props(styles.folderMark)} />
          <span {...stylex.props(styles.cardName)}>
            {t('onboarding.blueprint.project.choose', 'Choose a folder…')}
          </span>
        </span>
      </button>
    </div>
  );
}

function FolderIcon(props: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function SuggestionBubbles({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (value: string, source: HTMLElement) => void;
}): React.JSX.Element {
  return (
    <div {...stylex.props(styles.bubbles)}>
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion}
          type="button"
          onClick={(event) => onPick(suggestion, event.currentTarget)}
          {...stylex.props(styles.bubble)}
        >
          <PencilFrame radius={16} seed={index * 131 + 3} />
          {suggestion}
        </button>
      ))}
    </div>
  );
}
