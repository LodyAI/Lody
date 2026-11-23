/**
 * Tool calls report their raw input as a text content block holding a
 * serialized JSON payload (for example `{"command":"…","timeout":60}`). That
 * text is data, not prose: passing it through the Markdown pipeline lets
 * single-`$` math parsing consume shell fragments such as `$(...)` and drop
 * characters like the `&` in `2>&1`. Detect those payloads so the renderer
 * can show them as verbatim code instead of Markdown.
 *
 * `JSON.parse` only validates; the original text is returned untouched.
 * Re-serializing would route numeric lexemes through JavaScript numbers and
 * corrupt integers beyond 2^53 (64-bit IDs) or rewrite forms like `1e10`,
 * recreating the same displayed-differs-from-actual problem on the digits.
 */
export const detectToolCallJsonText = (text: string): string | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return trimmed;
};
