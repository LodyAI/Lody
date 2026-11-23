import { SESSION_IMAGE_ALLOWED_MIME_TYPES } from '@lody/shared';

type FileTransferItem = Pick<DataTransferItem, 'kind' | 'getAsFile'> & {
  /** Chromium/WebKit only; jsdom and older engines have no entry API. */
  webkitGetAsEntry?: () => Pick<FileSystemEntry, 'isDirectory'> | null;
};
type FileDropDataTransfer = {
  types?: ArrayLike<string> | Iterable<string>;
  items?: ArrayLike<FileTransferItem> | Iterable<FileTransferItem>;
  files?: ArrayLike<File> | Iterable<File>;
};

const supportedImageMimeTypes = new Set<string>(SESSION_IMAGE_ALLOWED_MIME_TYPES);
const isSupportedImage = (file: File): boolean =>
  supportedImageMimeTypes.has(file.type.trim().toLowerCase());

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
): { images: File[]; attachments: File[] } => {
  return {
    images: files.filter(isSupportedImage),
    // Image MIME types unsupported by the image upload path (for example
    // SVG) remain valid general file attachments instead of being rejected.
    attachments: files.filter((file) => !isSupportedImage(file)),
  };
};

/**
 * A clipboard image the source app drew for us, not one the user copied.
 *
 * Word, PowerPoint and Excel put a picture of the selection on the clipboard
 * beside the text, and Chromium hands that bitmap to the paste event as a
 * file. It arrives unnamed or as a bare `image.<ext>`, while a picture the
 * user actually copied in Finder/Explorer keeps its own filename.
 */
const RENDERED_CLIPBOARD_IMAGE_NAME = /^image\.(png|jpe?g|gif|webp|tiff?|bmp)$/i;

const isRenderedClipboardImage = (file: File): boolean => {
  const name = file.name.trim();
  return (
    file.type.trim().toLowerCase().startsWith('image/') &&
    (name === '' || RENDERED_CLIPBOARD_IMAGE_NAME.test(name))
  );
};

/** What a paste should attach, and what it dropped in favour of the text. */
export type PastedClipboardFiles = {
  files: File[];
  renderedImages: File[];
};

/**
 * Decides whether a paste carrying both text and files is a rich-text paste or
 * a file paste.
 *
 * The clipboard holds one payload in several fidelities, and the source app
 * chooses them all; picking the file whenever one exists turned every Word and
 * PowerPoint paste into a screenshot of itself. Text wins when the clipboard
 * has any, but only against the bitmap the source rendered — a real file the
 * user copied is still an attachment, and a screenshot carries no text at all,
 * so neither of those paths notices this rule.
 */
export const selectPastedClipboardFiles = ({
  text,
  files,
}: {
  text: string;
  files: File[];
}): PastedClipboardFiles => {
  if (text.trim() === '') {
    return { files, renderedImages: [] };
  }
  return {
    files: files.filter((file) => !isRenderedClipboardImage(file)),
    renderedImages: files.filter(isRenderedClipboardImage),
  };
};
