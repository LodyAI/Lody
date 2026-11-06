import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, MessageCircle, RefreshCw, Share2, X } from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale } from './types';
const previewStyles = stylex.create({
  row: {
    display: 'flex',
    'min-width': '0px',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 0.5)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'hsl(var(--background))',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-top': 'calc(0.375rem + var(--safe-area-top))',
    'padding-bottom': 'calc(var(--spacing) * 1.5)',
  },
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
  section: {
    'min-width': '0px',
    flex: '1',
    'padding-inline': 'var(--spacing)',
  },
  row2: {
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    'min-width': '0px',
    'align-items': 'center',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--input-border))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    ':focus-within': {
      'border-color': 'hsl(var(--ring))',
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 0 calc(1px + 0px) hsl(var(--ring)), 0 0 #0000',
    },
  },
  text: {
    height: '100%',
    'min-width': '0px',
    flex: '1',
    'background-color': 'transparent',
    'padding-inline': 'calc(var(--spacing) * 2.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--foreground))',
    'outline-style': 'none',
    '::placeholder': {
      color: 'hsl(var(--muted-foreground))',
    },
  },
});

const buttonStyles = stylex.create({
  control: { height: 'calc(var(--spacing) * 8)', width: 'calc(var(--spacing) * 8)', flexShrink: 0 },
  pressed: { backgroundColor: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' },
});

/* Display-only replica of `sessions/session-browser-toolbar.tsx` for the design
   demo: no history (back/forward disabled), annotation available, sharing
   available but idle. Tooltips are dropped; the frame is inert. */

const LABELS = {
  en: {
    back: 'Back',
    forward: 'Forward',
    stop: 'Stop loading',
    reload: 'Reload',
    address: 'Address',
    addressPlaceholder: 'Enter a URL',
    share: 'Share preview',
  },
  zh: {
    back: '后退',
    forward: '前进',
    stop: '停止加载',
    reload: '重新加载',
    address: '地址',
    addressPlaceholder: '输入 URL',
    share: '分享预览',
  },
} satisfies Record<ReplicaLocale, Record<string, string>>;

/* The ghost cursor finds the annotate toggle by `button[aria-label="Annotate
   page"]` in every locale, so these two labels stay English (as the current
   landing renders them, whose i18n instance has no browser keys). */
const ANNOTATE_ENABLE_LABEL = 'Annotate page';
const ANNOTATE_DISABLE_LABEL = 'Exit annotation mode';

function ToolbarButton({
  label,
  disabled,
  pressed,
  xstyle,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  xstyle?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      xstyle={[buttonStyles.control, xstyle]}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

export function ReplicaBrowserToolbar({
  address,
  loading,
  annotating,
  locale = 'en',
}: {
  address: string;
  loading: boolean;
  annotating: boolean;
  locale?: ReplicaLocale;
}) {
  const labels = LABELS[locale];
  return (
    <div {...stylex.props(previewStyles.row)}>
      <ToolbarButton label={labels.back} disabled>
        <ArrowLeft {...stylex.props(previewStyles.frame)} />
      </ToolbarButton>
      <ToolbarButton label={labels.forward} disabled>
        <ArrowRight {...stylex.props(previewStyles.frame)} />
      </ToolbarButton>
      <ToolbarButton label={loading ? labels.stop : labels.reload}>
        {loading ? (
          <X {...stylex.props(previewStyles.frame)} />
        ) : (
          <RefreshCw {...stylex.props(previewStyles.frame)} />
        )}
      </ToolbarButton>

      <div {...stylex.props(previewStyles.section)}>
        <div {...stylex.props(previewStyles.row2)}>
          <input
            type="text"
            inputMode="url"
            value={address}
            readOnly
            placeholder={labels.addressPlaceholder}
            aria-label={labels.address}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            {...stylex.props(previewStyles.text)}
          />
        </div>
      </div>

      <ToolbarButton
        label={annotating ? ANNOTATE_DISABLE_LABEL : ANNOTATE_ENABLE_LABEL}
        xstyle={annotating ? buttonStyles.pressed : undefined}
        pressed={annotating}
      >
        <MessageCircle {...stylex.props(previewStyles.frame)} />
      </ToolbarButton>
      <ToolbarButton label={labels.share}>
        <Share2 {...stylex.props(previewStyles.frame)} />
      </ToolbarButton>
    </div>
  );
}
