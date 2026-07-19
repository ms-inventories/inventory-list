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
  const matches = String(text || "").match(/\b\d[\d\s-]{10,}\d\b/g) || [];
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
    result.set(currentRow.id, {
      latest: matches[0].row,
      latestWithPhotos: matches.find(candidate => Boolean(candidate.row.has_photos ?? candidate.row.hasPhotos))?.row || null,
      historyCount: matches.length,
      matchBasis: matches[0].matchBasis
    });
  });
  return result;
}
