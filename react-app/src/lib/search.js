function stringSearchValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(?:data:|blob:|https?:\/\/)/i.test(trimmed)) return "";
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTerms(query) {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

export function matchesSearch(values, query) {
  const terms = searchTerms(query);
  if (!terms.length) return true;

  const haystack = normalizeSearchText(
    (Array.isArray(values) ? values : [values])
      .flat(Infinity)
      .map(stringSearchValue)
      .filter(Boolean)
      .join(" ")
  );
  return terms.every(term => haystack.includes(term));
}

export function metadataSearchText(metadata, { maxValues = 80, maxLength = 8000 } = {}) {
  const values = [];
  const seen = new Set();

  function visit(value, depth = 0) {
    if (values.length >= maxValues || depth > 5 || value === null || value === undefined) return;
    if (typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
    }
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        const normalizedKey = String(key || "").toLowerCase();
        if (/image|photo|media|url|storage|key/.test(normalizedKey)) return;
        values.push(key);
        visit(item, depth + 1);
      });
      return;
    }

    const text = stringSearchValue(value);
    if (text) values.push(text);
  }

  visit(metadata);
  return values.join(" ").slice(0, maxLength);
}
