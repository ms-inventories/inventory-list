import crypto from "node:crypto";

function normalizeIdentifier(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function normalizeInventoryHistoryText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLinToken(value) {
  return /^[A-Z0-9]{6}$/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

export function extractPrimaryInventoryLinValues(text) {
  const tokens = normalizeInventoryHistoryText(text).split(" ").filter(Boolean);
  const values = new Set();
  const labeledIndex = tokens.findIndex(token => token === "LIN");

  if (labeledIndex >= 0 && isLinToken(tokens[labeledIndex + 1] || "")) {
    values.add(tokens[labeledIndex + 1]);
  }
  if (/^\d{6,10}$/.test(tokens[0] || "") && isLinToken(tokens[1] || "")) {
    values.add(tokens[1]);
  } else if (isLinToken(tokens[0] || "")) {
    values.add(tokens[0]);
  }
  return values;
}

function extractNsnValues(text) {
  const values = new Set();
  const matches = String(text || "").match(/\b\d{4}[\s-]*\d{2}[\s-]*\d{3}[\s-]*\d{4}\b/g) || [];
  matches.forEach(value => {
    const digits = normalizeDigits(value);
    if (digits.length === 13) values.add(digits);
  });
  return values;
}

export function inventoryHistoryMatchProfile(row) {
  const packetLine = String(row?.packet_line ?? row?.packetLine ?? "").trim();
  const lins = extractPrimaryInventoryLinValues(packetLine);
  [row?.inventory_lin, row?.lin, row?.item_lin].forEach(value => {
    const normalized = normalizeIdentifier(value);
    if (isLinToken(normalized)) lins.add(normalized);
  });
  const nsns = extractNsnValues(packetLine);
  [row?.inventory_nsn, row?.nsn, row?.item_nsn].forEach(value => {
    const normalized = normalizeDigits(value);
    if (normalized.length === 13) nsns.add(normalized);
  });

  return {
    inventoryItemId: row?.inventory_item_id ?? row?.inventoryItemId ?? null,
    packetLine: normalizeInventoryHistoryText(packetLine),
    lins,
    nsns
  };
}

function setsOverlap(first, second) {
  return [...first].some(value => second.has(value));
}

export function inventoryHistoryMatchBasis(firstRow, secondRow) {
  const first = inventoryHistoryMatchProfile(firstRow);
  const second = inventoryHistoryMatchProfile(secondRow);
  if (
    first.inventoryItemId
    && second.inventoryItemId
    && first.inventoryItemId === second.inventoryItemId
  ) return "saved_item";

  const nsnMatch = setsOverlap(first.nsns, second.nsns);
  const linMatch = setsOverlap(first.lins, second.lins);
  if (nsnMatch) return "nsn";
  if (linMatch && !(first.nsns.size && second.nsns.size)) return "lin";

  if (!first.packetLine || first.packetLine !== second.packetLine) return null;
  const conflictingLin = first.lins.size && second.lins.size && !linMatch;
  const conflictingNsn = first.nsns.size && second.nsns.size && !nsnMatch;
  return !conflictingLin && !conflictingNsn ? "packet_line" : null;
}

export function inventoryHistoryRowsMatch(firstRow, secondRow) {
  return Boolean(inventoryHistoryMatchBasis(firstRow, secondRow));
}

function historyTimestamp(row) {
  const preciseOrder = Number(row?.inventoried_order ?? row?.inventoriedOrder);
  if (Number.isFinite(preciseOrder)) return preciseOrder;
  const value = row?.inventoried_at ?? row?.inventoriedAt ?? row?.created_at ?? row?.createdAt;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function addCandidate(index, key, candidate) {
  if (!key) return;
  const matches = index.get(key) || [];
  matches.push(candidate);
  index.set(key, matches);
}

export function inventoryHistoryCandidateKeys(rows) {
  const inventoryItemIds = new Set();
  const packetLines = new Set();
  const lins = new Set();
  const nsns = new Set();
  (rows || []).forEach(row => {
    const profile = inventoryHistoryMatchProfile(row);
    if (profile.inventoryItemId) inventoryItemIds.add(profile.inventoryItemId);
    if (profile.packetLine) packetLines.add(profile.packetLine);
    profile.lins.forEach(value => lins.add(value));
    profile.nsns.forEach(value => nsns.add(value));
  });
  return {
    inventoryItemIds: [...inventoryItemIds],
    packetLines: [...packetLines],
    lins: [...lins],
    nsns: [...nsns]
  };
}

export function findPriorInventoryHistoryMatches(currentRows, priorApprovedRows) {
  const candidates = (priorApprovedRows || [])
    .map(row => ({ row, profile: inventoryHistoryMatchProfile(row) }))
    .sort((first, second) => (
      historyTimestamp(second.row) - historyTimestamp(first.row)
      || String(second.row.submission_id || second.row.id || "").localeCompare(String(first.row.submission_id || first.row.id || ""))
    ))
    .map((candidate, order) => ({ ...candidate, order }));
  const indexes = {
    inventoryItemIds: new Map(),
    packetLines: new Map(),
    lins: new Map(),
    nsns: new Map()
  };
  candidates.forEach(candidate => {
    addCandidate(indexes.inventoryItemIds, candidate.profile.inventoryItemId, candidate);
    addCandidate(indexes.packetLines, candidate.profile.packetLine, candidate);
    candidate.profile.lins.forEach(value => addCandidate(indexes.lins, value, candidate));
    candidate.profile.nsns.forEach(value => addCandidate(indexes.nsns, value, candidate));
  });

  const result = new Map();
  (currentRows || []).forEach(currentRow => {
    const current = inventoryHistoryMatchProfile(currentRow);
    const possible = new Set();
    (indexes.inventoryItemIds.get(current.inventoryItemId) || []).forEach(candidate => possible.add(candidate));
    (indexes.packetLines.get(current.packetLine) || []).forEach(candidate => possible.add(candidate));
    current.lins.forEach(value => (indexes.lins.get(value) || []).forEach(candidate => possible.add(candidate)));
    current.nsns.forEach(value => (indexes.nsns.get(value) || []).forEach(candidate => possible.add(candidate)));
    const matches = [...possible]
      .sort((first, second) => first.order - second.order)
      .map(candidate => ({
        ...candidate,
        matchBasis: inventoryHistoryMatchBasis(currentRow, candidate.row)
      }))
      .filter(candidate => candidate.matchBasis);
    if (!matches.length) return;
    const foundMatches = matches.filter(candidate => (
      String(candidate.row.submission_status ?? candidate.row.submissionStatus ?? "").toLowerCase() === "found"
    ));
    result.set(currentRow.id, {
      latest: matches[0].row,
      lastFound: foundMatches[0]?.row || null,
      latestWithPhotos: foundMatches.find(candidate => Boolean(
        candidate.row.has_photos ?? candidate.row.hasPhotos
      ))?.row || null,
      historyCount: matches.length,
      matchBasis: matches[0].matchBasis
    });
  });
  return result;
}

function equipmentLibraryRowId(row) {
  return String(row?.submission_id ?? row?.id ?? "").trim();
}

function equipmentLibraryIdentity(kind, value) {
  return { kind, value: String(value || "") };
}

export function equipmentLibraryEntryKey(tenantNamespace, identity) {
  const namespace = String(tenantNamespace || "").trim();
  const kind = String(identity?.kind || "").trim();
  const value = String(identity?.value || "").trim();
  if (!namespace || !kind || !value) {
    throw new Error("Equipment library keys require a tenant namespace and canonical identity.");
  }
  const digest = crypto
    .createHash("sha256")
    .update(`equipment-library:v1\0${namespace}\0${kind}\0${value}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
  return `eql_${digest}`;
}

function sortedValues(values) {
  return [...values].sort((first, second) => first.localeCompare(second));
}

function equipmentLibraryCanonicalIdentity(candidate, linToNsns) {
  const { rowId, profile } = candidate;
  const nsns = sortedValues(profile.nsns);
  const lins = sortedValues(profile.lins);

  if (nsns.length === 1) {
    return {
      identity: equipmentLibraryIdentity("nsn", nsns[0]),
      basis: "nsn",
      issues: []
    };
  }
  if (nsns.length > 1) {
    return {
      identity: equipmentLibraryIdentity("isolated", rowId),
      basis: "isolated",
      issues: ["conflicting_nsns"]
    };
  }

  if (lins.length === 1) {
    const mappedNsns = sortedValues(linToNsns.get(lins[0]) || new Set());
    if (mappedNsns.length === 1) {
      return {
        identity: equipmentLibraryIdentity("nsn", mappedNsns[0]),
        basis: "lin_to_unique_nsn",
        issues: []
      };
    }
    return {
      identity: equipmentLibraryIdentity("lin", lins[0]),
      basis: "lin",
      issues: mappedNsns.length > 1 ? ["ambiguous_lin"] : []
    };
  }
  if (lins.length > 1) {
    return {
      identity: equipmentLibraryIdentity("isolated", rowId),
      basis: "isolated",
      issues: ["conflicting_lins"]
    };
  }

  if (profile.packetLine) {
    return {
      identity: equipmentLibraryIdentity("packet_line", profile.packetLine),
      basis: "packet_line",
      issues: []
    };
  }
  return {
    identity: equipmentLibraryIdentity("isolated", rowId),
    basis: "isolated",
    issues: ["missing_identity"]
  };
}

/**
 * Build tenant-scoped equipment-type groups from approved observations.
 *
 * This deliberately does not use pairwise history matching or union-find. A
 * LIN-only row can match either of two rows carrying different NSNs, even
 * though those two NSN rows must never be merged. The global LIN-to-NSN map
 * below only promotes a LIN when the evidence maps it to one unique NSN.
 */
export function buildEquipmentLibraryGroups(rows, { tenantNamespace } = {}) {
  const seenRowIds = new Set();
  const candidates = (rows || []).map(row => {
    const rowId = equipmentLibraryRowId(row);
    if (!rowId) throw new Error("Equipment library observations require a stable ID.");
    if (seenRowIds.has(rowId)) throw new Error(`Duplicate equipment library observation ID: ${rowId}`);
    seenRowIds.add(rowId);
    return { row, rowId, profile: inventoryHistoryMatchProfile(row) };
  });

  const linToNsns = new Map();
  candidates.forEach(candidate => {
    const nsns = sortedValues(candidate.profile.nsns);
    const lins = sortedValues(candidate.profile.lins);
    if (nsns.length !== 1 || lins.length !== 1) return;
    const mapped = linToNsns.get(lins[0]) || new Set();
    mapped.add(nsns[0]);
    linToNsns.set(lins[0], mapped);
  });

  const groupsByIdentity = new Map();
  const assignments = new Map();
  candidates.forEach(candidate => {
    const assignment = equipmentLibraryCanonicalIdentity(candidate, linToNsns);
    const canonicalIdentity = `${assignment.identity.kind}:${assignment.identity.value}`;
    const key = equipmentLibraryEntryKey(tenantNamespace, assignment.identity);
    const publicAssignment = {
      key,
      identity: assignment.identity,
      basis: assignment.basis,
      issues: assignment.issues
    };
    assignments.set(candidate.rowId, publicAssignment);

    const group = groupsByIdentity.get(canonicalIdentity) || {
      key,
      identity: assignment.identity,
      rows: [],
      rowIds: [],
      bases: new Set(),
      issues: new Set()
    };
    group.rows.push(candidate.row);
    group.rowIds.push(candidate.rowId);
    group.bases.add(assignment.basis);
    assignment.issues.forEach(issue => group.issues.add(issue));
    groupsByIdentity.set(canonicalIdentity, group);
  });

  const groups = [...groupsByIdentity.values()]
    .map(group => ({
      ...group,
      rows: [...group.rows].sort((first, second) => (
        historyTimestamp(second) - historyTimestamp(first)
      )),
      rowIds: [...group.rowIds].sort(),
      bases: [...group.bases].sort(),
      issues: [...group.issues].sort()
    }))
    .sort((first, second) => first.key.localeCompare(second.key));

  return { groups, assignments };
}
