export type OpenSourceAttributionKind = 'package' | 'vendored';

export type OpenSourceAttributionScope =
  | 'production-dependency'
  | 'bundled-theme'
  | 'vendored-icon-set'
  | 'vendored-source';

export type OpenSourceAttributionEntry = {
  id: string;
  kind: OpenSourceAttributionKind;
  scope: OpenSourceAttributionScope;
  name: string;
  license: string;
  homepage?: string;
  author?: string;
  description?: string;
  versions?: string[];
  assets?: string[];
  noticePath?: string;
};

export type OpenSourceAttributionBundle = {
  schemaVersion: 1;
  generatedAt: string;
  entries: OpenSourceAttributionEntry[];
};
