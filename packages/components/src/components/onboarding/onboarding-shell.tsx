import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { PlatformContext } from '@lody/platform/react';
import { ArrowLeft, Check } from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { TourStill, type TourStillDebugOptions } from './tour/tour-still';
import { DEFAULT_TOUR_IDENTITY, type TourIdentity } from './tour/tour-fixtures';
import type { TourAppTracks, TourConfigurationState } from './tour/tour-app';
import type { CameraShot } from './tour/camera';
import { applyOnboardingDebugShot, onboardingDebugAtom } from './onboarding-debug';
import { playBack, playClick, playHover, playSelect } from './ceremony/ui-sounds';
import type { OnboardingStepKey } from './onboarding-steps';
import { onboardingShellSurface } from './onboarding-shell.surface';

// The configuration screens and the product are two layers on one stage.
// `TourStill` is the camera layer; the active form is foreground direction.
// There is deliberately no permanent left/right card here. A composition can
// happen to put the form beside the product, but the next step is free to move
// both of them somewhere else as configuration becomes a real conversation.

const STEP_SHOWS_SESSION: Partial<Record<OnboardingStepKey, boolean>> = {
  // Sign-in is the first thing asked of the user, and it sends them out of the
  // app to do it. Showing what is on the other side is the whole argument for
  // going.
  login: true,
  workspace: true,
  providers: true,
  projects: true,
  firstTask: true,
  summary: true,
  // The panel IS the preview: picking a theme sets the global theme and picking
  // a language changes i18n, so the real window re-renders under both. Nothing
  // else on this screen has to show anything.
  appearance: true,
};

/**
 * Each shot names a real DOM anchor in TourApp. The enclosing viewport below
 * decides where that shot appears on the onboarding stage.
 */
const STEP_FRAME: Partial<Record<OnboardingStepKey, CameraShot>> = {
  login: { anchor: 'window', padding: 42, focusX: 0.73, focusY: 0.52 },
  workspace: {
    anchor: 'sidebar',
    zoom: 1.8,
    padding: 76,
    focusX: 0.27,
    focusY: 0.88,
  },
  providers: {
    anchor: 'composer.run-config',
    padding: 80,
    maxScale: 1.8,
    focusX: 0.72,
    focusY: 0.56,
  },
  // Picking a project is about a list on the LEFT, so this is the one step that
  // earns a move. Frames the real sidebar node rather than a hand-written
  // rectangle, so it stays correct when that column changes.
  projects: { anchor: 'sidebar', padding: 54, maxScale: 1.6, focusX: 0.72, focusY: 0.53 },
  firstTask: { anchor: 'composer', padding: 70, maxScale: 1.5, focusX: 0.7, focusY: 0.67 },
  summary: { anchor: 'window', padding: 42, focusX: 0.72, focusY: 0.51 },
  appearance: { anchor: 'window', padding: 42, focusX: 0.28, focusY: 0.51 },
};

interface FormPose {
  left: string;
  top: string;
  bottom: string;
  width: string;
  /** Nearest viewport edge used for the sequential leave/enter move. */
  edge: 'left' | 'right';
}

interface StageComposition {
  /** Position of the configuration content in the stage. */
  form: FormPose;
  /** Opacity only: the camera viewport itself always fills the whole stage. */
  cameraOpacity: number;
  /** Horizontal readability gradient; a vertical mask softens its top/bottom. */
  veil: 'left' | 'right' | 'centre';
}

const VEIL_BACKGROUND: Record<StageComposition['veil'], string> = {
  left: 'linear-gradient(90deg, rgba(239,244,245,0.58) 0%, rgba(239,244,245,0.38) 30%, rgba(239,244,245,0.12) 50%, rgba(239,244,245,0) 70%)',
  right:
    'linear-gradient(270deg, rgba(239,244,245,0.58) 0%, rgba(239,244,245,0.38) 30%, rgba(239,244,245,0.12) 50%, rgba(239,244,245,0) 70%)',
  centre:
    'radial-gradient(ellipse at center, rgba(239,244,245,0.5) 0%, rgba(239,244,245,0.2) 54%, rgba(239,244,245,0) 78%)',
};

const VEIL_MASK: Record<StageComposition['veil'], string> = {
  left: 'radial-gradient(ellipse 72% 50% at 0% 50%, black 0%, black 60%, transparent 100%)',
  right: 'radial-gradient(ellipse 72% 50% at 100% 50%, black 0%, black 60%, transparent 100%)',
  centre: 'radial-gradient(ellipse 52% 50% at 50% 50%, black 0%, black 60%, transparent 100%)',
};

/**
 * Neutral stage compositions. The product window stays level and each step
 * moves a real DOM anchor into a clear region beside the form.
 *
 * Below 1080px the form moves to the centre and the product becomes a quiet
 * full-stage context layer. That preserves the camera without making a small
 * window solve an impossible two-column layout.
 */
