import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  parsePacketRows,
  sanitizePacketDraftRows
} from "../react-app/src/lib/packetParser.js";

test("parses clean Army-style packet rows", () => {
  const rows = parsePacketRows(`
Sub Hand Receipt
Date: 2025-12-06
MPO MPO Description
000009148 R20684 RADIAC SET: AN/VDR-2
NSN NSN Description UI CIIC DLA BUoM OH Qty
6665012221425 RADIAC SET AN/VDR-2 EA 7 5156 EA 1
000004336 N96248 NAVIGATION SET: SATELLITE SIGNALS AN/PSN
5825015264763 NAVIGATION SET AN/PSN-13(A) EA 0 1237 EA 4
  `);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(row => ({
      mpo: row.mpo,
      lin: row.lin,
      nsn: row.nsn,
      expectedQty: row.expectedQty,
      confidence: row.confidence
    })),
    [
      {
        mpo: "000009148",
        lin: "R20684",
        nsn: "6665012221425",
        expectedQty: 1,
        confidence: "high"
      },
      {
        mpo: "000004336",
        lin: "N96248",
        nsn: "5825015264763",
        expectedQty: 4,
        confidence: "high"
      }
    ]
  );
});

test("reassembles split PDF extraction lines", () => {
  const rows = parsePacketRows(`
MPO Description
0000186033
M05000
TAMPER,VIBRATING TYPE,INTERNAL COMBUST
NSN Description
3805014824487
TAMPER,VIBRATING TYPE INTERNAL COMBUST EA 0 7317 EA 2
Page 3 of 8
signature block
embedded image 300 x 200
  `);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].mpo, "0000186033");
  assert.equal(rows[0].lin, "M05000");
  assert.equal(rows[0].nsn, "3805014824487");
  assert.equal(rows[0].expectedQty, 2);
  assert.match(rows[0].packetLine, /TAMPER,VIBRATING TYPE/i);
});

test("keeps one-line fallback rows reviewable", () => {
  const rows = parsePacketRows("A90594 ARMAMENT SUBSYS: M153");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].lin, "A90594");
  assert.equal(rows[0].confidence, "high");
  assert.deepEqual(sanitizePacketDraftRows(rows), [
    { packetLine: "A90594 ARMAMENT SUBSYS: M153" }
  ]);
});

test("parses delimited paste rows with quantity and location", () => {
  const rows = parsePacketRows("B67839 BINOCULAR: M24 | 5 | Cage 3, right side");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].lin, "B67839");
  assert.equal(rows[0].expectedQty, 5);
  assert.equal(rows[0].locationHint, "Cage 3, right side");
});

test("parses generated PDF extracted-text fixtures when available", t => {
  const fixtureFiles = [
    "output/pdf/army-packet-clean.txt",
    "output/pdf/army-packet-weird-layout.txt"
  ];
  if (!fixtureFiles.every(file => fs.existsSync(file))) {
    t.skip("Run scripts/generate-packet-fixtures.py to create PDF text fixtures.");
    return;
  }

  for (const file of fixtureFiles) {
    const rows = parsePacketRows(fs.readFileSync(file, "utf8"));
    assert.equal(rows.length, 3, file);
    assert.deepEqual(rows.map(row => row.lin), ["R20684", "N96248", "M05000"], file);
    assert.deepEqual(rows.map(row => row.expectedQty), [1, 4, 2], file);
    assert.ok(rows.every(row => row.confidence === "high"), file);
  }
});
