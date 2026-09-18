import { useEffect, useLayoutEffect } from 'react';
import { useAtomValue } from 'jotai';

import { conversationFontSizeAtom, interfaceFontFamilyAtom } from '@/atoms';
import {
  applyUiFontSize,
  UI_FONT_SIZE_CSS_VARIABLE,
} from '@/components/ai-gui/conversation-font-size-classes';
import { applyInterfaceFontFamily } from '@/lib/local-fonts';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function InterfaceFontController({ enabled }: { enabled: boolean }) {
  const interfaceFontFamily = useAtomValue(interfaceFontFamilyAtom);
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);

  useIsomorphicLayoutEffect(() => {
    const root = window.document.documentElement;
    applyInterfaceFontFamily(root, enabled ? interfaceFontFamily : '');
    applyUiFontSize(root, conversationFontSize);

    return () => {
      applyInterfaceFontFamily(root, '');
      root.style.removeProperty(UI_FONT_SIZE_CSS_VARIABLE);
    };
  }, [enabled, interfaceFontFamily, conversationFontSize]);

  return null;
}
