type SnapshotValue =
  | null
  | string
  | number
  | boolean
  | readonly SnapshotValue[]
  | { readonly [key: string]: SnapshotValue };
const denied = () => Object.assign(Error('Snapshot target unavailable'), { code: 'forbidden' });
const sensitive =
  /(?:secret|password|passwd|privatekey|signingkey|recoverykey|encryptionkey|wrappingkey|credential|keychain|keyring|^kek$|^dek$|authtoken|accesstoken|refreshtoken|apikey|bearer|authorization|cookie|^env$|^envpassthrough$|^argv$|^args$|^headers$|^auth$|token$|^oauth|codexauth|^authprofile|^authentication|keyenvelope|epochkey|rootkey|contentkey|signedurl|signingmaterial|passphrase|mnemonic|recoverycode|sessioncookie|clientsecret|keymaterial|^e2ee|^launchconfig$|^customacp$)/i;
const blocked = (key: string) =>
  ['__proto__', 'constructor', 'prototype'].includes(key) ||
  sensitive.test(key.replace(/[^a-z0-9]/gi, ''));
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
/** Only JSON data crosses the binding; do not invoke getters, serialize handles, or follow prototype paths. */
export function copyPluginSnapshot(
  raw: unknown,
  path: readonly string[],
  pluginId: string,
  kind: string
): SnapshotValue {
  const own = (value: unknown, key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
  const allowed = (row: unknown, key: string, position: readonly string[]) =>
    !blocked(key) &&
    (key !== 'businessKey' ||
      (((kind === 'session-meta' && position.length === 0) ||
        (kind === 'workspace-state' && position.length === 2 && position[0] === 'sessions')) &&
        own(row, 'createdByPluginId') === pluginId));
  const location: string[] = [];
  for (const key of path) {
    if (!raw || (!plain(raw) && !Array.isArray(raw)) || !allowed(raw, key, location))
      throw denied();
    location.push(key);
    raw = own(raw, key);
    if (raw === undefined) throw denied();
  }
  function copy(v: unknown, loc: readonly string[]): SnapshotValue {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (Array.isArray(v)) return Object.freeze(v.map((item, i) => copy(item, [...loc, String(i)])));
    if (!plain(v)) throw Error('Invalid snapshot source');
    const out: Record<string, SnapshotValue> = Object.create(null);
    for (const key of Object.keys(v)) {
      if (!allowed(v, key, loc)) continue;
      const value = own(v, key);
      if (value !== undefined) out[key] = copy(value, [...loc, key]);
    }
    return Object.freeze(out);
  }
  return copy(raw, location);
}
