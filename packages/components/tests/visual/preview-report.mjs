/** Keep a self-contained report's original PNGs while bounding preview bitmap size. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const reportIndex = args.indexOf('--report');
if (reportIndex < 0 || !args[reportIndex + 1])
  throw new Error('--report <generated.html> required');
const reportPath = path.resolve(args[reportIndex + 1]);
const originalHtml = await readFile(reportPath, 'utf8');
if (originalHtml.includes('id="report-original-images"'))
  throw new Error('Report already has bounded previews');
const hash = (input) => createHash('sha256').update(input).digest('hex');
const pngPattern = /<img\b([^>]*?)src="(data:image\/png;base64,[A-Za-z0-9+/=]+)"([^>]*?)>/g;
const urls = [...new Set([...originalHtml.matchAll(pngPattern)].map((match) => match[2]))];
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const originals = {};
const previews = new Map();
const records = [];
try {
  for (const dataUrl of urls) {
    const originalSha256 = hash(Buffer.from(dataUrl.split(',')[1], 'base64'));
    const result = await page.evaluate(async (source) => {
      const bitmap = await createImageBitmap(await (await fetch(source)).blob());
      try {
        const ratio = Math.min(1, 480 / bitmap.width, 960 / bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * ratio));
        const height = Math.max(1, Math.round(bitmap.height * ratio));
        if (ratio === 1)
          return {
            width,
            height,
            originalWidth: bitmap.width,
            originalHeight: bitmap.height,
            dataUrl: source,
          };
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, width, height);
        const preview = canvas.toDataURL('image/webp', 0.92);
        canvas.width = 0;
        canvas.height = 0;
        return {
          width,
          height,
          originalWidth: bitmap.width,
          originalHeight: bitmap.height,
          dataUrl: preview,
        };
      } finally {
        bitmap.close();
      }
    }, dataUrl);
    originals[originalSha256] = {
      src: dataUrl,
      width: result.originalWidth,
      height: result.originalHeight,
    };
    previews.set(dataUrl, { ...result, originalSha256 });
    records.push({
      originalSha256,
      originalWidth: result.originalWidth,
      originalHeight: result.originalHeight,
      previewWidth: result.width,
      previewHeight: result.height,
      previewSha256: hash(Buffer.from(result.dataUrl.split(',')[1], 'base64')),
    });
  }
} finally {
  await browser.close();
}
let referenceCount = 0;
let html = originalHtml.replace(pngPattern, (_match, before, dataUrl, after) => {
  const preview = previews.get(dataUrl);
  referenceCount++;
  return `<img${before}data-original-sha="${preview.originalSha256}" width="${preview.width}" height="${preview.height}" src="${preview.dataUrl}"${after}>`;
});
const scriptStart = '<script>\nconst viewer =';
if (!html.includes(scriptStart) || !html.includes('  fullImage.src = image.src;'))
  throw new Error('Unexpected report viewer contract');
html = html.replace(
  scriptStart,
  `<script id="report-original-images" type="application/json">${JSON.stringify(originals)}</script>\n<script>\nconst reportOriginalImages = JSON.parse(document.getElementById('report-original-images').textContent);\nconst viewer =`
);
html = html.replace(
  '  fullImage.src = image.src;',
  '  fullImage.src = reportOriginalImages[image.dataset.originalSha]?.src || image.src;'
);
html = html.replace(
  '<main>',
  '<main>\n<p class="note" data-preview-explanation>预览使用真实截图的缩放/压缩缩略图以限制内存；像素判断请点击完整内嵌原图。差异 mask 为真实截图派生对比图，单独标注。</p>'
);
const backupPath = reportPath.replace(/\.html$/, '-full-previews.html');
await writeFile(backupPath, originalHtml);
await writeFile(reportPath, html);
const manifestPath = reportPath.replace(/\.html$/, '-previews.json');
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      report: path.basename(reportPath),
      sourceReportSha256: hash(originalHtml),
      outputReportSha256: hash(html),
      sourceBytes: Buffer.byteLength(originalHtml),
      outputBytes: Buffer.byteLength(html),
      sourceBackup: path.basename(backupPath),
      originalReferenceCount: referenceCount,
      uniqueOriginalPngs: urls.length,
      previewMaxWidth: 480,
      previewMaxHeight: 960,
      method:
        'Real-browser canvas downscaling for display only. Complete source PNG bytes remain embedded once per SHA, and the original-size viewer loads those unchanged bytes.',
      records,
    },
    null,
    2
  )
);
console.log({
  report: reportPath,
  references: referenceCount,
  originals: urls.length,
  bytes: Buffer.byteLength(html),
  sha256: hash(html),
});
