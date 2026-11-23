import { getServerNow, SESSION_FILE_RETENTION_DAYS, type SessionFilePayload } from '@lody/shared';

/** Human-readable byte size. Mirrors the All-Changes formatBytes shape. */
export const formatFileSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Coarse file kinds used to pick an icon. Extension-driven, MIME as a fallback. */
export type SessionFileKind =
  | 'text'
  | 'code'
  | 'data'
  | 'archive'
  | 'spreadsheet'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'binary';

const CODE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  'py',
  'rb',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'm',
  'mm',
  'cs',
  'php',
  'pl',
  'pm',
  'lua',
  'r',
  'dart',
  'ex',
  'exs',
  'erl',
  'clj',
  'cljs',
  'hs',
  'elm',
  'vue',
  'svelte',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'graphql',
  'gql',
  'proto',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'diff',
  'patch',
]);

const DATA_EXTENSIONS = new Set([
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'env',
  'properties',
]);

const SPREADSHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz', 'zst']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'heic',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'ogv']);
// Plain-text-ish files: neutral icon tile. Kept distinct from DOCUMENT (pdf/
// word) so prose docs and logs/markdown don't share the same accent.
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', 'md', 'markdown', 'mdx', 'rst']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf']);

const getExtension = (fileName: string): string => {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
};

/** HTML attachments use the live-file/browser affordance instead of text preview. */
export const isHtmlSessionFile = (
  file: Pick<SessionFilePayload, 'fileName' | 'mimeType'>
): boolean => {
  const extension = getExtension(file.fileName);
  const mimeType = file.mimeType.split(';', 1)[0]?.trim().toLowerCase();
  return extension === 'html' || extension === 'htm' || mimeType === 'text/html';
};

export const isVideoSessionFile = (
  file: Pick<SessionFilePayload, 'fileName' | 'mimeType'>
): boolean => getSessionFileKind(file.fileName, file.mimeType) === 'video';

/** Pick a coarse file kind from the name (then MIME) for icon selection. */
export const getSessionFileKind = (fileName: string, mimeType?: string): SessionFileKind => {
  const ext = getExtension(fileName);
  if (ext) {
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (DATA_EXTENSIONS.has(ext)) return 'data';
    if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
    if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  }
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('text/')) return 'text';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.includes('json') || mime.includes('xml') || mime.includes('yaml')) return 'data';
  if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) return 'archive';
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('document')) return 'document';
  return 'binary';
};

export const SESSION_FILE_RETENTION_MS = SESSION_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Server-time expiry instant for a file, derived from its upload timestamp. */
export const getSessionFileExpiryAt = (uploadedAt: number): number =>
  uploadedAt + SESSION_FILE_RETENTION_MS;

/**
 * Whether a file's retention window has elapsed. Uses `getServerNow()` (not
 * `Date.now()`) so the derived expiry is consistent across clients with skewed
 * local clocks (see context/timestamps.md).
 */
export const isSessionFileExpired = (
  file: Pick<SessionFilePayload, 'uploadedAt'>,
  now: number = getServerNow()
): boolean => now >= getSessionFileExpiryAt(file.uploadedAt);

/** Presentation state of a file block, driving the card's affordance + copy. */
export type SessionFileDisplayState = 'pending' | 'expired' | 'previewable' | 'downloadable';

export const getSessionFileDisplayState = (
  file: SessionFilePayload,
  now: number = getServerNow()
): SessionFileDisplayState => {
  if (file.transport === 'local') return 'pending';
  if (isSessionFileExpired(file, now)) return 'expired';
  return file.textPreview || isVideoSessionFile(file) ? 'previewable' : 'downloadable';
};
