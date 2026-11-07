/**
 * `previewKind` decides whether the invoice review page frames a PDF, shows an
 * `<img>`, or declines to preview. The failure it guards is quiet: a wrong kind
 * does not throw, it renders a blank pane (an iframe over an image or a
 * `.heic`) or a 404 pane (a link to a file that was never stored).
 */
import { describe, expect, test } from "bun:test";
import { previewKind } from "@/lib/invoice-preview";

describe("previewKind", () => {
  test("no stored file is none, however it is spelled", () => {
    expect(previewKind(null)).toBe("none");
    expect(previewKind(undefined)).toBe("none");
    expect(previewKind("")).toBe("none");
  });

  test("a pdf is framed, case-insensitively", () => {
    expect(previewKind("org-1/inv-5/abc.pdf")).toBe("pdf");
    expect(previewKind("invoice.PDF")).toBe("pdf");
  });

  test("the photo formats Claude Vision reads are shown as images", () => {
    expect(previewKind("a.jpg")).toBe("image");
    expect(previewKind("a.jpeg")).toBe("image");
    expect(previewKind("a.JPG")).toBe("image");
    expect(previewKind("a.png")).toBe("image");
    expect(previewKind("a.webp")).toBe("image");
  });

  test("a stored heic is unsupported: no browser iframe or img draws it", () => {
    expect(previewKind("org-1/inv-5/abc.heic")).toBe("unsupported");
  });

  test("an unknown or missing extension is unsupported, never guessed as a pdf", () => {
    expect(previewKind("abc.bin")).toBe("unsupported");
    expect(previewKind("abc")).toBe("unsupported");
    expect(previewKind("org-1.v2/inv-5/abc")).toBe("unsupported");
  });

  test("a nested storage key resolves on its final extension", () => {
    expect(previewKind("org-1/inv-5/abc.jpg")).toBe("image");
    expect(previewKind("org-1/inv-5/abc.pdf")).toBe("pdf");
  });
});
