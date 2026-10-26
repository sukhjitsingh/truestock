import { contentTypeForPath, isVisionImageContentType } from "@/lib/storage/invoice-content-types";

/**
 * How the invoice review page should show the stored source document.
 *
 * - `none` — the row has no stored file; nothing to frame or link to.
 * - `pdf` — the browser's built-in PDF viewer, in an `<iframe>`.
 * - `image` — an `<img>`. An image in an iframe has no fit-to-width and is
 *   hard to pinch on a phone; the Vision photo types are the ones a manager
 *   uploads from a phone camera.
 * - `unsupported` — a file the review pane can't render: a `.heic` stored
 *   before HEIC was refused at upload (no browser's iframe draws it, so the
 *   pane would sit blank), or an extension we don't recognise at all. The
 *   page offers the "Open file" link instead of a blank pane.
 *
 * The stored extension is the only record of the file's type (the `invoice`
 * row keeps `file_path`, not the declared content type), so this derives the
 * kind from `contentTypeForPath` rather than re-parsing extensions here. An
 * unknown type deliberately falls to `unsupported`, never to `pdf`: guessing
 * "it's probably a PDF" is what put a blank iframe on screen in the first place.
 *
 * Pure and import-light (the one import is itself zero-import) so the review
 * form, a client component, can use it.
 */
export type InvoicePreviewKind = "none" | "pdf" | "image" | "unsupported";

export function previewKind(filePath: string | null | undefined): InvoicePreviewKind {
  if (!filePath) {
    return "none";
  }
  const contentType = contentTypeForPath(filePath);
  if (contentType === "application/pdf") {
    return "pdf";
  }
  if (contentType !== null && isVisionImageContentType(contentType)) {
    return "image";
  }
  return "unsupported";
}
