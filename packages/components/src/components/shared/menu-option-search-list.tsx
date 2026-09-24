import { useMemo, useState, type ReactNode } from 'react';

import { usePostHog } from '@posthog/react';

import { filterFuzzyOptions, shouldOfferOptionSearch } from '@/lib/fuzzy-option-filter';
import { capturePickerSearchSelected, type SearchPickerKind } from '@/lib/picker-search-analytics';
import { DropdownMenuSearchInput } from '@/ui/dropdown-menu';

export type MenuSearchableOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type MenuOptionSearchListProps<TOption extends MenuSearchableOption> = {
  options: ReadonlyArray<TOption>;
  /**
   * The row itself, so each menu keeps its own row grammar (icons, checks).
   * `select` is handed in rather than taken as a second prop: Enter on the
   * search field and a click on the row must be the same action, and two props
   * naming it separately is how they stop being.
   */
  renderOption: (option: TOption, select: () => void) => ReactNode;
  onSelect: (option: TOption) => void;
  searchPlaceholder: string;
  emptyText: string;
  /** Reports picks made after typing a search term (`picker/search_selected`). */
  searchAnalyticsPicker?: SearchPickerKind;
};

/**
 * Body for a menu whose option list can be long enough that scrolling it is not
 * a way to find anything — an agent provider may publish dozens of models.
 *
 * Renders as the whole content of a `DropdownMenuContent` / `SubContent` given
 * `flex flex-col overflow-y-hidden p-0`: the search row stays put while only
 * the list below it scrolls. Below `OPTION_SEARCH_MIN_OPTIONS` the field is not
 * rendered at all and the list reads exactly as it did before.
 */
export function MenuOptionSearchList<TOption extends MenuSearchableOption>({
  options,
  renderOption,
  onSelect,
  searchPlaceholder,
  emptyText,
  searchAnalyticsPicker,
}: MenuOptionSearchListProps<TOption>) {
  const postHog = usePostHog();
  const [query, setQuery] = useState('');
  const searchable = shouldOfferOptionSearch(options.length);

  const filtered = useMemo(
    () =>
      filterFuzzyOptions(options, query, (option) => ({
        primary: option.label,
        // The id behind a pretty label and the provider's own blurb are worth
        // finding by, but never ahead of a visible name.
        secondary: [option.value, option.description],
      })),
    [options, query]
  );

  const select = (option: TOption) => {
    if (searchAnalyticsPicker) {
      capturePickerSearchSelected(postHog, {
        picker: searchAnalyticsPicker,
        term: query,
        rank: filtered.indexOf(option),
        resultCount: filtered.length,
      });
    }
    onSelect(option);
  };

  const submitTopMatch = () => {
    const top = filtered.find((option) => !option.disabled);
    if (top) select(top);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchable ? (
        <DropdownMenuSearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={searchPlaceholder}
          onSubmit={submitTopMatch}
          // The width floor belongs to the field, not the list: a menu with no
          // search field keeps the menu surface's own narrow minimum.
          className="min-w-56 border-b border-border/40 px-2.5 py-2"
        />
      ) : null}
      <div className="scroll-pro scrollbar-pro min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5 [scrollbar-gutter:auto]">
        {filtered.length === 0 ? (
          <div className="px-2.5 py-2 text-[0.8rem] text-muted-foreground">{emptyText}</div>
        ) : (
          filtered.map((option) => renderOption(option, () => select(option)))
        )}
      </div>
    </div>
  );
}
