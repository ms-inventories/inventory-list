import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findUniqueInventoryIdentifierMatch,
  parseSubmissionReviewBody,
  sessionTimingFromRow
} from "../src/routes.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

test("canonical rejection requires a reason and explicit return routing", () => {
  assert.throws(
    () => parseSubmissionReviewBody({ decision: "rejected" }),
    error => {
      assert.deepEqual(
        error.issues.map(issue => issue.path.join(".")),
        ["note", "returnAssignment"]
      );
      return true;
    }
  );

  assert.deepEqual(
    parseSubmissionReviewBody({
      decision: "rejected",
      note: "  Wrong serial-number photo.  ",
      returnAssignment: "submitter"
    }),
    {
      decision: "rejected",
      note: "Wrong serial-number photo.",
      returnAssignment: "submitter"
    }
  );
});

test("return routing cannot be attached to approvals or legacy proof requests", () => {
  assert.throws(
    () => parseSubmissionReviewBody({
      decision: "approved",
      returnAssignment: "unassigned"
    }),
    /Return routing only applies to rejected proof/
  );

  assert.equal(
    parseSubmissionReviewBody({ decision: "request_more_info" }).decision,
    "request_more_info"
  );
});

test("session timing derives completion only when every row reached a completed state", () => {
  const completed = sessionTimingFromRow({
    started_at: "2026-07-18T12:00:00.000Z",
    closed_at: "2026-07-18T12:42:00.000Z",
    item_count: 27,
    found_count: 27,
    last_item_updated_at: "2026-07-18T12:35:00.000Z"
  });

  assert.equal(completed.completedAt, "2026-07-18T12:35:00.000Z");
  assert.equal(completed.durationToCompletionSeconds, 35 * 60);
  assert.equal(completed.durationToCloseSeconds, 42 * 60);

  const incomplete = sessionTimingFromRow({
    started_at: "2026-07-18T12:00:00.000Z",
    item_count: 27,
    found_count: 26,
    last_item_updated_at: "2026-07-18T12:35:00.000Z"
  });
  assert.equal(incomplete.completedAt, null);
  assert.equal(incomplete.durationToCompletionSeconds, null);
});

test("automatic history reuse requires one unique saved LIN or NSN", () => {
  const first = { id: "first", lins: new Set(["A12345"]), nsns: new Set(["1234567890123"]) };
  const second = { id: "second", lins: new Set(["A12345"]), nsns: new Set() };
  assert.equal(findUniqueInventoryIdentifierMatch("LIN A12345 radio mount", [first]), first);
  assert.equal(findUniqueInventoryIdentifierMatch("LIN A12345 radio mount", [first, second]), null);
  assert.equal(findUniqueInventoryIdentifierMatch("NSN 1234-56-789-0123", [first, second]), first);
  assert.equal(findUniqueInventoryIdentifierMatch("radio mount without an identifier", [first]), null);
});

test("a new proof submission clears stale direct-check attribution", async () => {
  const routes = await fs.readFile(
    path.resolve(currentDirectory, "../src/routes.js"),
    "utf8"
  );

  assert.match(
    routes,
    /UPDATE inventory_session_items\s+SET status = 'needs_review',\s+direct_verified_by = NULL,\s+updated_at = now\(\)\s+WHERE id = \$1/i
  );
});

test("a direct check closes proof requests superseded by the terminal result", async () => {
  const routes = await fs.readFile(
    path.resolve(currentDirectory, "../src/routes.js"),
    "utf8"
  );

  assert.match(
    routes,
    /WITH superseded AS \(\s+UPDATE item_submissions\s+SET review_state = 'superseded',[\s\S]*?review_state IN \('pending', 'request_more_info', 'rejected'\)[\s\S]*?UPDATE evidence_requests\s+SET resolved_at = COALESCE\(resolved_at, now\(\)\)\s+WHERE submission_id IN \(SELECT id FROM superseded\)\s+AND resolved_at IS NULL/i
  );
});

test("workflow migration preserves immutable history with explicit terminal states", async () => {
  const migration = await fs.readFile(
    path.resolve(currentDirectory, "../db/025_submission_withdrawal_and_session_timing.sql"),
    "utf8"
  );

  assert.match(migration, /'withdrawn'/);
  assert.match(migration, /review_return_route/);
  assert.match(migration, /withdrawn_at/);
  assert.match(migration, /started_at/);
  assert.match(migration, /completed_at/);
  assert.match(migration, /record_inventory_session_completion/);
  assert.match(migration, /'found', 'not_found', 'mismatch', 'approved'/);
  assert.match(migration, /ELSE NULL\s+END\s+WHERE session\.id = target_session_id/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+(?:item_submissions|submission_photos)/i);
});
