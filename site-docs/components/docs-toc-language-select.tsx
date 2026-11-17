'use client';

import {
  LanguageSelect,
  LanguageSelectText,
} from 'fumadocs-ui/layouts/shared/slots/language-select';
import { ChevronDown, Languages } from 'lucide-react';

export function DocsTocLanguageSelect() {
  return (
    <div className="mb-4">
      <LanguageSelect
        variant="secondary"
        className="h-9 w-full justify-start gap-2 rounded-lg bg-fd-secondary/60 px-2.5 text-sm text-fd-muted-foreground hover:bg-fd-accent"
      >
        <Languages aria-hidden="true" className="size-4" />
        <LanguageSelectText className="min-w-0 flex-1 truncate text-start" />
        <ChevronDown aria-hidden="true" className="ms-auto size-3.5 opacity-70" />
      </LanguageSelect>
    </div>
  );
}
