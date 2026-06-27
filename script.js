const BUCKET_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com";
const INDEX_URL = `${BUCKET_BASE_URL}/inventories/index.json`;
const IMAGE_BASE_URL = `${BUCKET_BASE_URL}/`;

let indexData = null;
let selectedPlatoon = null;
let inventory = null;

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

function itemMatchesSearch(item, query) {
  const terms = normalizeSearchValue(query).split(" ").filter(term => term.length > 1);
  if (!terms.length) return true;

  const haystack = normalizeSearchValue(getSearchText(item));
  return terms.every(term => haystack.includes(term));
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
    button.textContent = candidate.line;
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

  body.appendChild(titleRow);
  body.appendChild(buildDetailGrid(item));
  itemCard.appendChild(body);

  return itemCard;
}

function buildItems() {
  const container = document.getElementById("itemsContainer");
  const query = (document.getElementById("searchInput")?.value || "").trim();
  const items = inventory?.items || [];
  const filtered = items.filter(item => itemMatchesSearch(item, query));
  const withPhotos = items.filter(item => getImageValues(item).length > 0).length;

  container.innerHTML = "";
  updateSummary(items.length, filtered.length, withPhotos);

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query
      ? "No equipment matched that search."
      : "No equipment has been added for this platoon yet.";
    container.appendChild(empty);
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

async function scanPacketForSearch(file) {
  const scanBtn = document.getElementById("scanPacketBtn");
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
    document.getElementById("packetScanInput").click();
  });
  document.getElementById("packetScanInput").addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    scanPacketForSearch(file);
    e.target.value = "";
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeImageLightbox();
      closeScanPicker();
    }
  });
});
