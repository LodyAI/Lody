import { Download, Laptop, MonitorDown, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SiteAnchor } from '@site/components/site-anchor';
import type { SiteLocale } from '@site/src/site-pages/shared';
import {
  parseNightlyRelease,
  parseNightlyAndroidRelease,
  type NightlyAndroidRelease,
  resolveNightlyDownloadBase,
  type NightlyRelease,
} from '../lib/nightly-downloads';

type NightlyDownloadsCopy = {
  switching: string;
  loading: string;
  unavailable: string;
  retry: string;
  noScript: string;
  desktopPrefix: string;
  minimumStable: (version: string) => string;
};

const copy: Record<SiteLocale, NightlyDownloadsCopy> = {
  en: {
    switching:
      'On desktop, quit Lody before opening Nightly, and quit Nightly before switching back. Changes synced to your account also appear in Stable.',
    loading: 'Checking Nightly downloads…',
    unavailable: 'Nightly downloads are not available right now.',
    retry: 'Try again',
    noScript: 'Enable JavaScript to load the latest Nightly download links.',
    desktopPrefix: 'Desktop: ',
    minimumStable: (version) =>
      `If desktop Stable is installed, update it to ${version} or later so the two apps can prevent concurrent use.`,
  },
  zh: {
    switching:
      '桌面端打开 Nightly 前请先退出 Lody，切回正式版前请先退出 Nightly。同步到账号的数据修改也会出现在正式版中。',
    loading: '正在获取 Nightly 下载…',
    unavailable: '当前暂无可用的 Nightly 下载。',
    retry: '重试',
    noScript: '请启用 JavaScript，以获取最新的 Nightly 下载链接。',
    desktopPrefix: '桌面端：',
    minimumStable: (version) =>
      `如已安装桌面正式版，请先更新到 ${version} 或更高版本，以支持两款应用互斥运行。`,
  },
  'zh-hant': {
    switching:
      '桌面端開啟 Nightly 前請先結束 Lody，切回正式版前也請先結束 Nightly。同步至帳號的資料變更也會顯示於正式版中。',
    loading: '正在檢查 Nightly 下載項目…',
    unavailable: '目前暫無可用的 Nightly 下載項目。',
    retry: '重試',
    noScript: '請啟用 JavaScript 以載入最新的 Nightly 下載連結。',
    desktopPrefix: '桌面端：',
    minimumStable: (version) =>
      `若已安裝桌面正式版，請先更新至 ${version} 或以上版本，讓兩個應用程式能避免同時執行。`,
  },
  ja: {
    switching:
      'デスクトップ版では、Nightly を起動する前に Lody を終了し、安定版に戻る前に Nightly を終了してください。アカウントに同期された変更は安定版にも反映されます。',
    loading: 'Nightly のダウンロードを確認中…',
    unavailable: '現在利用可能な Nightly のダウンロードはありません。',
    retry: '再試行',
    noScript: '最新の Nightly ダウンロードリンクを読み込むには JavaScript を有効にしてください。',
    desktopPrefix: 'デスクトップ: ',
    minimumStable: (version) =>
      `デスクトップ安定版がインストールされている場合は、同時起動を防ぐため ${version} 以降にアップデートしてください。`,
  },
  ko: {
    switching:
      '데스크톱에서는 Nightly를 열기 전에 Lody를 종료하고, 정식 버전으로 돌아가기 전에 Nightly를 종료하세요. 계정에 동기화된 변경 사항은 정식 버전에도 반영됩니다.',
    loading: 'Nightly 다운로드 확인 중…',
    unavailable: '현재 사용할 수 있는 Nightly 다운로드가 없습니다.',
    retry: '다시 시도',
    noScript: '최신 Nightly 다운로드 링크를 불러오려면 JavaScript를 활성화하세요.',
    desktopPrefix: '데스크톱: ',
    minimumStable: (version) =>
      `데스크톱 정식 버전이 설치되어 있다면 두 앱이 동시에 실행되지 않도록 ${version} 이상으로 업데이트해 주세요.`,
  },
  es: {
    switching:
      'En escritorio, cierra Lody antes de abrir Nightly y cierra Nightly antes de volver a Estable. Los cambios sincronizados con tu cuenta también aparecen en Estable.',
    loading: 'Comprobando descargas de Nightly…',
    unavailable: 'Las descargas de Nightly no están disponibles en este momento.',
    retry: 'Intentar de nuevo',
    noScript: 'Activa JavaScript para cargar los últimos enlaces de descarga de Nightly.',
    desktopPrefix: 'Escritorio: ',
    minimumStable: (version) =>
      `Si tienes instalada la versión Estable de escritorio, actualízala a ${version} o posterior para evitar que ambas aplicaciones se ejecuten a la vez.`,
  },
  fr: {
    switching:
      'Sur ordinateur, quittez Lody avant de lancer Nightly et quittez Nightly avant de revenir à la version Stable. Les modifications synchronisées sur votre compte apparaissent aussi dans Stable.',
    loading: 'Vérification des téléchargements Nightly…',
    unavailable: 'Les téléchargements Nightly ne sont pas disponibles pour le moment.',
    retry: 'Réessayer',
    noScript: 'Activez JavaScript pour charger les derniers liens de téléchargement Nightly.',
    desktopPrefix: 'Ordinateur : ',
    minimumStable: (version) =>
      `Si la version Stable est installée sur cet ordinateur, mettez-la à jour vers ${version} ou une version ultérieure afin d'empêcher l'exécution simultanée des deux applications.`,
  },
  ru: {
    switching:
      'На компьютере закройте Lody перед запуском Nightly и закройте Nightly перед возвратом к стабильной версии. Изменения, синхронизированные с учётной записью, также отображаются в стабильной версии.',
    loading: 'Проверка сборок Nightly…',
    unavailable: 'Сборки Nightly сейчас недоступны.',
    retry: 'Повторить',
    noScript: 'Включите JavaScript, чтобы загрузить актуальные ссылки для скачивания Nightly.',
    desktopPrefix: 'Компьютер: ',
    minimumStable: (version) =>
      `Если на компьютере установлена стабильная версия, обновите её до ${version} или выше, чтобы приложения не запускались одновременно.`,
  },
};

