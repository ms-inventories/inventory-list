const BUCKET_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com";
const INDEX_URL = `${BUCKET_BASE_URL}/inventories/index.json`;
const IMAGE_BASE_URL = `${BUCKET_BASE_URL}/`;

let indexData = null;
let selectedPlatoon = null;
let inventory = null;

const SEARCH_NOISE_TERMS = new Set([
  "buom",
  "ciic",
  "date",
  "description",
  "dla",
  "ea",
  "from",
  "lotno",
  "mpo",
  "nsn",
  "officer",
  "oh",
  "page",
  "qty",
  "regno",
  "responsible",
  "serno",
  "sysno",
  "time",
  "to",
  "uic",
  "ui"
]);

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function setLoginStatus(text, isError) {
  const el = document.getElementById("loginStatus");
  el.textContent = text || "";
  el.className = isError ? "status-text error" : "status-text";
}

function setScanStatus(text, isError) {
  const el = document.getElementById("scanStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "status-text scan-status error" : "status-text scan-status";
}

function appendPacketCandidateContent(button, candidate) {
  const display = getPacketCandidateDisplay(candidate);
  const content = document.createElement("span");
  const title = document.createElement("span");
  content.className = "candidate-content";
  title.className = "candidate-main";
  title.textContent = display.title;
  content.appendChild(title);

  if (display.meta) {
    const meta = document.createElement("span");
    meta.className = `candidate-meta confidence-${display.confidence || "low"}`;
    meta.textContent = display.meta;
    content.appendChild(meta);
  }

  if (display.rawLine) {
    const raw = document.createElement("span");
    raw.className = "candidate-raw";
    raw.textContent = display.rawLine;
    content.appendChild(raw);
  }

  button.textContent = "";
  button.appendChild(content);
}

function normalizeImageSrc(src) {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  return IMAGE_BASE_URL + src.replace(/^\/+/, "");
}

async function fetchJson(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return await res.json();
}

function populatePlatoons() {
  const select = document.getElementById("platoonSelect");
  select.innerHTML = "";

  (indexData.platoons || []).forEach((p, i) => {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = p.name || p.id;
    if (i === 0) option.selected = true;
    select.appendChild(option);
  });

  const first = (indexData.platoons || [])[0];
  selectedPlatoon = first || null;
}

function getSelectedPlatoonById(id) {
  return (indexData.platoons || []).find(p => p.id === id) || null;
}

async function loadIndex() {
  indexData = await fetchJson(INDEX_URL);
  if (!indexData || !Array.isArray(indexData.platoons) || indexData.platoons.length === 0) {
    throw new Error("index.json has no platoons");
  }
  populatePlatoons();
}

async function loadPlatoonInventory(file) {
  return await fetchJson(`${BUCKET_BASE_URL}/${file}`);
}

function isImageField(field) {
  return String(field.label || "").toLowerCase() === "image";
}

function fieldValueToText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function getImageValues(item) {
  const imageField = (item.fields || []).find(isImageField);
  if (!imageField) return [];
  const values = Array.isArray(imageField.value) ? imageField.value : [imageField.value];
  return values
    .map(v => String(v || "").trim())
    .filter(value => value && !isPlaceholderImageSrc(value));
}

function getDetailFields(item) {
  return (item.fields || []).filter(field => {
    if (isImageField(field)) return false;
    const label = String(field.label || "").toLowerCase();
    return label !== "common name" && label !== "location";
  });
}

function getFieldValue(item, label) {
  const target = String(label || "").toLowerCase();
  const field = (item.fields || []).find(f => !isImageField(f) && String(f.label || "").toLowerCase() === target);
  return field ? fieldValueToText(field.value).trim() : "";
}

function normalizeSearchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderImageSrc(src) {
  const value = String(src || "").toLowerCase();
  return value.includes("placehold.co");
}

function getSearchText(item) {
  const fieldText = (item.fields || [])
    .map(field => `${field.label || ""} ${fieldValueToText(field.value)}`)
    .join(" ");

  return `${item.title || ""} ${fieldText}`;
}

function getSearchTerms(query) {
  return normalizeSearchValue(query)
    .split(" ")
    .filter(term => term.length > 1 && !SEARCH_NOISE_TERMS.has(term));
}

function itemMatchesSearch(item, query) {
  const normalizedQuery = normalizeSearchValue(query);
  const terms = getSearchTerms(query);
  if (!normalizedQuery) return true;
  if (!terms.length) return false;

  const haystack = normalizeSearchValue(getSearchText(item));
  return terms.every(term => haystack.includes(term));
}

function getItemSearchParts(item) {
  const parts = {
    title: normalizeSearchValue(item.title),
    commonName: normalizeSearchValue(getFieldValue(item, "Common Name")),
    armyName: normalizeSearchValue(getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature")),
    lin: normalizeSearchValue(getFieldValue(item, "LIN")),
    nsn: normalizeSearchValue(getFieldValue(item, "NSN")),
    description: normalizeSearchValue(getFieldValue(item, "Description")),
    location: normalizeSearchValue(getFieldValue(item, "Location")),
    all: normalizeSearchValue(getSearchText(item))
  };
  parts.tokens = parts.all.split(" ").filter(term => term.length > 1);
  return parts;
}

function getConsonantKey(value) {
  return normalizeSearchValue(value)
    .replace(/\s+/g, "")
    .split("")
    .filter((char, index) => /\d/.test(char) || index === 0 || !/[aeiou]/.test(char))
    .join("");
}

function getVariantTokenScore(term, tokens) {
  if (term.length < 4) return 0;
  const termKey = getConsonantKey(term);

  for (const token of tokens) {
    if (token.length < 4) continue;
    if (token.startsWith(term) || term.startsWith(token)) return 14;

    const tokenKey = getConsonantKey(token);
    if (termKey.length >= 4 && termKey === tokenKey) return 12;
  }

  return 0;
}

function fieldContainsTerm(fieldValue, term) {
  return fieldValue && fieldValue.includes(term);
}

function scoreSuggestedItem(item, terms) {
  const parts = getItemSearchParts(item);
  let score = 0;
  let matchedTerms = 0;

  terms.forEach(term => {
    let termScore = 0;

    if (parts.lin && (parts.lin === term || parts.lin.includes(term) || term.includes(parts.lin))) {
      termScore = Math.max(termScore, 120);
    }

    if (parts.nsn && (parts.nsn === term || parts.nsn.includes(term) || term.includes(parts.nsn))) {
      termScore = Math.max(termScore, 95);
    }

    if (fieldContainsTerm(parts.commonName, term) || fieldContainsTerm(parts.title, term)) {
      termScore = Math.max(termScore, 58);
    }

    if (fieldContainsTerm(parts.armyName, term)) {
      termScore = Math.max(termScore, 48);
    }

    if (fieldContainsTerm(parts.description, term) || fieldContainsTerm(parts.location, term)) {
      termScore = Math.max(termScore, 24);
    }

    if (fieldContainsTerm(parts.all, term)) {
      termScore = Math.max(termScore, 16);
    }

    termScore = Math.max(termScore, getVariantTokenScore(term, parts.tokens));

    if (termScore > 0) {
      score += termScore;
      matchedTerms += 1;
    }
  });

  if (!matchedTerms) return 0;

  score += matchedTerms * 12;
  if (matchedTerms >= Math.ceil(terms.length * 0.4)) score += 28;
  if (matchedTerms === terms.length) score += 35;

  return score;
}

function getClosestItemMatches(items, query, limit) {
  const terms = getSearchTerms(query);
  if (!terms.length) return [];

  return items
    .map(item => ({ item, score: scoreSuggestedItem(item, terms) }))
    .filter(result => result.score >= 32)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 4)
    .map(result => result.item);
}

function getSuggestedSearchQuery(item) {
  return getFieldValue(item, "Common Name")
    || item.title
    || getFieldValue(item, "LIN")
    || getFieldValue(item, "Army Name")
    || getFieldValue(item, "Nomenclature")
    || "";
}

function buildItemCopyText(item) {
  const commonName = getFieldValue(item, "Common Name");
  const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
  const lin = getFieldValue(item, "LIN");
  const nsn = getFieldValue(item, "NSN");
  const location = getFieldValue(item, "Location");
  const title = commonName || item.title || armyName || "(Untitled)";
  const lines = [title];

  if (lin) lines.push(`LIN: ${lin}`);
  if (armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(title)) {
    lines.push(`Army name: ${armyName}`);
  }
  if (nsn) lines.push(`NSN: ${nsn}`);
  if (location) lines.push(`Location: ${location}`);

  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) throw new Error("Copy command failed");
  } finally {
    textarea.remove();
  }
}

