import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalContainerProvider, PopupContainerProvider } from '@lody/ui/popup-container';
import type { TodayDesktopTarget } from '@/lib/desktop-window';
import { ElectronFullscreenContext } from '@/lib/electron';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';
import { TodayView, type TodayViewTarget } from './today-view';
import { TodayWindowFrame } from './today-window';

export function TodayCompanion({
  name,
  popup,
  initialTarget,
}: {
  name: string;
  popup: Window;
  initialTarget: TodayDesktopTarget;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<TodayViewTarget>(initialTarget);
  const navigate = (next: TodayViewTarget) => {
    setTarget(next);
    void getIpcServices()?.app.updateTodayCompanion(name, {
      type: 'target', target: { workspace: initialTarget.workspace, member: next.member, date: next.date }
    }).catch(console.error);
  };
  const [pinned, setPinned] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => onIpcEvent('app.todayCompanionFullscreen', (event) => {
    if (event.name === name) setFullscreen(event.fullscreen);
  }), [name]);
  const ready = useRef(false);
  const document = popup.document;
  const show = useCallback(() => {
    if (ready.current) return;
    ready.current = true;
    void getIpcServices()?.app.updateTodayCompanion(name, { type: 'show' }).catch(console.error);
  }, [name]);

  useLayoutEffect(() => {
    document.title = t('today.nav', 'Today');
  }, [document, t]);

  useLayoutEffect(() => {
    const source = window.document;
    const mirrorAppearance = () => {
      const root = source.documentElement;
      document.documentElement.className = root.className;
      document.documentElement.style.cssText = root.style.cssText;
      document.documentElement.lang = root.lang;
      document.documentElement.dir = root.dir;
    };
    const sheets = new Map<Element, Element>();
    const mirrorStyles = () => {
      const styles = new Set(source.head.querySelectorAll('link[rel="stylesheet"], style'));
      for (const [original, copy] of sheets) {
        if (!styles.has(original)) {
          copy.remove();
          sheets.delete(original);
        }
      }
      for (const original of styles) {
        const copy = sheets.get(original);
        if (copy) {
          if (original.tagName === 'STYLE') copy.textContent = original.textContent;
          continue;
        }
        const imported = document.importNode(original, true);
        if (imported.tagName === 'LINK') {
          imported.setAttribute('href', (original as HTMLLinkElement).href);
        }
        sheets.set(original, imported);
        document.head.append(imported);
      }
    };
    mirrorAppearance();
    mirrorStyles();
    const observer = new MutationObserver(mirrorAppearance);
    observer.observe(source.documentElement, { attributes: true });
    const styleObserver = new MutationObserver(mirrorStyles);
    styleObserver.observe(source.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      styleObserver.disconnect();
    };
  }, [document]);

  return (
    <ElectronFullscreenContext.Provider value={fullscreen}>
    <ModalContainerProvider container={document.body}>
      <PopupContainerProvider container={document.body}>
        <div id="root">
          <TodayWindowFrame>
            <TodayView
              target={target}
              onNavigate={navigate}
              standalone
              ownerWindow={popup}
              onDayReady={show}
              pinned={pinned}
              onTogglePin={() => {
                void getIpcServices()?.app.updateTodayCompanion(name, { type: 'pin', pinned: !pinned })
                  .then(setPinned).catch(console.error);
              }}
            />
          </TodayWindowFrame>
        </div>
      </PopupContainerProvider>
    </ModalContainerProvider>
    </ElectronFullscreenContext.Provider>
  );
}