const STEP_COMPOSITION: Partial<Record<OnboardingStepKey, StageComposition>> = {
  login: {
    form: {
      left: '7%',
      top: '16%',
      bottom: '11%',
      width: 'min(430px, 38%)',
      edge: 'left',
    },
    cameraOpacity: 0.65,
    veil: 'left',
  },
  workspace: {
    form: {
      left: 'calc(93.5% - min(455px, 39%))',
      top: '10%',
      bottom: '8%',
      width: 'min(455px, 39%)',
      edge: 'right',
    },
    cameraOpacity: 0.65,
    veil: 'right',
  },
  providers: {
    form: {
      left: '6.5%',
      top: '10%',
      bottom: '7%',
      width: 'min(470px, 40%)',
      edge: 'left',
    },
    cameraOpacity: 0.6,
    veil: 'left',
  },
  projects: {
    form: {
      left: '6.5%',
      top: '11%',
      bottom: '8%',
      width: 'min(455px, 39%)',
      edge: 'left',
    },
    cameraOpacity: 0.55,
    veil: 'left',
  },
  firstTask: {
    form: {
      left: '6.5%',
      top: '13%',
      bottom: '10%',
      width: 'min(465px, 40%)',
      edge: 'left',
    },
    cameraOpacity: 0.6,
    veil: 'left',
  },
  summary: {
    form: {
      left: '8%',
      top: '18%',
      bottom: '14%',
      width: 'min(460px, 42%)',
      edge: 'left',
    },
    cameraOpacity: 0.48,
    veil: 'left',
  },
  language: {
    form: {
      left: 'calc(93% - min(450px, 40%))',
      top: '13%',
      bottom: '10%',
      width: 'min(450px, 40%)',
      edge: 'right',
    },
    cameraOpacity: 0.5,
    veil: 'right',
  },
  theme: {
    form: {
      left: 'calc(93% - min(450px, 40%))',
      top: '13%',
      bottom: '10%',
      width: 'min(450px, 40%)',
      edge: 'right',
    },
    cameraOpacity: 0.5,
    veil: 'right',
  },
  appearance: {
    form: {
      left: 'calc(93% - min(450px, 40%))',
      top: '13%',
      bottom: '10%',
      width: 'min(450px, 40%)',
      edge: 'right',
    },
    cameraOpacity: 0.5,
    veil: 'right',
  },
  invite: {
    form: {
      left: 'calc(50% - min(280px, 43%))',
      top: '16%',
      bottom: '12%',
      width: 'min(560px, 86%)',
      edge: 'right',
    },
    cameraOpacity: 0.2,
    veil: 'centre',
  },
};

const STEP_CONFIGURATION_STATE: Partial<Record<OnboardingStepKey, TourConfigurationState>> = {
  login: {
    step: 'login',
    workspaceStatus: 'ready',
    agentStatus: 'ready',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'empty',
  },
  workspace: {
    step: 'workspace',
    workspaceStatus: 'missing',
    agentStatus: 'ready',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'empty',
  },
  providers: {
    step: 'providers',
    workspaceStatus: 'ready',
    agentStatus: 'missing',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'empty',
  },
  projects: {
    step: 'projects',
    workspaceStatus: 'ready',
    agentStatus: 'ready',
    projectStatus: 'missing',
    promptValue: '',
    conversationStatus: 'empty',
  },
  firstTask: {
    step: 'firstTask',
    workspaceStatus: 'ready',
    agentStatus: 'ready',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'empty',
  },
  summary: {
    step: 'summary',
    workspaceStatus: 'ready',
    agentStatus: 'ready',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'running',
  },
  language: {
    step: 'appearance',
    workspaceStatus: 'ready',
    agentStatus: 'missing',
    projectStatus: 'missing',
    promptValue: '',
    conversationStatus: 'empty',
  },
  theme: {
    step: 'appearance',
    workspaceStatus: 'ready',
    agentStatus: 'missing',
    projectStatus: 'missing',
    promptValue: '',
    conversationStatus: 'empty',
  },
  appearance: {
    step: 'appearance',
    workspaceStatus: 'ready',
    agentStatus: 'missing',
    projectStatus: 'missing',
    promptValue: '',
    conversationStatus: 'empty',
  },
  invite: {
    step: 'invite',
    workspaceStatus: 'ready',
    agentStatus: 'ready',
    projectStatus: 'ready',
    promptValue: '',
    conversationStatus: 'empty',
  },
};

