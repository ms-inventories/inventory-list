const TESSERACT_CDN_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const PDFJS_CDN_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
const PDFJS_WORKER_CDN_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

let tesseractLoadPromise = null;
let pdfJsLoadPromise = null;

function ensureTesseractLoaded() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_CDN_URL;
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error("OCR library did not load"));
    };
    script.onerror = () => reject(new Error("Failed to load OCR library"));
    document.head.appendChild(script);
  });

  return tesseractLoadPromise;
}

function ensurePdfJsLoaded() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN_URL;
    return Promise.resolve(window.pdfjsLib);
  }

  if (pdfJsLoadPromise) return pdfJsLoadPromise;

  pdfJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDFJS_CDN_URL;
    script.async = true;
    script.onload = () => {
      if (!window.pdfjsLib) {
        reject(new Error("PDF reader did not load"));
        return;
      }

      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN_URL;
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("Failed to load PDF reader"));
    document.head.appendChild(script);
  });

  return pdfJsLoadPromise;
}

function cleanOcrText(text) {
  return String(text || "")
    .replace(/[|]/g, "I")
    .replace(/\s+/g, " ")
    .trim();
}

function getOcrLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(cleanOcrText)
    .filter(line => line.length > 2);
}

function isNoiseOcrLine(line) {
  const value = cleanOcrText(line).toLowerCase();
  if (!value) return true;
  if (/^(from|to|fe|uic|date|time|page)\b/.test(value)) return true;
  if (/sub hand receipt/.test(value)) return true;
  if (/responsible officer/.test(value)) return true;
  if (/^(mpo|nsn|sysno|serno|ui|ciic|dla|buom|oh qty)\b/.test(value)) return true;
  if (/mpo description/.test(value) && value.length < 45) return true;
  if (/nsn description/.test(value) && value.length < 45) return true;
  if (/serno\/regno\/lotno/i.test(line)) return true;
  return false;
}

