/**
 * Registry of deterministic OCR vendor templates. One file per vendor; add the
 * template here to make `extractWithOcrTemplate` consider it.
 *
 * The registry is an ordered list, but order never decides a conflict: if two
 * templates claim the same document the engine refuses both (see
 * `engine.ts`). Only add a template with synthetic golden fixtures and a
 * passing cross-DPI replay, per `docs/plans/pdf-ocr-spike/findings.md`.
 *
 * No template exists for the phone-photo layout of the same vendor: its OCR
 * reading order detaches the NET/TOTAL columns from their rows, so a correct
 * pairing cannot be derived without guessing. That document returns
 * `ok: false` and goes to Claude Vision, which is the intended outcome.
 */
import type { OcrVendorTemplate } from "../types";
import { draftDistributorScanned } from "./draft-distributor-scanned";

export const OCR_TEMPLATES: readonly OcrVendorTemplate[] = [draftDistributorScanned];
