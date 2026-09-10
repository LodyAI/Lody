/**
 * Public binding syntax normalization and keyboard-capture helpers.
 *
 * DOM matching is delegated to tinykeys by `shortcut-host.tsx`. This module keeps the
 * public syntax stable and translates layout-stable keys to tinykeys' `event.code` syntax.
 */

type ParsedBinding = {
  /** Lowercased key (single chars) or canonical name (`Enter`, `ArrowUp`, etc.). */
  key: string;
  /** $mod = Cmd on macOS, Ctrl elsewhere. Mutually exclusive with explicit `ctrl`/`meta`. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

export function parseBinding(binding: string): ParsedBinding {
  const tokens = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error(`Invalid key binding: "${binding}"`);
  }
  const keyToken = tokens[tokens.length - 1]!;
  const modifierTokens = tokens.slice(0, -1);
  const result: ParsedBinding = {
    key: normalizeKeyToken(keyToken),
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };
  for (const token of modifierTokens) {
    const t = token.toLowerCase();
    if (t === '$mod' || t === 'mod') result.mod = true;
    else if (t === 'cmd' || t === 'command') result.mod = true;
    else if (t === 'meta') result.meta = true;
    else if (t === 'ctrl' || t === 'control') result.ctrl = true;
    else if (t === 'alt' || t === 'option') result.alt = true;
    else if (t === 'shift') result.shift = true;
    else throw new Error(`Unknown modifier "${token}" in binding "${binding}"`);
  }
  return result;
}

/**
 * Resolve a KeyboardEvent down to the "key" portion of a binding string.
 *
 * Why this exists: on macOS, holding ⌥ (Option/Alt) and pressing a letter or digit makes
 * `event.key` return the Option-produced glyph — `∫` for ⌥B, `¡` for ⌥1, `å` for ⌥A, etc.
 * That breaks both matching (`$mod+Alt+b` would never fire) and capture display (the
 * settings page would show "∫" instead of "B"). We side-step it by reading `event.code`
 * for letter (`KeyB`), digit (`Digit1`), and numpad (`Numpad1`) keys, which reports the
 * physical key position regardless of modifier state. Everything else (Enter, Escape,
 * ArrowUp, punctuation, F-keys, …) keeps using `event.key` since `code` for those does
 * not map cleanly to the binding-string token.
 *
 * Side benefit: bindings are layout-stable. A user on a French AZERTY layout binding
 * `$mod+b` to the physical QWERTY-B position gets the same binding string as a US user,
 * matching VSCode/Linear/Raycast convention for app shortcuts.
 */

/**
 * Punctuation keys we resolve by physical position (event.code) instead of event.key,
 * so a SHIFTED press reports the base char rather than the shifted glyph. Without this,
 * ⌘⇧[ would report `{` and ⌘⇧, would report `<`, so a `$mod+Shift+[` binding could never
 * match. Same layout-stable rationale as letters/digits; scoped to the keys we actually
 * bind (brackets for conversation switching, comma/period for tab switching) — other
 * punctuation stays event.key-based so e.g. a `+` binding (Shift+=) is unaffected.
 */
const PUNCTUATION_CODE_TO_KEY: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
};

export function physicalKeyFromEvent(event: KeyboardEvent): string {
  const code = event.code;
  if (code) {
    if (code.length === 4 && code.startsWith('Key')) {
      return code.charAt(3).toLowerCase();
    }
    if (code.length === 6 && code.startsWith('Digit')) {
      return code.charAt(5);
    }
    if (code.length === 7 && code.startsWith('Numpad')) {
      const c = code.charAt(6);
      if (c >= '0' && c <= '9') return c;
    }
    const punctuation = PUNCTUATION_CODE_TO_KEY[code];
    if (punctuation) return punctuation;
  }
  return normalizeEventKey(event.key);
}

/**
 * Normalize a `KeyboardEvent.key` string to the form used in binding strings: lowercase
 * single chars, `Space` for `' '`, and otherwise the standard `KeyboardEvent.key` value
 * (`Enter`, `Escape`, `ArrowUp`, …).
 */
