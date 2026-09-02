// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readDroppedTransfer, splitImageAndFileAttachments } from '../src/lib/file-drop';

type FakeItem = {
  kind: string;
  getAsFile: () => File | null;
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
};

function fileItem(file: File, entry?: { isDirectory: boolean } | null): FakeItem {
  return {
    kind: 'file',
    getAsFile: () => file,
    ...(entry === undefined ? {} : { webkitGetAsEntry: () => entry }),
  };
}

describe('splitImageAndFileAttachments', () => {
  it('routes picker selections by MIME type rather than filename', () => {
    const imageWithTextExtension = new File(['image'], 'preview.txt', { type: 'image/png' });
    const fileWithImageExtension = new File(['document'], 'report.png', {
      type: 'application/pdf',
    });
    const fileWithoutMime = new File(['data'], 'archive.bin');

    expect(
      splitImageAndFileAttachments([
        imageWithTextExtension,
        fileWithImageExtension,
        fileWithoutMime,
      ])
    ).toEqual({
      images: [imageWithTextExtension],
      attachments: [fileWithImageExtension, fileWithoutMime],
    });
  });
});

describe('readDroppedTransfer', () => {
  it('keeps a dropped folder out of the attachment list', () => {
    // A folder arrives as a File with no type and the folder's name, exactly
    // like a typeless file; only the entry API tells them apart.
    const folder = new File([], 'src');
    const typelessFile = new File(['data'], 'Makefile');
    const image = new File(['png'], 'shot.png', { type: 'image/png' });

    expect(
      readDroppedTransfer({
        items: [
          fileItem(folder, { isDirectory: true }),
          fileItem(typelessFile, { isDirectory: false }),
          fileItem(image, { isDirectory: false }),
          { kind: 'string', getAsFile: () => null },
        ],
        files: [folder, typelessFile, image],
      })
    ).toEqual({ files: [typelessFile, image], directories: [folder] });
  });

  it('treats every item as a file where the entry API is missing', () => {
    const file = new File(['data'], 'notes.txt');
    expect(readDroppedTransfer({ items: [fileItem(file)], files: [file] })).toEqual({
      files: [file],
      directories: [],
    });
  });

  it('falls back to the files list when items carry nothing', () => {
    const file = new File(['data'], 'notes.txt');
    expect(readDroppedTransfer({ items: [], files: [file] })).toEqual({
      files: [file],
      directories: [],
    });
  });
});
