import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Dialog } from '@lody/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openExternalUrl } from '@/lib/native-browser';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ScanLine, X } from 'lucide-react';
import type { VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import {
  compareVerificationCode,
  groupHash,
  ledgerVerificationCode,
  parseVerificationCode,
  type VerificationResult,
} from '@/lib/e2ee-ledger-verification';

const styles = stylex.create({
  card: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[6],
    flexDirection: { default: 'row', '@media (max-width: 520px)': 'column-reverse' },
  },
  qrTile: {
    flexShrink: 0,
    padding: space[2],
    borderRadius: radius.medium,
    // Scanners need dark modules on light ground in either theme.
    backgroundColor: '#ffffff',
    lineHeight: 0,
  },
  body: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  label: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    fontSize: type.footnoteSize,
    lineHeight: type.footnoteLeading,
    color: colors.secondaryLabel,
  },
  code: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, max-content)',
    columnGap: '0.9em',
    rowGap: space[1],
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: type.headlineSize,
    lineHeight: type.bodyLeading,
    letterSpacing: '0.02em',
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
    userSelect: 'all',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2] },
  lead: { margin: 0, color: colors.secondaryLabel, fontSize: type.footnoteSize, maxWidth: 420 },
  learnMore: {
    padding: 0,
    borderWidth: 0,
    background: 'none',
    font: 'inherit',
    color: colors.accent,
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  footnote: { color: colors.tertiaryLabel, fontSize: type.footnoteSize },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: space[4] },
  sides: {
    display: 'grid',
    gridTemplateColumns: { default: '1fr 1fr', '@media (max-width: 640px)': '1fr' },
    gap: space[3],
  },
  side: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    padding: space[4],
    borderRadius: radius.large,
    backgroundColor: colors.secondaryBackground,
    minWidth: 0,
  },
  sideTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    margin: 0,
    fontSize: type.bodySize,
    fontWeight: 600,
    color: colors.label,
  },
  step: {
    display: 'inline-grid',
    placeItems: 'center',
    width: '1.5em',
    height: '1.5em',
    borderRadius: '50%',
    backgroundColor: colors.label,
    color: colors.background,
    fontSize: type.footnoteSize,
    fontWeight: 600,
  },
  mine: { display: 'flex', alignItems: 'center', gap: space[4], flexWrap: 'wrap' },
  mineCode: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, max-content)',
    columnGap: '0.7em',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: type.subheadlineSize,
    lineHeight: type.bodyLeading,
    fontVariantNumeric: 'tabular-nums',
    color: colors.label,
  },
  manual: { display: 'flex', flexDirection: 'column', gap: space[2] },
  hint: { margin: 0, color: colors.secondaryLabel, fontSize: type.subheadlineSize },
  video: {
    width: '100%',
    aspectRatio: '1',
    objectFit: 'cover',
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
  },
});

/** QR modules drawn as one SVG path: no canvas, so it renders anywhere the page does. */
export function LedgerQrCode(props: { payload: string; size: number; label: string }) {
  const { path, count } = useMemo(() => {
    const { modules } = QRCode.create(props.payload, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row++)
      for (let column = 0; column < modules.size; column++)
        if (modules.get(row, column)) d += `M${column} ${row}h1v1h-1z`;
    return { path: d, count: modules.size };
  }, [props.payload]);
  return (
    <svg
      role="img"
      aria-label={props.label}
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000000" />
    </svg>
  );
}

const RESULT_TONE: Record<VerificationResult['kind'], 'success' | 'warning' | 'danger'> = {
  match: 'success',
  'theirs-older': 'warning',
  'theirs-newer': 'warning',
  unknown: 'warning',
  mismatch: 'danger',
};

/** A person reading both codes can only tell equal from different, not which side is older. */
type ManualVerdict = 'manual-same' | 'manual-differ';
type DialogResult = VerificationResult | 'unreadable' | ManualVerdict;

