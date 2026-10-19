import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  E2eeAccessStatus,
  E2eeRecoveryStatus,
  type E2eeAccessState,
  type E2eeRecoveryState,
  type E2eeRecoveryWorkspace,
} from '../components/e2ee/e2ee-status';

const styles = stylex.create({
  page: { maxWidth: 1000, marginInline: 'auto', padding: space[4], display: 'grid', gap: space[6] },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
    gap: space[4],
    alignItems: 'start',
  },
  block: { display: 'grid', gap: space[3], minWidth: 0 },
  title: { margin: 0, fontSize: '1.4em', fontWeight: 600 },
  subtitle: { margin: 0, fontSize: '1em', fontWeight: 600 },
  copy: { margin: 0, color: colors.secondaryLabel, overflowWrap: 'anywhere' },
});

const accessStates: E2eeAccessState[] = [
  'pendingApproval',
  'waitingKey',
  'incomplete',
  'offline',
  'revoked',
  'verificationFailed',
];
const recoveryStates: E2eeRecoveryState[] = ['notSet', 'importing', 'partial', 'failed'];

// Only this story owns simulated transitions. No timers, files or service calls.
function RetryExample({ recovery = false }: { recovery?: boolean }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const action = {
    pending,
    onAction: () => {
      setPending(true);
      setFailed(false);
    },
  };
  return (
    <div {...stylex.props(styles.block)}>
      {recovery ? (
        <E2eeRecoveryStatus state="failed" workspaces={[]} {...action} />
      ) : (
        <E2eeAccessStatus
          state="verificationFailed"
          scope={{ kind: 'document', name: t('e2ee.preview.document') }}
          {...action}
        />
      )}
      <div>
        <Button
          variant="ghost"
          size="large"
          aria-disabled={!pending}
          onClick={() => {
            if (pending) {
              setPending(false);
              setFailed(true);
            }
          }}
        >
          {t('e2ee.preview.finish')}
        </Button>
      </div>
      <p role="status" {...stylex.props(styles.copy)}>
        {failed ? t('e2ee.preview.result') : ''}
      </p>
    </div>
  );
}

function Gallery() {
  const { t } = useTranslation();
  const workspaces: E2eeRecoveryWorkspace[] = [
    { id: 'a', name: t('e2ee.preview.workspaceA'), state: 'verified', verifiedKeyUpdate: 3 },
    { id: 'b', name: t('e2ee.preview.workspaceB'), state: 'saved' },
    { id: 'c', name: t('e2ee.preview.workspaceC'), state: 'waitingKey' },
  ];
  return (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>{t('e2ee.preview.title')}</h1>
      <p {...stylex.props(styles.copy)}>{t('e2ee.preview.notice')}</p>
      <h2 {...stylex.props(styles.subtitle)}>{t('e2ee.preview.access')}</h2>
      <div {...stylex.props(styles.grid)}>
        {accessStates.map((state) => (
          <E2eeAccessStatus
            key={state}
            state={state}
            scope={{ kind: 'document', name: t('e2ee.preview.document') }}
          />
        ))}
      </div>
      <p {...stylex.props(styles.copy)}>{t('e2ee.preview.policy')}</p>
      <E2eeAccessStatus
        state="verificationFailed"
        scope={{ kind: 'workspace', name: t('e2ee.preview.workspaceA') }}
      />
      <h2 {...stylex.props(styles.subtitle)}>{t('e2ee.preview.recovery')}</h2>
      <div {...stylex.props(styles.grid)}>
        {recoveryStates.map((state) => (
          <E2eeRecoveryStatus
            key={state}
            state={state}
            workspaces={
              state === 'partial'
                ? workspaces
                : [
                    {
                      id: 'a',
                      name: t('e2ee.preview.workspaceA'),
                      state: state === 'failed' ? 'failed' : 'notSet',
                    },
                  ]
            }
          />
        ))}
      </div>
      <div {...stylex.props(styles.grid)}>
        <RetryExample />
        <RetryExample recovery />
      </div>
    </main>
  );
}

const meta = {
  title: 'E2EE/Status',
  component: Gallery,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllStates: Story = {};
export const RecoveryChanges: Story = { render: () => <RecoveryChangesExample /> };

function RecoveryChangesExample() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [committedStep, setCommittedStep] = useState(0);
  // A visible acknowledgement after the child has processed this props update;
  // browser tests can observe completion without arbitrary waits.
  useEffect(() => setCommittedStep(step), [step]);
  const workspaces: E2eeRecoveryWorkspace[] = [
    { id: 'a', name: t('e2ee.preview.workspaceA'), state: step >= 1 ? 'failed' : 'waitingKey' },
    { id: 'b', name: t('e2ee.preview.workspaceA'), state: step >= 2 ? 'failed' : 'waitingKey' },
    {
      id: 'c',
      name: t('e2ee.preview.workspaceC'),
      state: 'verified',
      verifiedKeyUpdate: step >= 5 ? 4 : 3,
    },
  ];
  if (step >= 3) workspaces.reverse();
  return (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>
        <PreviewNotice />
      </h1>
      <E2eeRecoveryStatus state="partial" pending={false} workspaces={workspaces} />
      <div>
        <Button variant="secondary" onClick={() => setStep((current) => current + 1)}>
          {t('e2ee.preview.applyUpdate')}
        </Button>
      </div>
      <p data-committed-step={committedStep} {...stylex.props(styles.copy)}>
        {t('e2ee.preview.updateStep', { step: committedStep })}
      </p>
    </main>
  );
}

export const RecoveryRetry: Story = {
  render: () => (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>
        <PreviewNotice />
      </h1>
      <RetryExample recovery />
    </main>
  ),
};
export const Retry: Story = {
  render: () => (
    <main {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.title)}>
        <PreviewNotice />
      </h1>
      <RetryExample />
    </main>
  ),
};
function PreviewNotice() {
  const { t } = useTranslation();
  return t('e2ee.preview.notice');
}