function buildCopyItemButton(item, displayTitle) {
  const button = document.createElement("button");
  button.className = "btn btn-secondary btn-small copy-item-btn";
  button.type = "button";
  button.innerHTML = '<i data-lucide="copy" aria-hidden="true"></i><span>Copy</span>';
  button.addEventListener("click", async () => {
    try {
      await copyTextToClipboard(buildItemCopyText(item));
      setScanStatus(`Copied: ${displayTitle}`);
    } catch (e) {
      setScanStatus("Could not copy item info", true);
    }
  });

  return button;
}

function updateSummary(total, visible, withPhotos) {
  const totalEl = document.getElementById("totalItemsCount");
  const visibleEl = document.getElementById("visibleItemsCount");
  const imageEl = document.getElementById("imageItemsCount");

  if (totalEl) totalEl.textContent = String(total);
  if (visibleEl) visibleEl.textContent = String(visible);
  if (imageEl) imageEl.textContent = String(withPhotos);
}

function closeImageLightbox() {
  const existing = document.getElementById("imageLightbox");
  if (existing) existing.remove();
}

function closeScanPicker() {
  const existing = document.getElementById("scanPicker");
  if (existing) existing.remove();
}

function searchPacketLine(line) {
  const searchInput = document.getElementById("searchInput");
  if (!searchInput) return;

  searchInput.value = line || "";
  buildItems();
  setScanStatus(line ? `Searched: ${line}` : "");
}