function normalizePacketCandidate(line) {
  return cleanOcrText(line)
    .replace(/\bMPO\s+Description\b/gi, "")
    .replace(/\bNSN\s+Description\b/gi, "")
    .replace(/\bMPO\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scorePacketCandidate(line) {
  const value = normalizePacketCandidate(line);
  if (isNoiseOcrLine(value)) return -999;
  if (value.length < 8) return -999;

  let score = value.length;
  if (/^\d{6,10}\s+[A-Z0-9]{5,8}\b/i.test(value)) score += 160;
  if (/\b[A-Z]\d{5}\b/i.test(value)) score += 120;
  if (/\b[A-Z0-9]{5,8}\b/i.test(value) && /[A-Z]{3,}/i.test(value)) score += 55;
  if (/\b(SET|KIT|GROUP|SYSTEM|SUBSYS|DETECTOR|TAMPER|TRAILER|RADIO|RADIAC|BINOCULAR|MACHINE|TRAINING|DEVICES|NAVIGATION|ANTENNA)\b/i.test(value)) score += 45;
  if (/:/.test(value)) score += 18;
  if (/^\d+$/.test(value.replace(/\s+/g, ""))) score -= 120;

  return score;
}

function getConfidenceLabel(score) {
  if (score >= 220) return "High";
  if (score >= 120) return "Medium";
  return "Low";
}

function parsePacketLineFromCandidate(candidateLine) {
  const line = cleanOcrText(candidateLine);
  const mpoMatch = line.match(/^(\d{6,10})\b/);
  const mpo = mpoMatch ? mpoMatch[1] : "";
  const withoutMpo = cleanOcrText(line.replace(/^\d{6,10}\s+/, ""));
  const firstToken = withoutMpo.split(/\s+/)[0] || "";
  const hasDigit = /\d/.test(firstToken);
  const hasLetter = /[a-z]/i.test(firstToken);
  const tokenLooksLikeLin = /^[a-z0-9]{5,8}$/i.test(firstToken) && hasDigit && hasLetter;
  const fallbackLinMatch = withoutMpo.match(/\b[A-Z]\s?\d{5}\b/i);
  const lin = tokenLooksLikeLin
    ? firstToken.toUpperCase()
    : (fallbackLinMatch ? fallbackLinMatch[0].replace(/\s+/g, "").toUpperCase() : "");
  const armyName = tokenLooksLikeLin
    ? cleanOcrText(withoutMpo.replace(/^\S+\s*/, ""))
    : (fallbackLinMatch ? cleanOcrText(withoutMpo.replace(fallbackLinMatch[0], "")) : withoutMpo);

  return {
    line,
    mpo,
    lin,
    armyName: armyName || withoutMpo || line
  };
}

function packetCandidateFromLine(line) {
  const normalized = normalizePacketCandidate(line);
  const score = scorePacketCandidate(normalized);

  return {
    ...parsePacketLineFromCandidate(normalized),
    score,
    confidence: getConfidenceLabel(score)
  };
}

function getPacketLineCandidates(text, maxCount) {
  const seen = new Set();
  const candidates = getOcrLines(text)
    .map(packetCandidateFromLine)
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter(candidate => {
      const key = candidate.line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return candidates.slice(0, maxCount || 8);
}

function getBestPacketLine(text) {
  const candidates = getPacketLineCandidates(text, 1);
  if (candidates.length) return candidates[0].line;
  return cleanOcrText(text);
}

function parsePacketLine(text) {
  const line = cleanOcrText(getBestPacketLine(text));
  const parsed = parsePacketLineFromCandidate(line);

  return {
    rawText: String(text || "").trim(),
    line,
    mpo: parsed.mpo,
    lin: parsed.lin,
    armyName: parsed.armyName,
    candidates: getPacketLineCandidates(text, 8)
  };
}

function getPacketCandidateDisplay(candidate) {
  const line = cleanOcrText(candidate?.line || "");
  const title = cleanOcrText(candidate?.armyName || line || "Unknown row");
  const score = Number(candidate?.score);
  const confidence = candidate?.confidence || (Number.isFinite(score) ? getConfidenceLabel(score) : "");
  const meta = [];

  if (candidate?.mpo) meta.push(`MPO ${candidate.mpo}`);
  if (candidate?.lin) meta.push(`LIN ${candidate.lin}`);
  if (confidence) meta.push(`${confidence} confidence`);

  return {
    title,
    meta: meta.join(" | "),
    rawLine: line && line.toLowerCase() !== title.toLowerCase() ? line : "",
    confidence: String(confidence || "").toLowerCase()
  };
}

function isPdfFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return type.includes("pdf") || name.endsWith(".pdf");
}

function pageTextItemsToLines(items) {
  const positioned = items
    .map(item => ({
      text: cleanOcrText(item.str),
      x: item.transform ? item.transform[4] : 0,
      y: item.transform ? item.transform[5] : 0
    }))
    .filter(item => item.text);

  positioned.sort((a, b) => {
    const yDiff = b.y - a.y;
    if (Math.abs(yDiff) > 3) return yDiff;
    return a.x - b.x;
  });

  const rows = [];
  positioned.forEach(item => {
    const row = rows.find(existing => Math.abs(existing.y - item.y) <= 3);
    if (row) {
      row.items.push(item);
      row.y = (row.y + item.y) / 2;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  });

  return rows
    .map(row => row.items.sort((a, b) => a.x - b.x).map(item => item.text).join(" "))
    .map(cleanOcrText)
    .filter(Boolean)
    .join("\n");
}

async function extractPdfText(file, onStatus) {
  onStatus?.("Loading PDF...");
  const pdfjsLib = await ensurePdfJsLoaded();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onStatus?.(`Reading page ${pageNumber} of ${pdf.numPages}...`);
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    pageTexts.push(pageTextItemsToLines(textContent.items || []));
  }

  return pageTexts.join("\n");
}

async function extractImageText(file, onStatus) {
  onStatus?.("Loading OCR...");
  const tesseract = await ensureTesseractLoaded();
  onStatus?.("Reading image text...");

  const worker = await tesseract.createWorker("eng");

  try {
    const result = await worker.recognize(file);
    return result?.data?.text || "";
  } finally {
    await worker.terminate();
  }
}

async function recognizePacketFile(file, onStatus) {
  if (!file) throw new Error("Choose a packet file first");
  const text = isPdfFile(file)
    ? await extractPdfText(file, onStatus)
    : await extractImageText(file, onStatus);

  const parsed = parsePacketLine(text);
  parsed.candidates = getPacketLineCandidates(text, 12);

  if (!parsed.line) {
    throw new Error("No text found. Try a clean PDF or a closer one-line photo.");
  }

  return parsed;
}

async function recognizePacketImage(file, onStatus) {
  return recognizePacketFile(file, onStatus);
}
