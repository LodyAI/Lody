import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Info, ScanLine, ShieldAlert, ShieldCheck } from 'lucide-react';
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
    display: 'grid',
    gridTemplateColumns: {
      default: 'auto minmax(0, 1fr)',
      '@media (max-width: 640px)': 'minmax(0, 1fr)',
    },
    columnGap: space[6],
    rowGap: space[4],
    padding: space[6],
    borderRadius: radius.large,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.raised,
  },
  codeColumn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: space[3],
  },
  qrTile: {
    padding: space[3],
    borderRadius: radius.medium,
    // Scanners need dark modules on light ground in either theme.
    backgroundColor: '#ffffff',
    boxShadow: shadow.inset,
    lineHeight: 0,
  },
  hash: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, auto)',
    columnGap: space[3],
    rowGap: space[1],
    fontFamily: 'monospace',
    fontSize: '0.95em',
    letterSpacing: '0.04em',
    userSelect: 'text',
  },
  details: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  verdict: { display: 'flex', alignItems: 'center', gap: space[2], fontWeight: 600 },
  verified: { color: colors.success },
  caution: { color: colors.warning },
  version: { display: 'flex', alignItems: 'baseline', gap: space[2], flexWrap: 'wrap' },
  versionNumber: { fontSize: '1.75em', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  muted: { color: colors.secondaryLabel, lineHeight: 1.6 },
  footnote: { color: colors.tertiaryLabel, fontSize: '0.85em', lineHeight: 1.6 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2], marginTop: 'auto' },
  hint: {
    gridColumn: '1 / -1',
    display: 'flex',
    gap: space[3],
    padding: space[4],
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
    color: colors.secondaryLabel,
    fontSize: '0.9em',
    lineHeight: 1.7,
  },
  hintIcon: { flexShrink: 0, marginTop: 3 },
  hintBody: { display: 'flex', flexDirection: 'column', gap: space[2] },
  hintTitle: { color: colors.label, fontWeight: 600 },
  dialogBody: { display: 'flex', flexDirection: 'column', gap: space[4] },
  video: {
    width: '100%',
    aspectRatio: '1',
    objectFit: 'cover',
    borderRadius: radius.medium,
    backgroundColor: colors.wellBackground,
  },
  textarea: {
    width: '100%',
    minHeight: 88,
    padding: space[3],
    borderRadius: radius.medium,
    borderWidth: 0,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    color: colors.label,
    fontFamily: 'monospace',
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

type CameraState = 'idle' | 'starting' | 'scanning' | 'unavailable';

/** Reads QR frames until one decodes, then releases the camera. */
function useQrCamera(active: boolean, onCode: (text: string) => void) {
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
    setCamera(false);
    setText(code);
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

/** The ledger's current version and its safety-number style verification code. */
export function LedgerVerificationCard(props: {
  history: VerifiedLedgerHistory;
  stats: string;
  actions: ReactNode;
}) {
  const { t } = useTranslation();
  const { history } = props;
  const code = useMemo(() => ledgerVerificationCode(history), [history]);
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
    <section aria-label={t('e2ee.verify.title')} {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.codeColumn)}>
        <div {...stylex.props(styles.qrTile)}>
          <LedgerQrCode payload={code.payload} size={176} label={t('e2ee.verify.qrLabel')} />
        </div>
        <div aria-label={t('e2ee.verify.codeLabel')} {...stylex.props(styles.hash)}>
          {groups.map((group, index) => (
            <span key={index}>{group}</span>
          ))}
        </div>
      </div>
      <div {...stylex.props(styles.details)}>
        <div
          {...stylex.props(
            styles.verdict,
            history.locallyPinned ? styles.verified : styles.caution
          )}
        >
          {history.locallyPinned ? (
            <ShieldCheck size={18} aria-hidden="true" />
          ) : (
            <ShieldAlert size={18} aria-hidden="true" />
          )}
          {history.locallyPinned
            ? t('e2ee.control.status.verified')
            : t('e2ee.control.status.unpinned')}
        </div>
        <p {...stylex.props(styles.muted)}>
          {history.locallyPinned
            ? t('e2ee.control.verifiedPinned')
            : t('e2ee.control.verifiedUnpinned')}
        </p>
        <div {...stylex.props(styles.version)}>
          <span {...stylex.props(styles.muted)}>{t('e2ee.verify.version')}</span>
          <span {...stylex.props(styles.versionNumber)}>{code.version}</span>
          <span {...stylex.props(styles.muted)}>{props.stats}</span>
        </div>
        <p {...stylex.props(styles.footnote)}>{t('e2ee.control.freshness')}</p>
        <div {...stylex.props(styles.actions)}>
          <Button onClick={() => setVerifying(true)}>
            <ScanLine size={16} aria-hidden="true" />
            {t('e2ee.verify.scan')}
          </Button>
          <Button variant="secondary" onClick={() => void copy()}>
            <Copy size={16} aria-hidden="true" />
            {copied ? t('e2ee.verify.copied') : t('e2ee.verify.copy')}
          </Button>
          {props.actions}
        </div>
      </div>
      <div {...stylex.props(styles.hint)}>
        <Info size={16} aria-hidden="true" {...stylex.props(styles.hintIcon)} />
        <div {...stylex.props(styles.hintBody)}>
          <span {...stylex.props(styles.hintTitle)}>{t('e2ee.verify.hintTitle')}</span>
          <span>{t('e2ee.verify.hint')}</span>
          <span>{t('e2ee.verify.hintCaveat')}</span>
        </div>
      </div>
      <VerifyDialog open={verifying} onOpenChange={setVerifying} history={history} />
    </section>
  );
}
