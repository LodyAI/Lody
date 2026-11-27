#!/usr/bin/env node
/**
 * i18n Translation Key Checker
 *
 * This script scans the codebase for translation keys used with `t('key')` or `t('key', 'fallback')`
 * and compares them against the translation files to find missing keys.
 *
 * Usage: node scripts/check-i18n.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Directories to scan for translation key usage
const scanDirs = [path.join(repoRoot, 'packages', 'components', 'src')];

// Translation files to check
const translationFiles = [
  { lang: 'en', path: path.join(repoRoot, 'locales', 'en.json') },
  { lang: 'zh_CN', path: path.join(repoRoot, 'locales', 'zh_CN.json') },
  { lang: 'zh_Hant', path: path.join(repoRoot, 'locales', 'zh_Hant.json') },
  { lang: 'ja', path: path.join(repoRoot, 'locales', 'ja.json') },
  { lang: 'ko', path: path.join(repoRoot, 'locales', 'ko.json') },
  { lang: 'es', path: path.join(repoRoot, 'locales', 'es.json') },
  { lang: 'fr', path: path.join(repoRoot, 'locales', 'fr.json') },
  { lang: 'ru', path: path.join(repoRoot, 'locales', 'ru.json') },
];

// File extensions to scan
const extensions = ['.ts', '.tsx', '.js', '.jsx'];

// Directories/files to ignore
const ignoreDirs = ['node_modules', '.git', 'dist', 'coverage', '__tests__', 'stories'];

/**
 * Recursively get all files in a directory
 */
async function getAllFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!ignoreDirs.includes(entry.name)) {
        files.push(...(await getAllFiles(fullPath)));
      }
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Extract translation keys from file content
 * Matches patterns like:
 * - t('key')
 * - t('key', 'fallback')
 * - t('key', { ... })
 * - t("key")
 * - t(`key`) - but not template literals with variables
 */
