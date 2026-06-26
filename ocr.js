const TESSERACT_CDN_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

let tesseractLoadPromise = null;

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

function cleanOcrText(text) {
  return String(text || "")
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function getOcrLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(cleanOcrText)
    .filter(line => line.length > 2);
}

function getBestPacketLine(text) {
  const lines = getOcrLines(text);
  if (!lines.length) return cleanOcrText(text);

  const scored = lines.map(line => {
    let score = line.length;
    if (/\b[A-Z]\s?\d{5}\b/i.test(line)) score += 120;
    if (/\b(NSN|LIN|NOMENCLATURE|SUBSYS|SYSTEM|KIT|SET|ASSY|ASSEMBLY)\b/i.test(line)) score += 40;
    if (/:/.test(line)) score += 20;
    return { line, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].line;
}

function parsePacketLine(text) {
  const line = cleanOcrText(getBestPacketLine(text));
  const linMatch = line.match(/\b[A-Z]\s?\d{5}\b/i);
  const lin = linMatch ? linMatch[0].replace(/\s+/g, "").toUpperCase() : "";
  const withoutLin = linMatch
    ? cleanOcrText(line.slice(0, linMatch.index) + " " + line.slice(linMatch.index + linMatch[0].length))
    : line;

  return {
    rawText: String(text || "").trim(),
    line,
    lin,
    armyName: withoutLin || line
  };
}

async function recognizePacketImage(file, onStatus) {
  if (!file) throw new Error("Choose a photo first");
  onStatus?.("Loading OCR...");

  const tesseract = await ensureTesseractLoaded();
  onStatus?.("Reading text...");

  const worker = await tesseract.createWorker("eng");

  try {
    const result = await worker.recognize(file);
    const text = result?.data?.text || "";
    const parsed = parsePacketLine(text);

    if (!parsed.line) {
      throw new Error("No text found. Try a closer, flatter photo.");
    }

    return parsed;
  } finally {
    await worker.terminate();
  }
}