export interface OnboardingShellProps {
  /** Step in the flow — drives the eyebrow counter and the panel's palette. */
  stepKey: OnboardingStepKey;
  /**
   * Optional override for the eyebrow text. Falls back to the localised
   * "Step X of Y" label so callers don't have to repeat the count.
   */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Main content beneath the heading. */
  children: ReactNode;
  /** Action row pinned to the bottom-right (Next / Done). */
  primaryAction?: ReactNode;
  /** Optional secondary slot to the left of the primary action. */
  secondaryAction?: ReactNode;
  /** Form state drives the camera; the moving film's playhead is not involved. */
  previewShot?: CameraShot;
  /** Product fixture values that become visible as configuration succeeds. */
  previewIdentity?: Partial<TourIdentity>;
  /** Discrete product state revealed by the current configuration step. */
  previewTracks?: Partial<TourAppTracks>;
  /** Current form state projected into the real product UI. */
  previewState?: Partial<TourConfigurationState>;
  /** Development-only diagnostics for camera composition stories. */
  previewDebug?: TourStillDebugOptions;
  /**
   * Retained for screens that still pass it. Stage composition is step-driven,
   * so there is no fixed narrow/wide card to switch between.
   */
  size?: 'narrow' | 'wide';
}

type RegisterOnboardingShell = (props: OnboardingShellProps) => void;

const OnboardingShellHostContext = createContext<RegisterOnboardingShell | null>(null);

/**
 * Keeps the stage, product window and camera mounted while configuration screens
 * change. Individual screens still own their data and actions; they register
 * render props into this stable host through `OnboardingShell`.
 */
export function OnboardingShellHost({ children }: { children: ReactNode }) {
  const [shell, setShell] = useState<OnboardingShellProps | null>(null);
  const register = useCallback((next: OnboardingShellProps) => setShell(next), []);

  return (
    <OnboardingShellHostContext.Provider value={register}>
      {children}
      {shell ? <OnboardingShellSurface {...shell} previewEnabled /> : null}
    </OnboardingShellHostContext.Provider>
  );
}

export function OnboardingShell({
  stepKey,
  eyebrow,
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
  previewShot,
  previewIdentity,
  previewTracks,
  previewState,
  previewDebug,
}: OnboardingShellProps) {
  const register = useContext(OnboardingShellHostContext);
  const props = useMemo<OnboardingShellProps>(
    () => ({
      stepKey,
      eyebrow,
      title,
      description,
      children,
      primaryAction,
      secondaryAction,
      previewShot,
      previewIdentity,
      previewTracks,
      previewState,
      previewDebug,
    }),
    [
      children,
      description,
      eyebrow,
      previewIdentity,
      previewShot,
      previewTracks,
      previewState,
      previewDebug,
      primaryAction,
      secondaryAction,
      stepKey,
      title,
    ]
  );

  useLayoutEffect(() => {
    register?.(props);
  }, [props, register]);

  if (register) return null;
  return <OnboardingShellSurface {...props} />;
}

