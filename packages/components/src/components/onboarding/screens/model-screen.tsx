import * as stylex from '@stylexjs/stylex';
import { motion } from 'framer-motion';
import { WINDOW_DRAG_EXEMPT_CLASS } from '@/ui/window-drag-region';
import { copyEnterProps, useOnboardingReducedMotion } from '../motion-tokens';
import {
  useOnboardingAnalytics,
  type OnboardingModelConnectionMethod,
} from '../onboarding-analytics';
import { MODEL_CHIP_LAYOUT_ID } from '../onboarding-chip-rail';
import { ConnectModelSheet } from '../shared/connect-model-sheet';
import { flatSurface } from '../shared/flat-surface.stylex';
import type { ConnectedModelPayload } from '../shared/sorbet-onboarding-controller';

const styles = stylex.create({
  stage: {
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: 'clamp(1.5rem, 5vw, 4rem)',
    paddingTop: 'clamp(4.5rem, 8vh, 5.75rem)',
    paddingBottom: 'clamp(2rem, 5vh, 3.5rem)',
  },
  sheetFrame: {
    width: '100%',
    maxWidth: '32.5rem',
  },
});

function classifyAnalyticsConnectionMethod(
  payload: ConnectedModelPayload
): OnboardingModelConnectionMethod {
  if (payload.source.kind === 'oauth') return 'oauth';
  if (payload.source.kind === 'imported') {
    if (payload.source.from === 'claude-code') return 'import_claude_code';
    if (payload.source.from === 'codex') return 'import_codex';
    return 'import_env';
  }
  return 'api_key';
}

export function ModelScreen({
  onConnected,
  onSkip,
}: {
  onConnected: (payload: ConnectedModelPayload, method: OnboardingModelConnectionMethod) => void;
  onSkip: () => void;
}) {
  const reducedMotion = useOnboardingReducedMotion();
  const analytics = useOnboardingAnalytics();

  return (
    <div
      {...stylex.props(styles.stage, flatSurface.onboardingLightScope)}
      data-testid="onboarding-model-screen"
    >
      <motion.div
        {...copyEnterProps(reducedMotion)}
        {...stylex.props(styles.sheetFrame)}
        className={WINDOW_DRAG_EXEMPT_CLASS}
      >
        <ConnectModelSheet
          showHeader
          chipLayoutId={MODEL_CHIP_LAYOUT_ID}
          onConnected={(payload) => {
            const method = classifyAnalyticsConnectionMethod(payload);
            analytics.capture('onboarding/operation_succeeded', {
              step: 'model',
              operation:
                method === 'oauth'
                  ? 'model_connect_oauth'
                  : method.startsWith('import_')
                    ? 'model_connect_import'
                    : 'model_connect_api_key',
              connection_method: method,
            });
            onConnected(payload, method);
          }}
          onSkip={() => {
            analytics.capture('onboarding/operation_succeeded', {
              step: 'model',
              connection_method: 'skip',
            });
            onSkip();
          }}
        />
      </motion.div>
    </div>
  );
}
