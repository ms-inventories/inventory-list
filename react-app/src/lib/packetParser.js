const HEADER_PATTERNS = [
  /\bsub hand receipt\b/i,
  /\bresponsible officer\b/i,
  /\bdepartment of the army\b/i,
  /\bnational guard\b/i,
  /\bmpo description\b/i,
  /\bnsn description\b/i,
  /\bserno\/regno\/lotno\b/i,
  /\bsysno\b/i,
  /\bfrom:\b/i,
  /\bto:\b/i,
  /\bfe:\b/i,
  /\buic:\b/i,
  /\bdate:\b/i,
  /\btime:\b/i,
  /\bpage\s+\d+\s+of\s+\d+\b/i
];

const NOISE_WORDS = [
  "signature",
  "signed",
  "stamp",
  "watermark",
  "photo",
  "image",
  "jpeg",
  "jpg",
  "png",
  "scan",
  "clipboard"
];

const ITEM_WORD_PATTERN = /\b(armament|antenna|battlefield|binocular|chemical|cutting|detector|device|generator|group|kit|load|machine|navigation|radiac|radio|set|subsys|system|tamper|tool|trailer|training|truck|vehicle)\b/i;
const LIN_PATTERN = /^[A-Z0-9]{5,8}$/i;
const MPO_PATTERN = /^\d{6,10}$/;
const NSN_PATTERN = /^[A-Z0-9]{13}$/i;
const UI_PATTERN = /^(ea|ft|gl|hd|kt|lb|pr|rl|se|st)$/i;
const CIIC_PATTERN = /^[A-Z0-9]$/i;

