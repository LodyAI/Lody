import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, MessageCircle, RefreshCw, Share2, X } from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale } from './types';
import { cn } from './utils';

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
  'zh-hant': {
    back: '上一頁',
    forward: '下一頁',
    stop: '停止載入',
    reload: '重新載入',
    address: '網址',
    addressPlaceholder: '輸入網址',
    share: '分享預覽',
  },
  ja: {
    back: '戻る',
    forward: '進む',
    stop: '読み込みを停止',
    reload: '再読み込み',
    address: 'アドレス',
    addressPlaceholder: 'URL を入力',
    share: 'プレビューを共有',
  },
  ko: {
    back: '뒤로',
    forward: '앞으로',
    stop: '로딩 중지',
    reload: '새로고침',
    address: '주소',
    addressPlaceholder: 'URL 입력',
    share: '미리보기 공유',
  },
  es: {
    back: 'Atrás',
    forward: 'Adelante',
    stop: 'Detener carga',
    reload: 'Recargar',
    address: 'Dirección',
    addressPlaceholder: 'Introduce una URL',
    share: 'Compartir vista previa',
  },
  fr: {
    back: 'Précédent',
    forward: 'Suivant',
    stop: 'Arrêter le chargement',
    reload: 'Actualiser',
    address: 'Adresse',
    addressPlaceholder: 'Saisir une URL',
    share: "Partager l'aperçu",
  },
  ru: {
    back: 'Назад',
    forward: 'Вперёд',
    stop: 'Остановить загрузку',
    reload: 'Обновить',
    address: 'Адрес',
    addressPlaceholder: 'Введите URL',
    share: 'Поделиться предпросмотром',
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
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('h-8 w-8 shrink-0', className)}
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
    <div className="flex min-w-0 items-center gap-0.5 border-b border-border bg-background px-1.5 pb-1.5 pt-[calc(0.375rem+var(--safe-area-top))]">
      <ToolbarButton label={labels.back} disabled>
        <ArrowLeft className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label={labels.forward} disabled>
        <ArrowRight className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label={loading ? labels.stop : labels.reload}>
        {loading ? <X className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
      </ToolbarButton>

      <div className="min-w-0 flex-1 px-1">
        <div className="flex h-8 min-w-0 items-center rounded-md border border-input-border bg-input-field transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
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
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <ToolbarButton
        label={annotating ? ANNOTATE_DISABLE_LABEL : ANNOTATE_ENABLE_LABEL}
        className={annotating ? 'bg-accent text-accent-foreground' : undefined}
        pressed={annotating}
      >
        <MessageCircle className="h-4 w-4" />
      </ToolbarButton>
      <ToolbarButton label={labels.share}>
        <Share2 className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}
