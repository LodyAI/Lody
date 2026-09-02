type FileTransferItem = Pick<DataTransferItem, 'kind' | 'getAsFile'> & {
  /** Chromium/WebKit only; jsdom and older engines have no entry API. */
  webkitGetAsEntry?: () => Pick<FileSystemEntry, 'isDirectory'> | null;
};
type FileDropDataTransfer = {
  types?: ArrayLike<string> | Iterable<string>;
  items?: ArrayLike<FileTransferItem> | Iterable<FileTransferItem>;
  files?: ArrayLike<File> | Iterable<File>;
};

/**
 * What one OS drop carried, split by what the app can do with each part.
 *
 * A dropped folder arrives as a `File` too — empty type, the folder's name —
 * and reading it fails, so treating it as an attachment only ever produced a
 * failed upload chip. `webkitGetAsEntry` is the one drop-time signal that tells
 * the two apart; an engine without it reports every item as a file.
 */
export type DroppedTransfer = {
  files: File[];
  directories: File[];
};

const toArray = <T>(value: ArrayLike<T> | Iterable<T> | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.from(value);
};

export const hasFileTransfer = (
  dataTransfer: Pick<FileDropDataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) {
    return false;
  }
  return toArray(dataTransfer.types).some((type) => type === 'Files');
};

export const readDroppedTransfer = (
  dataTransfer: Pick<FileDropDataTransfer, 'items' | 'files'>
): DroppedTransfer => {
  const files: File[] = [];
  const directories: File[] = [];
  for (const item of toArray<FileTransferItem>(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      directories.push(file);
    } else {
      files.push(file);
    }
  }

  if (files.length > 0 || directories.length > 0) {
    return { files, directories };
  }

  return { files: toArray<File>(dataTransfer.files), directories: [] };
};

export const splitImageAndFileAttachments = (
  files: File[]
): { images: File[]; attachments: File[] } => ({
  images: files.filter((file) => file.type.startsWith('image/')),
  attachments: files.filter((file) => !file.type.startsWith('image/')),
});