function openScanCandidatePicker(parsed) {
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  if (candidates.length <= 1) {
    searchPacketLine(parsed.line);
    return;
  }

  closeScanPicker();

  const backdrop = document.createElement("div");
  backdrop.id = "scanPicker";
  backdrop.className = "modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "modal-panel";

  const stack = document.createElement("div");
  stack.className = "modal-stack";
  stack.innerHTML = `
    <div class="modal-heading">
      <span class="modal-icon"><i data-lucide="scan-text" aria-hidden="true"></i></span>
      <div>
        <p class="eyebrow">Document scan</p>
        <div class="modal-title">Pick item row</div>
      </div>
    </div>
    <p class="modal-copy">I found several possible rows. Choose the one from the packet, or scan a closer single row if this list looks wrong.</p>
  `;

  const list = document.createElement("div");
  list.className = "candidate-list";

  candidates.forEach(candidate => {
    const button = document.createElement("button");
    button.className = "btn btn-secondary candidate-btn";
    button.type = "button";
    appendPacketCandidateContent(button, candidate);
    button.addEventListener("click", () => {
      searchPacketLine(candidate.line);
      closeScanPicker();
    });
    list.appendChild(button);
  });

  const actions = document.createElement("div");
  actions.className = "button-row";

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-secondary";
  closeBtn.type = "button";
  closeBtn.innerHTML = '<i data-lucide="x" aria-hidden="true"></i><span>Cancel</span>';
  closeBtn.addEventListener("click", closeScanPicker);

  actions.appendChild(closeBtn);
  stack.appendChild(list);
  stack.appendChild(actions);
  panel.appendChild(stack);
  backdrop.appendChild(panel);
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) closeScanPicker();
  });

  document.body.appendChild(backdrop);
  refreshIcons();
}

function openImageLightbox(src, alt) {
  closeImageLightbox();

  const backdrop = document.createElement("div");
  backdrop.id = "imageLightbox";
  backdrop.className = "lightbox-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");

  const panel = document.createElement("div");
  panel.className = "lightbox-panel";

  const img = document.createElement("img");
  img.src = src;
  img.alt = alt || "Inventory image";

  const actions = document.createElement("div");
  actions.className = "lightbox-actions";

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-secondary";
  closeBtn.innerHTML = '<i data-lucide="x" aria-hidden="true"></i><span>Close</span>';
  closeBtn.addEventListener("click", closeImageLightbox);

  actions.appendChild(closeBtn);
  panel.appendChild(img);
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) closeImageLightbox();
  });

  document.body.appendChild(backdrop);
  refreshIcons();
  closeBtn.focus();
}

function buildImageGallery(item, images) {
  const media = document.createElement("div");
  media.className = "card-media";

  if (images.length === 0) {
    media.innerHTML = `
      <div class="empty-media" aria-label="No image available">
        <i data-lucide="image-off" aria-hidden="true"></i>
      </div>
    `;
    return media;
  }

  const gallery = document.createElement("div");
  gallery.className = "image-gallery";

  images.slice(0, 4).forEach(imgSrc => {
    const img = document.createElement("img");
    img.src = normalizeImageSrc(imgSrc);
    img.alt = item.title || "Inventory image";
    img.loading = "lazy";
    img.tabIndex = 0;
    img.addEventListener("click", () => openImageLightbox(img.src, img.alt));
    img.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openImageLightbox(img.src, img.alt);
      }
    });
    gallery.appendChild(img);
  });

  media.appendChild(gallery);
  return media;
}

