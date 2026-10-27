import { FileText, RefreshCw, Search, type LucideIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';

import { ConversationColumn } from '@/components/shared/conversation-column';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  root: {
    display: 'flex',
    height: '100%',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    paddingInline: themeSpace[3],
    paddingBottom: themeSpace[4],
  },
  suggestions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: themeSpace[1],
  },
  suggestion: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[2],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    borderRadius: themeRadius.lg,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1.5],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
    '@media (hover: hover)': {
      ':hover': {
        borderColor: themeColors.border,
        backgroundColor: themeColors.hover,
        color: themeColors.foreground,
      },
    },
  },
  suggestionIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    opacity: 0.6,
  },
});

const CHILD_TAB_SUGGESTIONS: {
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
}[] = [
  {
    labelKey: 'sessions.childTab.suggestions.review',
    fallback: 'Review the changes on this branch',
    icon: Search,
  },
  {
    labelKey: 'sessions.childTab.suggestions.summarize',
    fallback: 'Summarize the changes on this branch',
    icon: FileText,
  },
  {
    labelKey: 'sessions.childTab.suggestions.simplify',
    fallback: 'Simplify the changes on this branch',
    icon: RefreshCw,
  },
];

export function ChildTabEmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  const { t } = useTranslation();

  return (
    <div {...stylex.props(styles.root)}>
      <ConversationColumn>
        <div {...stylex.props(styles.suggestions)}>
          {CHILD_TAB_SUGGESTIONS.map((suggestion) => {
            const Icon = suggestion.icon;
            const label = t(suggestion.labelKey, suggestion.fallback);
            return (
              <button
                key={suggestion.labelKey}
                type="button"
                {...stylex.props(styles.suggestion)}
                onClick={() => onSuggest(label)}
              >
                <Icon {...stylex.props(styles.suggestionIcon)} aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </ConversationColumn>
    </div>
  );
}
