/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lody/shared', () => ({ AVATAR_MAX_SIZE_BYTES: 1 * 1024 * 1024 }));

import { cropAvatarFile } from '../src/lib/avatar-crop';

class TestImage {
  naturalWidth = 1600;
  naturalHeight = 900;
  width = this.naturalWidth;
  height = this.naturalHeight;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

describe('cropAvatarFile', () => {
  const drawImage = vi.fn();
  const fillRect = vi.fn();
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
  const createObjectURL = vi.fn(() => 'blob:avatar-source');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('Image', TestImage);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    getContext.mockReturnValue({ drawImage, fillRect } as unknown as CanvasRenderingContext2D);
    toBlob.mockImplementation((callback, type) => {
      callback(new Blob(['cropped'], { type: type ?? 'image/png' }));
    });
  });

  afterEach(() => {
    drawImage.mockReset();
    fillRect.mockReset();
    getContext.mockReset();
    toBlob.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.unstubAllGlobals();
  });

  it('exports the selected source rectangle as a square PNG file', async () => {
    const file = new File(['source'], 'portrait.png', { type: 'image/png' });

    const cropped = await cropAvatarFile(file, { x: 100, y: 50, width: 700, height: 700 });

    expect(cropped.name).toBe('portrait-cropped.png');
    expect(cropped.type).toBe('image/png');
    expect(cropped.size).toBeGreaterThan(0);
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(TestImage),
      100,
      50,
      700,
      700,
      0,
      0,
      512,
      512
    );
    expect(fillRect).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:avatar-source');
  });

  it('keeps JPEG uploads under the avatar limit and paints an opaque background', async () => {
    const file = new File(['source'], 'photo.jpg', { type: 'image/jpeg' });

    const cropped = await cropAvatarFile(file, { x: -10, y: 1000, width: 900, height: 900 });

    expect(cropped.name).toBe('photo-cropped.jpg');
    expect(cropped.type).toBe('image/jpeg');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 512, 512);
    expect(drawImage).toHaveBeenCalledWith(expect.any(TestImage), 0, 899, 900, 1, 0, 0, 512, 512);
  });
});
