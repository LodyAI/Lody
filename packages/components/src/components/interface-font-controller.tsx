import { useEffect, useLayoutEffect } from 'react';
import { useAtomValue } from 'jotai';

import {
  conversationFontSizeAtom,
  fontLigaturesEnabledAtom,
  interfaceFontFamilyAtom,
} from '@/atoms';
import {
  applyUiFontSize,
  UI_FONT_SIZE_CSS_VARIABLE,
} from '@/components/ai-gui/conversation-font-size-classes';
import {
  applyFontLigaturesEnabled,
  applyInterfaceFontFamily,
  FONT_LIGATURES_CSS_VARIABLE,
} from '@/lib/local-fonts';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function InterfaceFontController({ enabled }: { enabled: boolean }) {
  const interfaceFontFamily = useAtomValue(interfaceFontFamilyAtom);
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);
  const fontLigaturesEnabled = useAtomValue(fontLigaturesEnabledAtom);

  useIsomorphicLayoutEffect(() => {
    const root = window.document.documentElement;
    applyInterfaceFontFamily(root, enabled ? interfaceFontFamily : '');
    applyUiFontSize(root, conversationFontSize);
    applyFontLigaturesEnabled(root, fontLigaturesEnabled);

    return () => {
      applyInterfaceFontFamily(root, '');
      root.style.removeProperty(UI_FONT_SIZE_CSS_VARIABLE);
      root.style.removeProperty(FONT_LIGATURES_CSS_VARIABLE);
    };
  }, [enabled, interfaceFontFamily, conversationFontSize, fontLigaturesEnabled]);

  return null;
}
