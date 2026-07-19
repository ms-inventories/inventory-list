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
import {
  findPriorInventoryHistoryMatches,
  inventoryHistoryRowsMatch
} from "../src/inventory-history.js";

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
  const first = { id: "first", explicitLin: "A12345", lins: new Set(["A12345"]), nsns: new Set(["1234567890123"]) };
  const second = { id: "second", explicitLin: "A12345", lins: new Set(["A12345"]), nsns: new Set() };
  assert.equal(findUniqueInventoryIdentifierMatch("LIN A12345 radio mount", [first]), first);
  assert.equal(
    findUniqueInventoryIdentifierMatch("000000002 63053N CUTTING MACHINE", [
      { id: "mixed", explicitLin: "63053N", lins: new Set(["63053N"]), nsns: new Set() }
    ])?.id,
    "mixed"
  );
  assert.equal(
    findUniqueInventoryIdentifierMatch("CO5036 COMPRESSOR", [
      { id: "mixed-prefix", explicitLin: "CO5036", lins: new Set(["CO5036"]), nsns: new Set() }
    ])?.id,
    "mixed-prefix"
  );
  assert.equal(findUniqueInventoryIdentifierMatch("LIN A12345 radio mount", [first, second]), null);
  assert.equal(findUniqueInventoryIdentifierMatch("NSN 1234-56-789-0123", [first, second]), first);
  assert.equal(findUniqueInventoryIdentifierMatch("radio mount without an identifier", [first]), null);
  assert.equal(findUniqueInventoryIdentifierMatch("RADIO M12345 MODEL", [
    { id: "model-code", explicitLin: "M12345", lins: new Set(["M12345"]), nsns: new Set() }
  ]), null);
});

test("prior inventory history selects the latest approved row by mixed LIN and exact packet fallback", () => {
  const matches = findPriorInventoryHistoryMatches(
    [
      {
        id: "current-lin",
        packet_line: "000000002 63053N CUTTING MACHINE OXYGEN",
        expected_qty: 4
      },
      {
        id: "current-exact",
        packet_line: "Cable assembly / no stock number"
      },
      {
        id: "current-unmatched",
        packet_line: "Cable assembly different model"
      },
      {
        id: "current-model-code",
        packet_line: "RADIO M12345 MODEL"
      }
    ],
    [
      {
        submission_id: "older-lin",
        packet_line: "63053N CUTTING MACHINE OXYGEN",
        inventoried_at: "2026-05-01T12:00:00.000Z",
        has_photos: true
      },
      {
        submission_id: "newer-lin",
        packet_line: "000000009 63053N CUTTING MACHINE OXYGEN",
        inventoried_at: "2026-06-01T12:00:00.000Z",
        has_photos: false
      },
      {
        submission_id: "exact-fallback",
        packet_line: "CABLE ASSEMBLY - NO STOCK NUMBER",
        inventoried_at: "2026-04-01T12:00:00.000Z"
      },
      {
        submission_id: "similar-is-not-exact",
        packet_line: "Cable assembly another model",
        inventoried_at: "2026-07-01T12:00:00.000Z"
      },
      {
        submission_id: "description-model-code",
        packet_line: "GENERATOR M12345 MODEL",
        inventoried_at: "2026-07-02T12:00:00.000Z"
      }
    ]
  );

  assert.equal(matches.get("current-lin")?.latest.submission_id, "newer-lin");
  assert.equal(matches.get("current-lin")?.historyCount, 2);
  assert.equal(matches.get("current-lin")?.matchBasis, "lin");
  assert.equal(matches.get("current-lin")?.latestWithPhotos?.submission_id, "older-lin");
  assert.equal(matches.get("current-exact")?.latest.submission_id, "exact-fallback");
  assert.equal(matches.get("current-exact")?.historyCount, 1);
  assert.equal(matches.has("current-unmatched"), false);
  assert.equal(matches.has("current-model-code"), false);
  assert.equal(inventoryHistoryRowsMatch(
    { packet_line: "000000002 63053N CUTTING MACHINE" },
    { packet_line: "63053N CUTTING MACHINE" }
  ), true);
  assert.equal(inventoryHistoryRowsMatch(
    { packet_line: "RADIO M12345 MODEL" },
    { packet_line: "GENERATOR M12345 MODEL" }
  ), false);
  assert.equal(inventoryHistoryRowsMatch(
    { packet_line: "000000002", inventory_nsn: "1234-56-789-0123" },
    { packet_line: "1234567890123 MEDICAL SET" }
  ), true);
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

test("rejection return routing keeps submitter and reviewer assignments typed as UUIDs", async () => {
  const routes = await fs.readFile(
    path.resolve(currentDirectory, "../src/routes.js"),
    "utf8"
  );

  assert.match(
    routes,
    /assigned_to = CASE WHEN \$2 = 'submitter' THEN \$3::uuid ELSE NULL END/i
  );
  assert.match(
    routes,
    /assigned_by = CASE WHEN \$2 = 'submitter' THEN \$4::uuid ELSE NULL END/i
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