function buildDetailGrid(item) {
  const grid = document.createElement("div");
  grid.className = "detail-grid";

  getDetailFields(item).forEach(field => {
    const label = String(field.label || "").trim();
    if (!label) return;

    const value = fieldValueToText(field.value).trim();
    const cell = document.createElement("div");
    cell.className = "detail-cell";

    const labelEl = document.createElement("span");
    labelEl.className = "detail-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = value ? "detail-value" : "detail-value empty";
    valueEl.textContent = value || "Not recorded";

    cell.appendChild(labelEl);
    cell.appendChild(valueEl);
    grid.appendChild(cell);
  });

  if (!grid.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No details have been recorded for this item yet.";
    grid.appendChild(empty);
  }

  return grid;
}

function buildItemCard(item) {
  const images = getImageValues(item);
  const commonName = getFieldValue(item, "Common Name");
  const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
  const lin = getFieldValue(item, "LIN");
  const displayTitle = commonName || item.title || armyName || "(Untitled)";

  const itemCard = document.createElement("article");
  itemCard.className = "viewer-card";
  itemCard.appendChild(buildImageGallery(item, images));

  const body = document.createElement("div");
  body.className = "card-body";

  const location = getFieldValue(item, "Location");
  if (location) {
    const caption = document.createElement("div");
    caption.className = "location-caption";

    const captionLabel = document.createElement("span");
    captionLabel.className = "location-caption-label";
    captionLabel.textContent = "Location";

    const captionValue = document.createElement("span");
    captionValue.className = "location-caption-value";
    captionValue.textContent = location;

    caption.appendChild(captionLabel);
    caption.appendChild(captionValue);
    body.appendChild(caption);
  }

  const titleRow = document.createElement("div");
  titleRow.className = "card-title-row";

  const titleBlock = document.createElement("div");
  titleBlock.className = "title-block";

  const titleEl = document.createElement("h2");
  titleEl.textContent = displayTitle;
  titleEl.className = "item-title";
  titleBlock.appendChild(titleEl);

  const packetParts = [
    lin ? `LIN ${lin}` : "",
    armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(displayTitle) ? armyName : ""
  ].filter(Boolean);

  if (packetParts.length) {
    const packetMeta = document.createElement("p");
    packetMeta.className = "packet-meta";
    packetMeta.textContent = packetParts.join(" - ");
    titleBlock.appendChild(packetMeta);
  }

  titleRow.appendChild(titleBlock);
  titleRow.appendChild(buildCopyItemButton(item, displayTitle));

  body.appendChild(titleRow);
  body.appendChild(buildDetailGrid(item));
  itemCard.appendChild(body);

  return itemCard;
}

function buildSuggestionList(suggestions) {
  const panel = document.createElement("div");
  panel.className = "suggestion-panel";

  const heading = document.createElement("p");
  heading.className = "suggestion-heading";
  heading.textContent = "Closest matches";
  panel.appendChild(heading);

  const list = document.createElement("div");
  list.className = "suggestion-list";

  suggestions.forEach(item => {
    const commonName = getFieldValue(item, "Common Name");
    const armyName = getFieldValue(item, "Army Name") || getFieldValue(item, "Nomenclature");
    const lin = getFieldValue(item, "LIN");
    const location = getFieldValue(item, "Location");
    const displayTitle = commonName || item.title || armyName || "(Untitled)";
    const meta = [
      lin ? `LIN ${lin}` : "",
      armyName && normalizeSearchValue(armyName) !== normalizeSearchValue(displayTitle) ? armyName : "",
      location ? `Location: ${location}` : ""
    ].filter(Boolean);

    const button = document.createElement("button");
    button.className = "suggestion-btn";
    button.type = "button";
    button.addEventListener("click", () => {
      const searchInput = document.getElementById("searchInput");
      if (searchInput) searchInput.value = getSuggestedSearchQuery(item);
      setScanStatus(`Showing closest match: ${displayTitle}`);
      buildItems();
    });

    const icon = document.createElement("span");
    icon.className = "suggestion-icon";
    icon.innerHTML = '<i data-lucide="corner-down-right" aria-hidden="true"></i>';

    const copy = document.createElement("span");
    copy.className = "suggestion-copy";

    const title = document.createElement("span");
    title.className = "suggestion-main";
    title.textContent = displayTitle;
    copy.appendChild(title);

    if (meta.length) {
      const details = document.createElement("span");
      details.className = "suggestion-meta";
      details.textContent = meta.join(" - ");
      copy.appendChild(details);
    }

    button.appendChild(icon);
    button.appendChild(copy);
    list.appendChild(button);
  });

  panel.appendChild(list);
  return panel;
}

