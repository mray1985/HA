/**
 * Where pdf.js finds the standard fonts a PDF names without embedding them
 * (public/pdfjs-standard-fonts, copied from pdfjs-dist/standard_fonts). Without
 * them pdf.js substitutes whatever system fonts the computer has (and warns for
 * each), so the page images the readers see depend on the machine; with them
 * every page renders the same everywhere. Pass to every getDocument call.
 */
export const PDFJS_DOCUMENT_OPTIONS = { standardFontDataUrl: '/pdfjs-standard-fonts/' } as const;