function extractKeys(content, filePath) {
  const keys = new Map(); // key -> { file, line }

  // Match t('key' or t("key" patterns
  // This regex captures the key and tracks position for line numbers
  const regex = /\bt\(\s*['"`]([^'"`\n]+?)['"`]/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const key = match[1];
    // Skip template literal variables like ${var}
    if (key.includes('${')) continue;
    // Skip keys that look like file paths or URLs
    if (key.includes('/') || key.includes('\\')) continue;

    // Calculate line number
    const lineNumber = content.substring(0, match.index).split('\n').length;

    if (!keys.has(key)) {
      keys.set(key, { file: filePath, line: lineNumber });
    }
  }

  return keys;
}

/**
 * Get a translation value for a key.
 *
 * This repo uses **flat** i18n JSON keys (e.g. "archive.title") for easier searching.
 * For forward/backward compatibility, we also support legacy nested lookup as a fallback.
 */
function getTranslationValue(obj, keyPath) {
  if (obj === undefined || obj === null) return undefined;

  // 1) Flat key lookup (preferred)
  if (Object.prototype.hasOwnProperty.call(obj, keyPath)) {
    return obj[keyPath];
  }

  // 2) Legacy nested lookup (fallback)
  const parts = keyPath.split('.');
  let current = obj;

  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }

  return current;
}

// Keys where `referral-settings-pure.tsx` supplies both `{{discount}}` (e.g. "20% off")
// and `{{rate}}` (e.g. "8 折" in Chinese), so either token satisfies parity.
const DISCOUNT_OR_RATE_KEYS = new Set([
  'referral.retainedCheckout',
  'referral.description',
  'referral.discount',
  'referral.shareTitle',
  'referral.perkDiscount',
  'referral.offerBadge',
  'billing.switchPromoDiscountWithPercent',
  'workspace.invite.seat.promoNoteUntil',
]);

/**
 * Extract sorted unique `{{placeholder}}` tokens from a translation string.
 */
function extractPlaceholders(value, key) {
  if (typeof value !== 'string') return [];
  const matches = value.match(/\{\{[^}]+\}\}/g);
  if (!matches) return [];
  const normalized = DISCOUNT_OR_RATE_KEYS.has(key)
    ? matches.map((token) => (token === '{{rate}}' ? '{{discount}}' : token))
    : matches;
  return [...new Set(normalized)].sort();
}

/**
 * Get all keys from a nested object as dot-notation paths
 */
function _getAllNestedKeys(obj, prefix = '') {
  const keys = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(..._getAllNestedKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

async function main() {
  console.log('🔍 Scanning for translation keys...\n');

  // Load translation files
  const translations = new Map();
  for (const { lang, path: filePath } of translationFiles) {
    try {
      const content = await readFile(filePath, 'utf-8');
      translations.set(lang, JSON.parse(content));
      console.log(`✓ Loaded ${lang} translations from ${path.relative(repoRoot, filePath)}`);
    } catch (error) {
      console.error(`✗ Failed to load ${lang} translations: ${error.message}`);
      process.exit(1);
    }
  }

  console.log('');

  // Collect all used keys
  const usedKeys = new Map(); // key -> { file, line }

  for (const scanDir of scanDirs) {
    const files = await getAllFiles(scanDir);
    console.log(`📁 Scanning ${files.length} files in ${path.relative(repoRoot, scanDir)}`);

    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const fileKeys = extractKeys(content, file);

      for (const [key, location] of fileKeys) {
        if (!usedKeys.has(key)) {
          usedKeys.set(key, location);
        }
      }
    }
  }

  console.log(`\n📊 Found ${usedKeys.size} unique translation keys in use\n`);

  // Check for missing keys in each language
  let hasErrors = false;
  const missingByLang = new Map();
  const placeholderMismatchesByLang = new Map();
  const enTranslations = translations.get('en');

  for (const [lang, translationData] of translations) {
    const missing = [];

    for (const [key, location] of usedKeys) {
      const value = getTranslationValue(translationData, key);
      if (value === undefined) {
        missing.push({ key, ...location });
      }
    }

    if (missing.length > 0) {
      hasErrors = true;
      missingByLang.set(lang, missing);
    }

    if (lang !== 'en' && enTranslations) {
      const mismatches = [];
      for (const [key, enValue] of Object.entries(enTranslations)) {
        if (typeof enValue !== 'string') continue;
        const localizedValue = getTranslationValue(translationData, key);
        if (typeof localizedValue !== 'string') continue;
        const expected = extractPlaceholders(enValue, key);
        const actual = extractPlaceholders(localizedValue, key);
        if (
          expected.length !== actual.length ||
          expected.some((token, index) => token !== actual[index])
        ) {
          mismatches.push({ key, expected, actual });
        }
      }
      if (mismatches.length > 0) {
        hasErrors = true;
        placeholderMismatchesByLang.set(lang, mismatches);
      }
    }
  }

  // Report results
  if (hasErrors) {
    if (missingByLang.size > 0) {
      console.log('❌ Missing translations found:\n');

      for (const [lang, missing] of missingByLang) {
        console.log(`\n  ${lang} (${missing.length} missing):`);
        console.log('  ' + '─'.repeat(50));

        for (const { key, file, line } of missing) {
          const relativeFile = path.relative(repoRoot, file);
          console.log(`    • ${key}`);
          console.log(`      └─ ${relativeFile}:${line}`);
        }
      }
    }

    if (placeholderMismatchesByLang.size > 0) {
      console.log('\n❌ Placeholder mismatches found (vs en.json):\n');

      for (const [lang, mismatches] of placeholderMismatchesByLang) {
        console.log(`\n  ${lang} (${mismatches.length} mismatched):`);
        console.log('  ' + '─'.repeat(50));

        for (const { key, expected, actual } of mismatches) {
          console.log(`    • ${key}`);
          console.log(`      expected: ${expected.join(', ') || '(none)'}`);
          console.log(`      actual:   ${actual.join(', ') || '(none)'}`);
        }
      }
    }

    console.log('\n');
    process.exit(1);
  } else {
    console.log('✅ All translation keys and placeholders match across all languages!\n');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
