/** CSC_NAME is the same certificate-name qualifier consumed by Electron Builder. */
export function selectMacSigningIdentity(identities, configuredName) {
  const selector = configuredName?.trim();
  if (!selector) throw new Error('A macOS signing identity is required');
  const matches = [...identities.matchAll(/^\s*\d+\)\s+([\da-f]{40})\s+"([^"]+)"\s*$/gim)]
    .map(([, hash, name]) => ({ hash: hash.toUpperCase(), name }))
    .filter(
      ({ hash, name }) =>
        name.startsWith('Developer ID Application:') &&
        (hash === selector.toUpperCase() || name.includes(selector))
    );
  if (matches.length !== 1)
    throw new Error(
      'The imported P12 must contain exactly one valid Developer ID Application identity matching CSC_NAME'
    );
  return matches[0].hash;
}

/** A successful notarytool invocation may still contain a rejected submission. */
export function requireAcceptedNotarization(output) {
  const result = JSON.parse(output);
  if (result.status !== 'Accepted')
    throw new Error(
      `macOS daemon notarization was not accepted: ${result.status ?? 'missing status'}`
    );
}

/** codesign also requires its identity keychain in the user search list. */
export function makeMacSigningKeychainSearchable(keychain, security) {
  const read = () =>
    security(['list-keychains', '-d', 'user'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const current = read();
  if (!current.includes(keychain))
    security(['list-keychains', '-d', 'user', '-s', keychain, ...current]);
  return () => {
    const remaining = read().filter((item) => item !== keychain);
    security(['list-keychains', '-d', 'user', '-s', ...remaining]);
  };
}
