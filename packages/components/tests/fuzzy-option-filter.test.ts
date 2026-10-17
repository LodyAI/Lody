import { describe, expect, it } from 'vitest';

import {
  filterFuzzyOptions,
  shouldOfferOptionSearch,
  OPTION_SEARCH_MIN_OPTIONS,
} from '../src/lib/fuzzy-option-filter';

type Option = { value: string; label: string; description?: string };

const models: Option[] = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', description: 'Fastest for coding' },
];

const filter = (query: string) =>
  filterFuzzyOptions(models, query, (option) => ({
    primary: option.label,
    secondary: [option.value, option.description],
  })).map((option) => option.value);

describe('filterFuzzyOptions', () => {
  it('leaves the provider order alone when nothing was typed', () => {
    expect(filter('')).toEqual(models.map((model) => model.value));
    expect(filter('   ')).toEqual(models.map((model) => model.value));
  });

  it('matches a subsequence, not just a substring', () => {
    // Nobody types a model id in full; `op5` is how you ask for Opus 5.
    expect(filter('op5')).toEqual(['claude-opus-5']);
  });

  it('treats a space as "and", so a query can skip over separators', () => {
    // The query's space is nowhere in `claude-opus-5`; each term still is.
    expect(filter('opus 5')).toEqual(['claude-opus-5']);
  });

  it('is case-insensitive', () => {
    expect(filter('SONNET')).toEqual(['claude-sonnet-5']);
  });

  it('ranks a match on the visible label above one only in the id or blurb', () => {
    // `codex` is the label of one option and the description word of none; `cod`
    // hits the GPT label. A hit on the hidden id must not outrank a visible name.
    const ranked = filterFuzzyOptions(
      [
        { value: 'anthropic-fastest', label: 'Opus 5' },
        { value: 'x-1', label: 'Fastest Mini' },
      ],
      'fastest',
      (option) => ({ primary: option.label, secondary: [option.value] })
    ).map((option) => option.value);
    expect(ranked).toEqual(['x-1', 'anthropic-fastest']);
  });

  it('finds an option by a word from its description', () => {
    expect(filter('coding')).toEqual(['gpt-5.5-codex']);
  });

  it('returns nothing when a term matches nothing', () => {
    expect(filter('zzz')).toEqual([]);
    // Every term has to match: `opus` alone would hit, `zzz` never does.
    expect(filter('opus zzz')).toEqual([]);
  });

  it('offers search only once a list is too long to read at a glance', () => {
    expect(shouldOfferOptionSearch(OPTION_SEARCH_MIN_OPTIONS - 1)).toBe(false);
    expect(shouldOfferOptionSearch(OPTION_SEARCH_MIN_OPTIONS)).toBe(true);
  });
});
