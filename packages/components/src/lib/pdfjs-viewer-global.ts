import * as pdfjsLib from 'pdfjs-dist';

type PdfjsGlobal = typeof globalThis & { pdfjsLib?: typeof pdfjsLib };

(globalThis as PdfjsGlobal).pdfjsLib = pdfjsLib;