function buildItems() {
  const container = document.getElementById("itemsContainer");
  const query = (document.getElementById("searchInput")?.value || "").trim();
  const items = inventory?.items || [];
  const filtered = items.filter(item => itemMatchesSearch(item, query));
  const suggestions = filtered.length || !query ? [] : getClosestItemMatches(items, query, 4);
  const withPhotos = items.filter(item => getImageValues(item).length > 0).length;

  container.innerHTML = "";
  updateSummary(items.length, filtered.length || suggestions.length, withPhotos);

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query && suggestions.length
      ? "No exact match. These are the closest items I found."
      : query
        ? "No equipment matched that search."
      : "No equipment has been added for this platoon yet.";
    container.appendChild(empty);
    if (suggestions.length) container.appendChild(buildSuggestionList(suggestions));
    refreshIcons();
    return;
  }

  filtered.forEach(item => {
    container.appendChild(buildItemCard(item));
  });

  refreshIcons();
}

async function attemptLogin() {
  setLoginStatus("");

  const selectId = document.getElementById("platoonSelect").value;
  selectedPlatoon = getSelectedPlatoonById(selectId);

  if (!selectedPlatoon) {
    setLoginStatus("Select a platoon", true);
    return;
  }

  setLoginStatus("Loading inventory...");

  let data;
  try {
    data = await loadPlatoonInventory(selectedPlatoon.file);
  } catch (e) {
    setLoginStatus("Failed to load platoon inventory", true);
    return;
  }

  const userInput = document.getElementById("passwordInput").value;
  if (userInput !== data.password) {
    setLoginStatus("Incorrect password", true);
    return;
  }

  inventory = data;

  document.getElementById("passwordPrompt").classList.add("hidden");
  document.getElementById("mainContent").classList.remove("hidden");

  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = "";

  document.getElementById("pageTitle").textContent = selectedPlatoon.name || "Equipment Inventory";
  buildItems();
}

function resetToLogin() {
  document.getElementById("mainContent").classList.add("hidden");
  document.getElementById("passwordPrompt").classList.remove("hidden");
  document.getElementById("passwordInput").value = "";
  setLoginStatus("");
  inventory = null;
  updateSummary(0, 0, 0);
  refreshIcons();
}

async function scanPacketForSearch(file, activeButton) {
  const scanBtn = activeButton || document.getElementById("scanPacketBtn");
  const searchInput = document.getElementById("searchInput");

  if (!file || !searchInput) return;

  try {
    if (scanBtn) scanBtn.disabled = true;
    setScanStatus("Reading packet file...");
    const parsed = await recognizePacketFile(file, setScanStatus);
    openScanCandidatePicker(parsed);
  } catch (e) {
    setScanStatus(e.message || "Could not read that file", true);
  } finally {
    if (scanBtn) scanBtn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  refreshIcons();
  setLoginStatus("Loading platoons...");

  try {
    await loadIndex();
    setLoginStatus("");
  } catch (e) {
    setLoginStatus("Failed to load index.json", true);
  }

  document.getElementById("submitBtn").addEventListener("click", attemptLogin);
  document.getElementById("changePlatoonBtn").addEventListener("click", resetToLogin);
  document.getElementById("searchInput").addEventListener("input", buildItems);
  document.getElementById("passwordInput").addEventListener("keydown", e => {
    if (e.key === "Enter") attemptLogin();
  });
  document.getElementById("scanPacketBtn").addEventListener("click", () => {
    document.getElementById("packetCameraInput").click();
  });
  document.getElementById("uploadPacketBtn").addEventListener("click", () => {
    document.getElementById("packetFileInput").click();
  });
  document.getElementById("packetCameraInput").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    scanPacketForSearch(file, document.getElementById("scanPacketBtn"));
    e.target.value = "";
  });
  document.getElementById("packetFileInput").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    scanPacketForSearch(file, document.getElementById("uploadPacketBtn"));
    e.target.value = "";
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeImageLightbox();
      closeScanPicker();
    }
  });
});
