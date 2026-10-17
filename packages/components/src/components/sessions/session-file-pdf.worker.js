// Build this entry through the host's worker pipeline so its compatibility
// prelude also runs in PDF.js. A raw ?url import bypasses worker transforms.
// Retain the export for PDF.js's main-thread fallback when Workers are blocked.
export { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