function OnboardingShellSurface({
  stepKey,
  eyebrow,
  title,
  description,
  children,
  primaryAction,
  secondaryAction,
  previewShot,
  previewIdentity,
  previewTracks,
  previewState,
  previewDebug,
  previewEnabled = false,
}: OnboardingShellProps & { previewEnabled?: boolean }) {
  const platform = useContext(PlatformContext);
  const showsSession =
    previewEnabled && platform !== null && (STEP_SHOWS_SESSION[stepKey] ?? false);
  const identity = useMemo(
    () => ({ ...DEFAULT_TOUR_IDENTITY, ...previewIdentity }),
    [previewIdentity]
  );
  const composition = STEP_COMPOSITION[stepKey] ?? STEP_COMPOSITION.appearance!;
  const debug = useAtomValue(onboardingDebugAtom);
  const baseShot = previewShot ?? STEP_FRAME[stepKey] ?? { anchor: 'window', padding: 26 };
  const shot = import.meta.env.DEV ? applyOnboardingDebugShot(baseShot, debug) : baseShot;
  const previewStep =
    stepKey === 'ceremony' || stepKey === 'language' || stepKey === 'theme'
      ? 'appearance'
      : stepKey;
  const baseConfigurationState =
    STEP_CONFIGURATION_STATE[stepKey] ?? STEP_CONFIGURATION_STATE.appearance!;
  // Direction is a small spatial cue; opacity carries the step change. Keep
  // this distance fixed so a wider form never travels farther than a narrow one.
  const formOffsetX = composition.form.edge === 'left' ? -72 : 72;

  const stage = stylex.props(onboardingShellSurface.stage);
  const camera = stylex.props(onboardingShellSurface.camera);
  const form = stylex.props(onboardingShellSurface.form, onboardingShellSurface.formCompact);
  const veil = stylex.props(onboardingShellSurface.veil);
  const scroller = stylex.props(onboardingShellSurface.scroller);
  const column = stylex.props(onboardingShellSurface.column);
  const actions = stylex.props(onboardingShellSurface.actions);

  return (
    <div data-onboarding-stage={stepKey} {...stage} className={stage.className}>
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.82 }}
        transition={{ duration: 0.72, ease: [0.22, 1, 0.36, 1] }}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(33,68,79,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(33,68,79,0.055) 1px, transparent 1px), radial-gradient(circle at 52% 42%, rgba(255,255,255,0.92), rgba(239,244,245,0.72) 58%, rgba(220,229,231,0.78))',
          backgroundSize: '44px 44px, 44px 44px, 100% 100%',
        }}
      />

      {showsSession ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.12, duration: 0.68, ease: [0.22, 1, 0.36, 1] }}
            style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
          >
            <div
              {...camera}
              className={camera.className}
              style={
                { '--onboarding-camera-opacity': composition.cameraOpacity } as React.CSSProperties
              }
              data-onboarding-camera={stepKey}
            >
              <TourStill
                identity={identity}
                shot={shot}
                tracks={previewTracks}
                configurationState={{
                  ...baseConfigurationState,
                  ...previewState,
                  step: previewStep,
                }}
                debug={
                  import.meta.env.DEV
                    ? {
                        ...previewDebug,
                        showAnchors: debug.showAnchors || previewDebug?.showAnchors,
                        activeAnchor: shot.anchor,
                      }
                    : previewDebug
                }
              />
            </div>
          </motion.div>
          <motion.div
            aria-hidden
            {...veil}
            className={veil.className}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
            style={{
              backgroundImage: VEIL_BACKGROUND[composition.veil],
              backdropFilter: 'blur(40px)',
              maskImage: VEIL_MASK[composition.veil],
              WebkitMaskImage: VEIL_MASK[composition.veil],
            }}
          />
        </>
      ) : null}

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.58, ease: [0.22, 1, 0.36, 1] }}
        style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={stepKey}
            initial={{ x: formOffsetX, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: formOffsetX, opacity: 0 }}
            transition={{
              x: { type: 'spring', stiffness: 260, damping: 28, mass: 0.8 },
              opacity: { duration: 0.2, ease: 'easeOut' },
            }}
            {...form}
            className={form.className}
            style={{
              left: composition.form.left,
              top: composition.form.top,
              bottom: composition.form.bottom,
              width: composition.form.width,
            }}
            data-onboarding-form={stepKey}
          >
            <div {...scroller} className={clsx(scroller.className, 'scrollbar-pro')}>
              <div {...column} className={column.className}>
                {eyebrow == null ? null : (
                  <div {...stylex.props(onboardingShellSurface.eyebrow)}>{eyebrow}</div>
                )}
                <h1 {...stylex.props(onboardingShellSurface.title)}>{title}</h1>
                {description == null ? null : (
                  <div {...stylex.props(onboardingShellSurface.description)}>{description}</div>
                )}
                <div {...stylex.props(onboardingShellSurface.content)}>{children}</div>
              </div>
            </div>
            {secondaryAction || primaryAction ? (
              <div {...actions} className={actions.className}>
                {secondaryAction}
                {primaryAction}
              </div>
            ) : null}
          </motion.section>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

interface OnboardingBackButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** Override the default "Back" label (e.g. "Back to list", "Cancel"). */
  label?: ReactNode;
}

export function OnboardingBackButton({ onClick, disabled, label }: OnboardingBackButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      onMouseEnter={() => playHover()}
      size="large"
      onClick={() => {
        // Going back falls in pitch, as it does everywhere else in the flow.
        playBack();
        onClick();
      }}
      disabled={disabled}
    >
      <ArrowLeft {...stylex.props(onboardingShellSurface.glyph)} />
      {label ?? t('common.back', 'Back')}
    </Button>
  );
}

interface OnboardingNextButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** Show a leading spinner and hide the trailing arrow. */
  loading?: boolean;
  /** Override the default "Next" label. */
  label?: ReactNode;
  /** Use a check glyph instead of the arrow (final step). */
  finish?: boolean;
}

export function OnboardingNextButton({
  onClick,
  disabled,
  loading,
  label,
  finish,
}: OnboardingNextButtonProps) {
  const { t } = useTranslation();
  const isFinish = finish === true;
  const text = label ?? (isFinish ? t('common.finish', 'Finish') : t('common.next', 'Next'));
  return (
    <Button
      onMouseEnter={() => playHover()}
      size="large"
      onClick={() => {
        // Advancing rises; the last step gets the confirming click instead.
        if (isFinish) playClick();
        else playSelect();
        onClick();
      }}
      disabled={disabled}
    >
      {loading === true ? (
        <Spinner {...stylex.props(onboardingShellSurface.glyph)} />
      ) : isFinish ? (
        <Check {...stylex.props(onboardingShellSurface.glyph)} />
      ) : null}
      {text}
    </Button>
  );
}
