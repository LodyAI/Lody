import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

type PdfjsGlobal = typeof globalThis & { pdfjsLib?: typeof pdfjsLib };

(globalThis as PdfjsGlobal).pdfjsLib = pdfjsLib;