function ResultAlert(props: { result: DialogResult }) {
  const { t } = useTranslation();
  if (props.result === 'manual-same')
    return (
      <Alert.Root tone="success">
        <Alert.Title>{t('e2ee.verify.result.matchTitle')}</Alert.Title>
        <Alert.Description>{t('e2ee.verify.result.match')}</Alert.Description>
      </Alert.Root>
    );
  if (props.result === 'manual-differ')
    return (
      <Alert.Root tone="warning">
        <Alert.Title>{t('e2ee.verify.result.unknownTitle')}</Alert.Title>
        <Alert.Description>{t('e2ee.verify.result.unknown')}</Alert.Description>
      </Alert.Root>
    );
  if (props.result === 'unreadable')
    return (
      <Alert.Root tone="warning">
        <Alert.Title>{t('e2ee.verify.result.unreadableTitle')}</Alert.Title>
        <Alert.Description>{t('e2ee.verify.result.unreadable')}</Alert.Description>
      </Alert.Root>
    );
  const result = props.result;
  const title: Record<VerificationResult['kind'], string> = {
    match: t('e2ee.verify.result.matchTitle'),
    'theirs-older': t('e2ee.verify.result.theirsOlderTitle'),
    'theirs-newer': t('e2ee.verify.result.theirsNewerTitle'),
    unknown: t('e2ee.verify.result.unknownTitle'),
    mismatch: t('e2ee.verify.result.mismatchTitle'),
  };
  const body: Record<VerificationResult['kind'], string> = {
    match: t('e2ee.verify.result.match'),
    'theirs-older':
      result.kind === 'theirs-older' && !result.prefixConfirmed
        ? t('e2ee.verify.result.theirsOlderUnconfirmed')
        : t('e2ee.verify.result.theirsOlder'),
    'theirs-newer': t('e2ee.verify.result.theirsNewer'),
    unknown: t('e2ee.verify.result.unknown'),
    mismatch: t('e2ee.verify.result.mismatch'),
  };
  return (
    <Alert.Root tone={RESULT_TONE[result.kind]}>
      <Alert.Title>{title[result.kind]}</Alert.Title>
      <Alert.Description>{body[result.kind]}</Alert.Description>
    </Alert.Root>
  );
}

export type CameraState = 'idle' | 'starting' | 'scanning' | 'unavailable';

/** Reads QR frames until one decodes, then releases the camera. A denied, absent or
 * busy camera reports `unavailable`; callers keep a manual fallback. */
export function useQrCamera(active: boolean, onCode: (text: string) => void) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>('idle');
  const latest = useRef(onCode);
  latest.current = onCode;
  useEffect(() => {
    if (!active) {
      setState('idle');
      return undefined;
    }
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
    const tick = () => {
      if (stopped) return;
      const element = video.current;
      if (element && element.readyState >= element.HAVE_ENOUGH_DATA) {
        canvas.width = element.videoWidth;
        canvas.height = element.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(element, 0, 0);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: 'dontInvert',
          });
          if (code) {
            stop();
            setState('idle');
            latest.current(code.data);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    setState('starting');
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (media) => {
        stream = media;
        if (stopped || !video.current) return stop();
        video.current.srcObject = media;
        await video.current.play();
        setState('scanning');
        frame = requestAnimationFrame(tick);
      })
      .catch(() => {
        // Denied, absent or busy: reading the code by eye still works.
        if (!stopped) setState('unavailable');
      });
    return stop;
  }, [active]);
  return { video, state };
}

function VerifyDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: VerifiedLedgerHistory;
  code: ReturnType<typeof ledgerVerificationCode>;
  groups: string[];
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<DialogResult | null>(null);
  const [camera, setCamera] = useState(false);
  const cameraSupported =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const { video, state } = useQrCamera(props.open && camera, (scannedText) => {
    // The verdict is what matters; the raw payload is not worth showing.
    setCamera(false);
    const scanned = parseVerificationCode(scannedText);
    setResult(scanned ? compareVerificationCode(props.history, scanned) : 'unreadable');
  });
  useEffect(() => {
    if (props.open) return;
    setResult(null);
    setCamera(false);
  }, [props.open]);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content width={720} closeButton>
        <Dialog.Header>
          <Dialog.Title>{t('e2ee.verify.dialogTitle')}</Dialog.Title>
          <Dialog.Description>{t('e2ee.verify.dialogDescription')}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.dialogBody)}>
          <div {...stylex.props(styles.sides)}>
            <section {...stylex.props(styles.side)}>
              <h3 {...stylex.props(styles.sideTitle)}>
                <span aria-hidden="true" {...stylex.props(styles.step)}>
                  1
                </span>
                {t('e2ee.verify.showMine')}
              </h3>
              <div {...stylex.props(styles.mine)}>
                <div {...stylex.props(styles.qrTile)}>
                  <LedgerQrCode
                    payload={props.code.payload}
                    size={112}
                    label={t('e2ee.verify.qrLabel')}
                  />
                </div>
                <div aria-label={t('e2ee.verify.codeLabel')} {...stylex.props(styles.mineCode)}>
                  {props.groups.map((group, index) => (
                    <span key={index}>{group}</span>
                  ))}
                </div>
              </div>
            </section>
            <section {...stylex.props(styles.side)}>
              <h3 {...stylex.props(styles.sideTitle)}>
                <span aria-hidden="true" {...stylex.props(styles.step)}>
                  2
                </span>
                {t('e2ee.verify.scanTheirs')}
              </h3>
              {cameraSupported &&
                (camera ? (
                  <video ref={video} muted playsInline {...stylex.props(styles.video)} />
                ) : (
                  <Button variant="secondary" onClick={() => setCamera(true)}>
                    <ScanLine size={16} aria-hidden="true" />
                    {t('e2ee.verify.startCamera')}
                  </Button>
                ))}
              {state === 'unavailable' && (
                <p {...stylex.props(styles.footnote)}>{t('e2ee.verify.cameraUnavailable')}</p>
              )}
              <div {...stylex.props(styles.manual)}>
                <p {...stylex.props(styles.hint)}>{t('e2ee.verify.manualHint')}</p>
                <div {...stylex.props(styles.actions)}>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                      setCamera(false);
                      setResult('manual-same');
                    }}
                  >
                    <Check size={14} aria-hidden="true" />
                    {t('e2ee.verify.manualSame')}
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => {
                      setCamera(false);
                      setResult('manual-differ');
                    }}
                  >
                    <X size={14} aria-hidden="true" />
                    {t('e2ee.verify.manualDiffer')}
                  </Button>
                </div>
              </div>
            </section>
          </div>
          {result !== null && <ResultAlert result={result} />}
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>{t('common.close')}</Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Public docs section that explains how the security code works. */
export function securityCodeDocsUrl(language: string | undefined): string {
  const path = language?.toLowerCase().startsWith('zh')
    ? '/zh/docs/encrypted-workspaces-security-code'
    : '/docs/encrypted-workspaces-security-code';
  return `https://lody.ai${path}`;
}

/** The ledger's verification code: what members compare out of band. */
export function LedgerVerificationCard(props: { history: VerifiedLedgerHistory }) {
  const { t, i18n } = useTranslation();
  const code = useMemo(() => ledgerVerificationCode(props.history), [props.history]);
  const groups = groupHash(code.stateDigest);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${t('e2ee.verify.copyHeader')}\n${groups.join(' ')}`);
      setCopied(true);
    } catch {
      // Denied clipboard: the code stays selectable on screen.
    }
  };
  return (
    <Card.Root>
      <section aria-label={t('e2ee.verify.title')} {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.label)}>
            <span>{t('e2ee.verify.codeTitle')}</span>
          </div>
          <p {...stylex.props(styles.lead)}>
            {t('e2ee.verify.lead')}{' '}
            <button
              type="button"
              onClick={() => void openExternalUrl(securityCodeDocsUrl(i18n?.language))}
              {...stylex.props(styles.learnMore)}
            >
              {t('e2ee.verify.learnMore')}
            </button>
          </p>
          <div aria-label={t('e2ee.verify.codeLabel')} {...stylex.props(styles.code)}>
            {groups.map((group, index) => (
              <span key={index}>{group}</span>
            ))}
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button size="small" variant="secondary" onClick={() => setVerifying(true)}>
              <ScanLine size={14} aria-hidden="true" />
              {t('e2ee.verify.scan')}
            </Button>
            <Button size="small" variant="ghost" onClick={() => void copy()}>
              <Copy size={14} aria-hidden="true" />
              {copied ? t('e2ee.verify.copied') : t('e2ee.verify.copy')}
            </Button>
          </div>
        </div>
        <div {...stylex.props(styles.qrTile)}>
          <LedgerQrCode payload={code.payload} size={128} label={t('e2ee.verify.qrLabel')} />
        </div>
      </section>
      <VerifyDialog
        open={verifying}
        onOpenChange={setVerifying}
        history={props.history}
        code={code}
        groups={groups}
      />
    </Card.Root>
  );
}
