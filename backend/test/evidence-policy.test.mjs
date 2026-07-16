import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSavedEvidenceMediaUploadIds,
  evidenceSubmissionPhotoLimit,
  normalizeEvidenceSerialNumber,
  parseEvidenceSubmissionBody,
  savedInventoryPhotoLimit
} from "../src/routes.js";

const uploadId = index => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("evidence accepts a meaningful accountability note without photos or a serial number", () => {
  const submission = parseEvidenceSubmissionBody({
    status: "found",
    note: "  Accounted for by SSG Smith at the maintenance shop.  "
  });

  assert.equal(submission.note, "Accounted for by SSG Smith at the maintenance shop.");
  assert.equal(submission.serialNumber, undefined);
  assert.deepEqual(submission.photos, undefined);
});

test("non-serialized placeholders become null while actual serial numbers are preserved", () => {
  for (const placeholder of ["", " NA ", "n/a", "None", "not applicable", "not   serialized", "unserialized"]) {
    assert.equal(normalizeEvidenceSerialNumber(placeholder), null);
  }
  assert.equal(normalizeEvidenceSerialNumber("  SN-04-A  "), "SN-04-A");
  assert.equal(
    parseEvidenceSubmissionBody({ status: "found", note: "Verified by supply", serialNumber: " N/A " }).serialNumber,
    null
  );
});

test("every photo-free evidence status requires a trimmed meaningful note", () => {
  for (const status of ["found", "not_found", "mismatch", "needs_review"]) {
    assert.throws(
      () => parseEvidenceSubmissionBody({ status, note: "  too short  " }),
      /at least one photo or an accountability note with at least 12 characters/i
    );
    assert.equal(
      parseEvidenceSubmissionBody({ status, note: " Verified by HQ " }).note,
      "Verified by HQ"
    );
  }
});

test("photo-backed evidence remains valid without a note and is capped at ten uploads", () => {
  const photos = Array.from({ length: evidenceSubmissionPhotoLimit }, (_, index) => ({
    uploadId: uploadId(index + 1),
    kind: "general"
  }));

  assert.equal(parseEvidenceSubmissionBody({ status: "found", photos }).photos.length, 10);
  assert.throws(
    () => parseEvidenceSubmissionBody({
      status: "found",
      photos: [...photos, { uploadId: uploadId(11), kind: "general" }]
    }),
    /too_big|array must contain at most 10 element/i
  );
});

test("canonical item defaults preserve only existing references and support note-only evidence", () => {
  assert.equal(savedInventoryPhotoLimit, 3);
  assert.deepEqual(defaultSavedEvidenceMediaUploadIds([], []), []);
  assert.deepEqual(
    defaultSavedEvidenceMediaUploadIds([uploadId(1), uploadId(2), uploadId(1), uploadId(3), uploadId(4)]),
    [uploadId(1), uploadId(2), uploadId(3)]
  );
});

test("new submission photos are not promoted to canonical references without an explicit selection", () => {
  const currentSubmissionPhotos = [uploadId(4), uploadId(5)];
  assert.deepEqual(defaultSavedEvidenceMediaUploadIds([], currentSubmissionPhotos), []);
  assert.deepEqual(
    defaultSavedEvidenceMediaUploadIds([uploadId(1)], currentSubmissionPhotos),
    [uploadId(1)]
  );
});
