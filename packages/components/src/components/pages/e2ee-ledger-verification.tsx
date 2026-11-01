import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Dialog } from '@lody/ui/dialog';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text as type } from '@lody/ui/tokens/scales.stylex';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, ScanLine } from 'lucide-react';
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
  version: { color: colors.tertiaryLabel },
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
  footnote: { color: colors.tertiaryLabel, fontSize: type.footnoteSize },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: space[3] },
  video: {
    width: '100%',
    aspectRatio: '1',
    objectFit: 'cover',
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 80,
    padding: space[3],
    borderRadius: radius.medium,
    borderWidth: 0,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    color: colors.label,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: type.footnoteSize,
    resize: 'vertical',
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

function ResultAlert(props: { result: VerificationResult | 'unreadable' }) {
  const { t } = useTranslation();
  if (props.result === 'unreadable')
    return (
      <Alert.Root tone="warning">
        <Alert.Title>{t('e2ee.verify.result.unreadableTitle')}</Alert.Title>
        <Alert.Description>{t('e2ee.verify.result.unreadable')}</Alert.Description>
      </Alert.Root>
    );
  const result = props.result;
  const version = 'version' in result ? result.version : undefined;
  const title: Record<VerificationResult['kind'], string> = {
    match: t('e2ee.verify.result.matchTitle'),
    'theirs-older': t('e2ee.verify.result.theirsOlderTitle'),
    'theirs-newer': t('e2ee.verify.result.theirsNewerTitle'),
    unknown: t('e2ee.verify.result.unknownTitle'),
    mismatch: t('e2ee.verify.result.mismatchTitle'),
  };
  const body: Record<VerificationResult['kind'], string> = {
    match: t('e2ee.verify.result.match', { version }),
    'theirs-older':
      result.kind === 'theirs-older' && !result.prefixConfirmed
        ? t('e2ee.verify.result.theirsOlderUnconfirmed', { version })
        : t('e2ee.verify.result.theirsOlder', { version }),
    'theirs-newer': t('e2ee.verify.result.theirsNewer', { version }),
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
 * busy camera reports `unavailable`; callers keep a paste fallback. */
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
        // Denied, absent or busy: the pasted code still works.
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
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [result, setResult] = useState<VerificationResult | 'unreadable' | null>(null);
  const [camera, setCamera] = useState(false);
  const cameraSupported =
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const check = (value: string) => {
    const scanned = parseVerificationCode(value);
    setResult(scanned ? compareVerificationCode(props.history, scanned) : 'unreadable');
  };
  const { video, state } = useQrCamera(props.open && camera, (code) => {
    // The verdict is what matters; the raw payload is not worth showing.
    setCamera(false);
    setText('');
    check(code);
  });
  useEffect(() => {
    if (props.open) return;
    setText('');
    setResult(null);
    setCamera(false);
  }, [props.open]);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content width={440} closeButton>
        <Dialog.Header>
          <Dialog.Title>{t('e2ee.verify.dialogTitle')}</Dialog.Title>
          <Dialog.Description>{t('e2ee.verify.dialogDescription')}</Dialog.Description>
        </Dialog.Header>
        <div {...stylex.props(styles.dialogBody)}>
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
          <textarea
            aria-label={t('e2ee.verify.pasteLabel')}
            placeholder={t('e2ee.verify.pastePlaceholder')}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(null);
            }}
            {...stylex.props(styles.textarea)}
          />
          {result !== null && <ResultAlert result={result} />}
        </div>
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>{t('common.close')}</Dialog.Close>
          <Button disabled={text.trim() === ''} onClick={() => check(text)}>
            {t('e2ee.verify.compare')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The ledger's verification code: what members compare out of band. */
export function LedgerVerificationCard(props: { history: VerifiedLedgerHistory }) {
  const { t } = useTranslation();
  const code = useMemo(() => ledgerVerificationCode(props.history), [props.history]);
  const groups = groupHash(code.stateDigest);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        `${t('e2ee.verify.copyHeader', { version: code.version })}\n${groups.join(' ')}`
      );
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
            <span {...stylex.props(styles.version)}>
              {t('e2ee.verify.versionShort', { version: code.version })}
            </span>
          </div>
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
      <VerifyDialog open={verifying} onOpenChange={setVerifying} history={props.history} />
    </Card.Root>
  );
}
