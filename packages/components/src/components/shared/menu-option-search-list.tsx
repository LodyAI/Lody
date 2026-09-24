import { useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';

import { usePostHog } from '@posthog/react';

import { filterFuzzyOptions, shouldOfferOptionSearch } from '@/lib/fuzzy-option-filter';
import { withClassName } from '@/lib/stylex';
import { MenuSearchInput } from '@/ui/menu';
import { composerSurface } from './composer-surface';
import { capturePickerSearchSelected, type SearchPickerKind } from '@/lib/picker-search-analytics';

const styles = stylex.create({
  body: { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarGutter: 'auto',
  },
});

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
 * Renders as the whole content of a `Menu.Content` that holds its own overflow
 * (`overflow-y-hidden`): the search well stays put at the top of the popup's
 * inset while only the list below it scrolls. Below `OPTION_SEARCH_MIN_OPTIONS`
 * the field is not rendered at all and the list reads exactly as it did before.
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
    <div {...stylex.props(styles.body)}>
      {searchable ? (
        <MenuSearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={searchPlaceholder}
          onSubmit={submitTopMatch}
          // The width floor belongs to the field, not the list: a menu with no
          // search field keeps the menu surface's own narrow minimum.
          className="min-w-56"
        />
      ) : null}
      {/* `scroll-pro scrollbar-pro` are the app's global scrollbar skin. */}
      <div {...withClassName(stylex.props(styles.list), 'scroll-pro scrollbar-pro')}>
        {filtered.length === 0 ? (
          <div {...stylex.props(composerSurface.empty)}>{emptyText}</div>
        ) : (
          filtered.map((option) => renderOption(option, () => select(option)))
        )}
      </div>
    </div>
  );
}