export function NightlyDownloads({ locale }: { locale: SiteLocale }) {
  return (
    <div id="nightly">
      <NightlyDownloadsForPlatform locale={locale} platform="desktop" />
      <NightlyDownloadsForPlatform locale={locale} platform="android" />
    </div>
  );
}

function NightlyDownloadsForPlatform({
  locale,
  platform,
}: {
  locale: SiteLocale;
  platform: 'desktop' | 'android';
}) {
  const t = copy[locale];
  const base = resolveNightlyDownloadBase(import.meta.env.VITE_NIGHTLY_UPDATE_URL);
  const [release, setRelease] = useState<NightlyRelease | NightlyAndroidRelease | null>(null);
  const [loading, setLoading] = useState(base !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (base === null) return undefined;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setLoading(true);
    setRelease(null);
    void (async () => {
      try {
        const response = await fetch(
          `${base}/${platform === 'android' ? 'android-version.json' : 'version.json'}`,
          {
            signal: controller.signal,
            cache: 'no-store',
          }
        );
        if (!response.ok) throw new Error('Nightly metadata unavailable');
        const text = await response.text();
        if (text.length > 1024 * 1024) throw new Error('Nightly metadata too large');
        const parsed =
          platform === 'android'
            ? parseNightlyAndroidRelease(JSON.parse(text), base)
            : parseNightlyRelease(JSON.parse(text), base);
        if (!disposed) setRelease(parsed);
      } catch {
        if (!disposed) setRelease(null);
      } finally {
        clearTimeout(timeout);
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [base, attempt, platform]);

  return (
    <div className="download-group download-nightly">
      {platform === 'desktop' && <noscript>{t.noScript}</noscript>}
      {release ? (
        <>
          <p className="download-nightly__version">
            {platform === 'android' ? 'Android · ' : ''}v{release.version}
          </p>
          {'minimumStableVersion' in release && (
            <p className="download-nightly__description">
              {t.minimumStable(release.minimumStableVersion)}
            </p>
          )}
          <div className="download-grid">
            {(platform === 'android' ? (['android'] as const) : (['mac', 'win', 'linux'] as const))
              .filter((downloadPlatform) =>
                release.downloads.some((item) => item.platform === downloadPlatform)
              )
              .map((downloadPlatform) => (
                <article className="download-card" key={downloadPlatform}>
                  <div className="download-card__header">
                    {downloadPlatform === 'android' ? (
                      <Smartphone aria-hidden="true" />
                    ) : downloadPlatform === 'win' ? (
                      <MonitorDown aria-hidden="true" />
                    ) : (
                      <Laptop aria-hidden="true" />
                    )}
                    <h3>
                      {downloadPlatform === 'mac'
                        ? 'macOS'
                        : downloadPlatform === 'win'
                          ? 'Windows'
                          : downloadPlatform === 'android'
                            ? 'Android'
                            : 'Linux'}
                    </h3>
                  </div>
                  <div className="download-card__actions">
                    {release.downloads
                      .filter((item) => item.platform === downloadPlatform)
                      .map((item) => (
                        <SiteAnchor
                          className="download-card__action"
                          href={item.href}
                          key={item.href}
                        >
                          <span>{item.label}</span>
                          <Download aria-hidden="true" />
                        </SiteAnchor>
                      ))}
                  </div>
                </article>
              ))}
          </div>
        </>
      ) : (
        <div className="download-nightly__status">
          <p role="status">
            {platform === 'android' ? 'Android: ' : t.desktopPrefix}
            {loading ? t.loading : t.unavailable}
          </p>
          {!loading && base !== null && (
            <button
              type="button"
              className="download-card__action"
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t.retry}
            </button>
          )}
        </div>
      )}
      {platform === 'desktop' && <p className="download-nightly__switching">{t.switching}</p>}
    </div>
  );
}