export function normalizeEventKey(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toLowerCase();
  return key;
}

function normalizeKeyToken(token: string): string {
  if (token.length === 1) return token.toLowerCase();
  // Common aliases → KeyboardEvent.key canonical form.
  const lower = token.toLowerCase();
  switch (lower) {
    case 'space':
      // Must equal `normalizeEventKey(' ')` (= 'Space') and `physicalKeyFromEvent` for the
      // spacebar (event.code 'Space' falls through to the same), or a recorded `Space`
      // binding — saved as the string 'Space' by key-capture — would never match its event.
      return 'Space';
    case 'esc':
      return 'Escape';
    case 'return':
      return 'Enter';
    case 'up':
      return 'ArrowUp';
    case 'down':
      return 'ArrowDown';
    case 'left':
      return 'ArrowLeft';
    case 'right':
      return 'ArrowRight';
    case 'plus':
      return '+';
    default:
      // Preserve standard names (Enter, Escape, ArrowUp, Tab, …) as authored.
      return token;
  }
}

/**
 * Stable, modifier-order-independent identity for a binding string. Two binding strings
 * that resolve to the same physical combo share a canonical key. Mirrors the registry's
 * internal canonicalization so external conflict checks (e.g. against OS global shortcuts)
 * agree with dispatch. Returns null for an unparseable binding.
 */
export function canonicalizeBinding(binding: string): string | null {
  let parsed: ParsedBinding;
  try {
    parsed = parseBinding(binding);
  } catch {
    return null;
  }
  return [
    parsed.mod ? '$mod' : '',
    parsed.ctrl ? 'ctrl' : '',
    parsed.meta ? 'meta' : '',
    parsed.alt ? 'alt' : '',
    parsed.shift ? 'shift' : '',
    parsed.key,
  ].join(':');
}

/** Convert a public Lody binding to tinykeys syntax without changing its physical-key semantics. */
export function bindingToTinykeys(binding: string): string | null {
  let parsed: ParsedBinding;
  try {
    parsed = parseBinding(binding);
  } catch {
    return null;
  }

  const modifiers = [
    parsed.mod ? '$mod' : '',
    parsed.ctrl ? 'Control' : '',
    parsed.meta ? 'Meta' : '',
    parsed.alt ? 'Alt' : '',
    parsed.shift ? 'Shift' : '',
  ].filter(Boolean);

  let key = parsed.key;
  if (/^[a-z]$/.test(key)) {
    key = `Key${key.toUpperCase()}`;
  } else if (/^[0-9]$/.test(key)) {
    // Preserve support for both the number row and numpad while still matching
    // Option-produced glyphs through event.code on macOS.
    key = `(Digit${key}|Numpad${key})`;
  } else {
    // Lody bindings are single chords. Do not expose tinykeys' regex or sequence
    // grammar through persisted user input; multi-character named keys are DOM names.
    if (key.length > 1 && !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) return null;
    key =
      {
        '[': 'BracketLeft',
        ']': 'BracketRight',
        ',': 'Comma',
        '.': 'Period',
      }[key] ?? key;
  }

  return [...modifiers, key].join('+');
}

export function matchesKeyboardEvent(
  parsed: ParsedBinding,
  event: KeyboardEvent,
  isMac: boolean
): boolean {
  // `$mod` resolves to ⌘ on macOS, Ctrl elsewhere. To remain unambiguous we require that the
  // OPPOSITE primary modifier is NOT pressed — otherwise `$mod+b` would also fire on
  // unrelated combos like `Cmd+Ctrl+B`.
  const wantMetaPrimary = parsed.mod ? isMac : false;
  const wantCtrlPrimary = parsed.mod ? !isMac : false;
  const wantMeta = wantMetaPrimary || parsed.meta;
  const wantCtrl = wantCtrlPrimary || parsed.ctrl;
  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;

  return physicalKeyFromEvent(event) === parsed.key;
}
