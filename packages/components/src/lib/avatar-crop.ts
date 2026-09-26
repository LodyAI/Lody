import { AVATAR_MAX_SIZE_BYTES } from '@lody/shared';

export type AvatarCropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const AVATAR_OUTPUT_SIZE = 512;
const JPEG_QUALITIES = [0.9, 0.82, 0.72, 0.62] as const;

const loadImage = (source: string): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected image could not be read'));
    image.src = source;
  });
};

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> => {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('The selected image could not be exported'));
        }
      },
      type,
      quality
    );
  });
};

const getOutputType = (file: File): string => {
  if (file.type === 'image/png' || file.type === 'image/webp') {
    return file.type;
  }
  return 'image/jpeg';
};

const getOutputName = (file: File, type: string): string => {
  const baseName = file.name
    .replace(/\.[^./\\]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim();
  const safeBaseName = baseName || 'avatar';
  const extension = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  return `${safeBaseName}-cropped.${extension}`;
};

const drawCrop = (
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  crop: AvatarCropArea,
  outputSize: number,
  fillBackground: boolean
) => {
  if (fillBackground) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, outputSize, outputSize);
  }
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, outputSize, outputSize);
};

/**
 * Export the square selected by react-easy-crop as a small uploadable File.
 * The crop coordinates are in the source image's pixel space, as emitted by
 * the cropper's `onCropComplete` callback.
 */
export const cropAvatarFile = async (
  file: File,
  crop: AvatarCropArea,
  options: { outputSize?: number } = {}
): Promise<File> => {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('Image editing is unavailable in this environment');
  }

  const outputSize = options.outputSize ?? AVATAR_OUTPUT_SIZE;
  if (!Number.isFinite(outputSize) || Math.round(outputSize) <= 0) {
    throw new Error('Invalid image output size');
  }
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) {
    throw new Error('Invalid image crop area');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw new Error('The selected image has no usable dimensions');
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(outputSize);
    canvas.height = Math.round(outputSize);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Image editing is unavailable in this browser');
    }

    const boundedCrop = {
      x: Math.max(0, Math.min(sourceWidth - 1, crop.x)),
      y: Math.max(0, Math.min(sourceHeight - 1, crop.y)),
      width: Math.max(1, Math.min(sourceWidth, crop.width)),
      height: Math.max(1, Math.min(sourceHeight, crop.height)),
    };
    // Keep the crop inside the source when a browser reports a fractional edge
    // just beyond the image due to rounding.
    boundedCrop.width = Math.min(boundedCrop.width, sourceWidth - boundedCrop.x);
    boundedCrop.height = Math.min(boundedCrop.height, sourceHeight - boundedCrop.y);

    let outputType = getOutputType(file);
    let blob: Blob | null = null;
    const fillBackground = outputType === 'image/jpeg';

    if (outputType === 'image/png') {
      drawCrop(context, image, boundedCrop, canvas.width, false);
      blob = await canvasToBlob(canvas, outputType);
    } else {
      drawCrop(context, image, boundedCrop, canvas.width, fillBackground);
      for (const quality of JPEG_QUALITIES) {
        blob = await canvasToBlob(canvas, outputType, quality);
        if (blob.size <= AVATAR_MAX_SIZE_BYTES) break;
      }
    }

    // WebP is not available in every browser. If its encoder falls back to a
    // larger/unsupported result, preserve the image as a JPEG instead of
    // making the upload fail after the user has already edited it.
    if (!blob || blob.type !== outputType || blob.size > AVATAR_MAX_SIZE_BYTES) {
      outputType = 'image/jpeg';
      drawCrop(context, image, boundedCrop, canvas.width, true);
      for (const quality of JPEG_QUALITIES) {
        blob = await canvasToBlob(canvas, outputType, quality);
        if (blob.type === outputType && blob.size <= AVATAR_MAX_SIZE_BYTES) break;
      }
    }

    if (!blob || blob.type !== outputType || blob.size <= 0 || blob.size > AVATAR_MAX_SIZE_BYTES) {
      throw new Error('The edited image is too large to upload');
    }

    return new File([blob], getOutputName(file, outputType), {
      type: outputType,
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};
