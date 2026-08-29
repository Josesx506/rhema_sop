/**
 * pdfjs-dist ships no type declarations for its worker bundle. Importing it
 * into the MAIN thread (it sets globalThis.pdfjsWorker on evaluation) is how
 * pdf.js is forced into worker-less mode — see src/lib/slides/pdf-import.ts.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs"
