import { describe, expect, it } from 'vitest';

import { filterFuzzyOptions } from '../src/lib/fuzzy-option-filter';

type Option = { value: string; label: string; description?: string };

const models: Option[] = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { value: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', description: 'Fastest for coding' },
];

const filter = (query: string) =>
  filterFuzzyOptions(models, query, (option) => ({
    primary: option.label,
    secondary: [option.value, option.description],
  })).map((option) => option.value);

describe('filterFuzzyOptions', () => {
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
});
