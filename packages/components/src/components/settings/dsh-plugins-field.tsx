import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import {
  DshPluginPackageSpecSchema,
  type DshPlugin,
  type DshPluginsRequest,
  type DshPluginsResponse,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { CollapsibleSection, FormMessage } from './form-primitives';

const styles = stylex.create({
  body: { display: 'flex', flexDirection: 'column', gap: space[3] },
  row: { display: 'flex', alignItems: 'center', gap: space[2], flexWrap: 'wrap' },
  item: { paddingBlock: space[2], borderBottom: `1px solid ${colors.separator}` },
  label: { flexGrow: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: '12px' },
  hint: { color: colors.secondaryLabel, fontSize: '12px', margin: 0 },
  input: { flexGrow: 1, minWidth: '140px' },
});

export function DshPluginsField({
  configId,
  onRequest,
  supported,
  available = true,
  allowMutations = false,
}: {
  configId: string;
  onRequest?: (request: DshPluginsRequest) => Promise<DshPluginsResponse>;
  supported: boolean;
  available?: boolean;
  allowMutations?: boolean;
}) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<DshPlugin[]>();
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const enabled = supported && available && !!onRequest;
  const run = async (request: DshPluginsRequest) => {
    if (!enabled || pending.current || !onRequest) return;
    if (request.action !== 'list' && !allowMutations) return;
    if (
      request.action === 'install' &&
      !DshPluginPackageSpecSchema.safeParse(request.package).success
    ) {
      setError(t('dshPlugins.invalidPackage'));
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await onRequest(request);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setPlugins(result.plugins);
      if (request.action !== 'list') setChanged(true);
      if (request.action === 'install') setSpec('');
    } catch {
      setError(t('dshPlugins.failed'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <CollapsibleSection title={t('dshPlugins.title')} defaultOpen={false}>
      <div {...stylex.props(styles.body)} aria-busy={busy}>
        <p {...stylex.props(styles.hint)}>{t('dshPlugins.hint')}</p>
        {!supported && <FormMessage tone="warning">{t('dshPlugins.unsupported')}</FormMessage>}
        {supported && !available && (
          <FormMessage tone="warning">{t('dshPlugins.offline')}</FormMessage>
        )}
        {supported && !allowMutations && (
          <FormMessage tone="warning">{t('dshPlugins.localOnly')}</FormMessage>
        )}
        <div {...stylex.props(styles.row)}>
          <div {...stylex.props(styles.input)}>
            <Input
              aria-label={t('dshPlugins.package')}
              placeholder={t('dshPlugins.placeholder')}
              value={spec}
              disabled={!enabled || !allowMutations || busy}
              onChange={(event) => setSpec(event.target.value)}
            />
          </div>
          <Button
            size="small"
            disabled={!enabled || !allowMutations || busy || !spec.trim()}
            onClick={() => void run({ configId, action: 'install', package: spec.trim() })}
          >
            {t('dshPlugins.install')}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={!enabled || busy}
            onClick={() => void run({ configId, action: 'list' })}
          >
            {t('dshPlugins.refresh')}
          </Button>
        </div>
        {busy && (
          <p role="status" {...stylex.props(styles.hint)}>
            {t('dshPlugins.busy')}
          </p>
        )}
        {plugins?.length === 0 && <p {...stylex.props(styles.hint)}>{t('dshPlugins.empty')}</p>}
        {plugins?.map((plugin) => (
          <div key={plugin.name} {...stylex.props(styles.row, styles.item)}>
            <div {...stylex.props(styles.label)}>
              {plugin.name} <span {...stylex.props(styles.hint)}>{plugin.version}</span>
              {!plugin.active && <p {...stylex.props(styles.hint)}>{t('dshPlugins.notActive')}</p>}
            </div>
            <Button
              size="small"
              variant="ghost"
              disabled={!enabled || !allowMutations || busy}
              onClick={() => void run({ configId, action: 'remove', package: plugin.name })}
            >
              {t('dshPlugins.remove')}
            </Button>
          </div>
        ))}
        {changed && (
          <p role="status" {...stylex.props(styles.hint)}>
            {t('dshPlugins.reconnect')}
          </p>
        )}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>
    </CollapsibleSection>
  );
}
