const PREFERRED_SYSTEM_LANGUAGES_ARGUMENT_PREFIX = '--lody-preferred-system-languages='

function sanitizePreferredSystemLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return value
    .filter((language): language is string => typeof language === 'string')
    .map((language) => language.trim())
    .filter((language) => language.length > 0)
    .slice(0, 32)
}

export function serializePreferredSystemLanguagesArgument(
  preferredSystemLanguages: readonly string[]
): string {
  return `${PREFERRED_SYSTEM_LANGUAGES_ARGUMENT_PREFIX}${encodeURIComponent(
    JSON.stringify(sanitizePreferredSystemLanguages(preferredSystemLanguages))
  )}`
}

export function readPreferredSystemLanguagesArgument(argv: readonly string[]): string[] {
  const argument = argv.find((value) =>
    value.startsWith(PREFERRED_SYSTEM_LANGUAGES_ARGUMENT_PREFIX)
  )
  if (!argument) return []

  try {
    const encoded = argument.slice(PREFERRED_SYSTEM_LANGUAGES_ARGUMENT_PREFIX.length)
    return sanitizePreferredSystemLanguages(JSON.parse(decodeURIComponent(encoded)))
  } catch {
    return []
  }
}