export function normalizePacketImportLine(line) {
  return String(line || "")
    .replace(/[|]/g, " ")
    .replace(/\bMPO\s+Description\b/gi, "")
    .replace(/\bNSN\s+Description\b/gi, "")
    .replace(/\bSerNo\/RegNo\/LotNo\b/gi, "")
    .replace(/\bOH\s+Qty\b/gi, "OH Qty")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(token) {
  return String(token || "")
    .replace(/^[^\w]+|[^\w-]+$/g, "")
    .trim();
}

function tokenLooksLikeLin(token) {
  const value = normalizeToken(token);
  return LIN_PATTERN.test(value) && /[A-Z]/i.test(value) && /\d/.test(value);
}

function tokenLooksLikeMpo(token) {
  return MPO_PATTERN.test(normalizeToken(token));
}

function tokenLooksLikeNsn(token) {
  const value = normalizeToken(token);
  const digitCount = (value.match(/\d/g) || []).length;
  return NSN_PATTERN.test(value) && digitCount >= 8;
}

function compactRowText(row) {
  return [row.mpo, row.lin, row.description || row.packetLine]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPacketDescription(value) {
  return normalizePacketImportLine(value)
    .replace(/\b(signature|signed|stamp|watermark|embedded photo|photo|image)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowKey(row) {
  return [
    row.mpo || "",
    row.lin || "",
    row.nsn || "",
    row.description || row.packetLine || ""
  ].join("|").toLowerCase();
}

export function isPacketImportNoiseLine(line) {
  const value = normalizePacketImportLine(line).toLowerCase();
  if (!value || value.length < 4) return true;
  if (HEADER_PATTERNS.some(pattern => pattern.test(value))) return true;
  if (/^(from|to|fe|uic|date|time|page|sysno|nsn|ui|ciic|dla|buom|oh qty)\b/.test(value)) return true;
  if (/^(mpo|serno|regno|lotno)\b/.test(value)) return true;
  if (/^\d+$/.test(value.replace(/\s+/g, "")) && value.replace(/\s+/g, "").length < 11) return true;
  if (/^[a-z]{1,3}$/i.test(value)) return true;
  if (NOISE_WORDS.some(word => value.includes(word)) && !ITEM_WORD_PATTERN.test(value)) return true;

  const alphaCount = (value.match(/[a-z]/gi) || []).length;
  const digitCount = (value.match(/\d/g) || []).length;
  if (alphaCount <= 2 && digitCount <= 2 && value.length < 14) return true;

  return false;
}

export function scorePacketImportLine(line) {
  const value = normalizePacketImportLine(line);
  if (isPacketImportNoiseLine(value)) return -999;

  let score = 0;
  const tokens = value.split(/\s+/).map(normalizeToken).filter(Boolean);
  const first = tokens[0] || "";
  const second = tokens[1] || "";

  if (tokenLooksLikeMpo(first) && tokenLooksLikeLin(second)) score += 130;
  if (tokenLooksLikeLin(first)) score += 115;
  if (tokens.some(tokenLooksLikeLin)) score += 55;
  if (tokens.some(tokenLooksLikeNsn)) score += 45;
  if (ITEM_WORD_PATTERN.test(value)) score += 35;
  if (/:/.test(value)) score += 15;
  if (value.length >= 16) score += 10;
  if (/\b(ea|u|j|7|0)\s+\d{3,5}\s+ea\s+\d+\b/i.test(value)) score += 10;
  if (/^(nsn|na|ncm|sca|228-|01901|10tdc|1007|6665|3805|5985|6350|1240|3433|5825|5865|6660|6902)\b/i.test(value)) score -= 55;

  return score;
}

export function confidenceFromPacketScore(score, row = {}) {
  if (row.mpo && row.lin && row.description) return "high";
  if (row.lin && row.description) return "high";
  if (row.nsn && row.description) return "medium";
  if (score >= 120) return "high";
  if (score >= 65) return "medium";
  return "low";
}

export function parseDelimitedPacketLine(line) {
  const parts = String(line || "")
    .split(/\t|\s+\|\s+/)
    .map(part => normalizePacketImportLine(part))
    .filter(Boolean);

  if (parts.length < 2) return null;

  const maybeQty = Number(parts[1]);
  const packetLine = parts[0];
  const structured = parseStructuredPacketLine(packetLine);

  return {
    ...structured,
    packetLine: structured?.packetLine || packetLine,
    expectedQty: Number.isInteger(maybeQty) && maybeQty >= 0 ? maybeQty : undefined,
    locationHint: parts.length > 2 ? parts.slice(2).join(" ") : undefined,
    confidence: "high"
  };
}

function parseNsnLine(line) {
  const value = normalizePacketImportLine(line);
  const rawTokens = value.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map(normalizeToken).filter(Boolean);
  const nsnIndex = tokens.findIndex(tokenLooksLikeNsn);
  if (nsnIndex < 0) return null;

  const nsn = tokens[nsnIndex];
  let tail = rawTokens.slice(nsnIndex + 1);
  if (!tail.length) return { nsn };

  let expectedQty;
  const cleanTail = tail.map(normalizeToken);
  let ohIndex = -1;
  for (let index = cleanTail.length - 1; index >= 0; index -= 1) {
    const token = cleanTail[index];
    if (!/^\d+$/.test(token)) continue;
    const previous = cleanTail[index - 1] || "";
    if (UI_PATTERN.test(previous) || previous.toLowerCase() === "qty") {
      ohIndex = index;
      break;
    }
  }
  if (ohIndex >= 0) {
    expectedQty = Number(cleanTail[ohIndex]);
    tail = tail.slice(0, ohIndex - 1 >= 0 && UI_PATTERN.test(cleanTail[ohIndex - 1]) ? ohIndex - 1 : ohIndex);
  }

  while (tail.length) {
    const clean = normalizeToken(tail[tail.length - 1]);
    if (UI_PATTERN.test(clean) || CIIC_PATTERN.test(clean) || /^\d{3,5}$/.test(clean)) {
      tail.pop();
      continue;
    }
    break;
  }

  const description = cleanPacketDescription(tail
    .filter(token => {
      const clean = normalizeToken(token);
      return !UI_PATTERN.test(clean) && !CIIC_PATTERN.test(clean);
    })
    .join(" ")
    .trim());

  return {
    nsn,
    description: description || undefined,
    expectedQty: Number.isInteger(expectedQty) ? expectedQty : undefined
  };
}

export function parseStructuredPacketLine(line) {
  const value = normalizePacketImportLine(line);
  if (!value || isPacketImportNoiseLine(value)) return null;

  const delimited = parseDelimitedPacketLine(value);
  if (delimited && delimited.packetLine !== value) return delimited;

  const rawTokens = value.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map(normalizeToken).filter(Boolean);
  if (!tokens.length) return null;

  let mpo;
  let lin;
  let descriptionStart = 0;

  if (tokenLooksLikeMpo(tokens[0]) && tokenLooksLikeLin(tokens[1])) {
    mpo = tokens[0];
    lin = tokens[1];
    descriptionStart = 2;
  } else if (tokenLooksLikeLin(tokens[0])) {
    lin = tokens[0];
    descriptionStart = 1;
  } else {
    const linIndex = tokens.findIndex(tokenLooksLikeLin);
    if (linIndex > 0 && linIndex <= 2) {
      lin = tokens[linIndex];
      mpo = tokenLooksLikeMpo(tokens[linIndex - 1]) ? tokens[linIndex - 1] : undefined;
      descriptionStart = linIndex + 1;
    }
  }

  if (lin) {
    const description = cleanPacketDescription(rawTokens.slice(descriptionStart).join(" ").trim());
    const row = {
      mpo,
      lin,
      description: description || undefined
    };
    row.packetLine = compactRowText(row);
    row.confidence = confidenceFromPacketScore(scorePacketImportLine(value), row);
    return row;
  }

  const nsnRow = parseNsnLine(value);
  if (nsnRow?.nsn && nsnRow.description) {
    const row = {
      ...nsnRow,
      packetLine: [nsnRow.nsn, nsnRow.description].filter(Boolean).join(" "),
      confidence: confidenceFromPacketScore(scorePacketImportLine(value), nsnRow)
    };
    return row;
  }

  const score = scorePacketImportLine(value);
  if (score >= 55) {
    return {
      packetLine: value,
      description: value,
      confidence: confidenceFromPacketScore(score)
    };
  }

  return null;
}

function mergeNsnIntoPrevious(rows, nsnRow) {
  if (!rows.length || !nsnRow?.nsn) return false;
  const previous = rows[rows.length - 1];
  if (previous.nsn) return false;

  previous.nsn = nsnRow.nsn;
  if (!previous.expectedQty && Number.isInteger(nsnRow.expectedQty)) {
    previous.expectedQty = nsnRow.expectedQty;
  }
  if (!previous.description && nsnRow.description) {
    previous.description = nsnRow.description;
    previous.packetLine = compactRowText(previous);
  }
  if (previous.confidence === "low" && (previous.lin || previous.nsn)) {
    previous.confidence = "medium";
  }
  return true;
}

function candidateLinesFromText(text) {
  const rawLines = String(text || "")
    .split(/\r?\n/)
    .map(line => String(line || "").trim())
    .filter(Boolean);

  const lines = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const line = normalizePacketImportLine(rawLine);
    const next = normalizePacketImportLine(rawLines[index + 1] || "");
    const nextAfter = normalizePacketImportLine(rawLines[index + 2] || "");

    if (/\t|\s+\|\s+/.test(rawLine)) {
      lines.push(rawLine);
      continue;
    }

    if (tokenLooksLikeMpo(line) && tokenLooksLikeLin(next) && nextAfter && !isPacketImportNoiseLine(nextAfter)) {
      lines.push(`${line} ${next} ${nextAfter}`);
      index += 2;
      continue;
    }

    if (tokenLooksLikeMpo(line) && next && !isPacketImportNoiseLine(next)) {
      lines.push(`${line} ${next}`);
      index += 1;
      continue;
    }

    if (tokenLooksLikeNsn(line) && next && !isPacketImportNoiseLine(next)) {
      lines.push(`${line} ${next}`);
      index += 1;
      continue;
    }

    if (isPacketImportNoiseLine(line)) continue;

    lines.push(line);
  }

  return lines;
}

export function parsePacketRows(text) {
  const rows = [];

  for (const line of candidateLinesFromText(text)) {
    const delimited = parseDelimitedPacketLine(line);
    const row = delimited || parseStructuredPacketLine(line);
    if (!row?.packetLine || isPacketImportNoiseLine(row.packetLine)) continue;

    if (row.nsn && !row.lin && mergeNsnIntoPrevious(rows, row)) continue;
    rows.push({
      ...row,
      packetLine: normalizePacketImportLine(row.packetLine),
      confidence: row.confidence || confidenceFromPacketScore(scorePacketImportLine(row.packetLine), row)
    });
  }

  const seen = new Set();
  return rows
    .filter(row => {
      const key = rowKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 250);
}

export function createPacketDraftRows(rows) {
  return rows.map((row, index) => ({
    id: globalThis.crypto?.randomUUID?.() || `packet-row-${Date.now()}-${index}`,
    packetLine: row.packetLine || "",
    expectedQty: row.expectedQty ?? "",
    locationHint: row.locationHint || "",
    confidence: row.confidence || "low",
    mpo: row.mpo || "",
    lin: row.lin || "",
    nsn: row.nsn || "",
    description: row.description || ""
  }));
}

export function sanitizePacketDraftRows(rows) {
  return rows
    .map(row => {
      const expectedQty = Number(row.expectedQty);
      const locationHint = String(row.locationHint || "").trim();
      const item = {
        packetLine: String(row.packetLine || "").trim()
      };
      if (locationHint) item.locationHint = locationHint;

      if (String(row.expectedQty ?? "").trim() && Number.isInteger(expectedQty) && expectedQty >= 0) {
        item.expectedQty = expectedQty;
      }

      return item;
    })
    .filter(row => row.packetLine.length >= 2);
}

export function packetMimeTypeForFile(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  if (type) return type;
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".csv")) return "text/csv";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}
