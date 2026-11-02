import { useEffect, useState } from 'react';
import { SessionShareManager } from '@/components/sharing/session-share-manager';
import type { SessionShareEditorContext } from '@/components/session-sharing';

const entry = {
  shareId: 'story-share',
  rootSessionId: 'main',
  publisherUserId: 'publisher',
  title: 'Designing static sharing',
  status: 'active' as const,
  revision: 1,
  credentialVersion: 1,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_000_000,
  sourceIds: [{ sourceId: 'main', conversationId: 'c1' }],
  selectedSourceIds: ['main'],
  canManage: true,
  canRevoke: true,
};
/** Obviously synthetic: never screenshot a real bearer credential. */
const storyLink = `https://lody.ai/s/demo-share#access=v1.${'demo'.repeat(16)}`;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The real manager inside the access panel, with a publication that only mocks
 * its data: freeze, upload with a byte total, commit, then the link. Everything
 * you see move is the component's own.
 */
export function ShareEditorStory({ onClose, onBusyChange }: SessionShareEditorContext) {
  const [phase, setPhase] = useState<'idle' | 'capturing' | 'uploading' | 'publishing'>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ url: string; copied: boolean } | null>(null);
  const [selected, setSelected] = useState(['main']);
  const working = phase !== 'idle';

  useEffect(() => {
    onBusyChange(working);
  }, [onBusyChange, working]);

  const publish = async () => {
    setPhase('capturing');
    await wait(900);
    setPhase('uploading');
    for (const next of [18, 41, 67, 90, 100]) {
      setProgress(next);
      await wait(350);
    }
    setPhase('publishing');
    await wait(700);
    setPhase('idle');
    setResult({ url: storyLink, copied: true });
  };

  return (
    <SessionShareManager
      embedded
      sessionId="main"
      entry={result ? entry : null}
      selected={selected}
      candidates={[
        { sessionId: 'main', title: 'Designing static sharing' },
        { sessionId: 'child', title: 'Deployment design' },
      ]}
      plaintextConfirmation={false}
      onConfirmPlaintextPublish={publish}
      onCancelPlaintextPublish={() => {}}
      hasPending={false}
      conflict={false}
      progress={progress}
      phase={phase}
      result={result}
      shareLink={result?.url ?? null}
      canCapture
      busy={working}
      error={null}
      notice={null}
      hasSecret={!!result}
      onSelect={setSelected}
      onPublish={publish}
      onDiscard={() => {}}
      onCopy={async () => {}}
      onReset={async () => {}}
      onRevoke={async () => {
        setResult(null);
      }}
      onClose={onClose}
    />
  );
}
