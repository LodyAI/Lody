import { FileText, RefreshCw, Search, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ConversationColumn } from '@/components/shared/conversation-column';

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
    <div className="flex h-full flex-col justify-end px-3 pb-4">
      <ConversationColumn>
        <div className="flex flex-col items-end gap-1">
          {CHILD_TAB_SUGGESTIONS.map((suggestion) => {
            const Icon = suggestion.icon;
            const label = t(suggestion.labelKey, suggestion.fallback);
            return (
              <button
                key={suggestion.labelKey}
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-border/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-hover hover:text-foreground"
                onClick={() => onSuggest(label)}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </ConversationColumn>
    </div>
  );
}
