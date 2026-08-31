import { createContentHighlighter } from 'fumadocs-core/search';
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SearchItemType,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import { useEffect, useMemo, useState } from 'react';

type SearchEntry = {
  id: string;
  locale: 'en' | 'zh';
  url: string;
  title: string;
  description: string;
  content: string;
};

let indexRequest: Promise<SearchEntry[]> | undefined;

function loadIndex() {
  indexRequest ??= fetch('/docs-search.json').then(async (response) => {
    if (!response.ok) throw new Error(`Unable to load docs search index (${response.status})`);
    return (await response.json()) as SearchEntry[];
  });
  return indexRequest;
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function rankEntry(entry: SearchEntry, terms: string[]) {
  const title = normalize(entry.title);
  const description = normalize(entry.description);
  const content = normalize(entry.content);
  if (
    !terms.every(
      (term) => title.includes(term) || description.includes(term) || content.includes(term)
    )
  ) {
    return null;
  }

  return terms.reduce((score, term) => {
    if (title === term) return score + 120;
    if (title.startsWith(term)) return score + 80;
    if (title.includes(term)) return score + 60;
    if (description.includes(term)) return score + 30;
    return score + 10;
  }, 0);
}

export function DocsSearchDialog(props: SharedProps) {
  const { locale } = useI18n();
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;

    let active = true;
    setIsLoading(true);
    void loadIndex()
      .then((index) => {
        if (active) setEntries(index);
      })
      .catch((error: unknown) => {
        console.error('Failed to load docs search index', error);
        if (active) setEntries([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [props.open]);

  const results = useMemo<SearchItemType[] | null>(() => {
    const query = normalize(search.trim());
    if (query.length === 0) return null;

    const terms = query.split(/\s+/u).filter(Boolean);
    const highlighter = createContentHighlighter(terms.join(' '));

    return entries
      .filter((entry) => entry.locale === locale)
      .map((entry) => ({ entry, score: rankEntry(entry, terms) }))
      .filter((result): result is { entry: SearchEntry; score: number } => result.score !== null)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, locale))
      .slice(0, 12)
      .map(({ entry }) => ({
        id: entry.id,
        type: 'page' as const,
        url: entry.url,
        content: highlighter.highlightMarkdown(entry.title),
        breadcrumbs: [entry.description],
      }));
  }, [entries, locale, search]);

  return (
    <SearchDialog {...props} search={search} onSearchChange={setSearch} isLoading={isLoading}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={results} />
      </SearchDialogContent>
    </SearchDialog>
  );
}
