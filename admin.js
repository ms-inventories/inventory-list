const BUCKET_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com";
const INDEX_URL = `${BUCKET_BASE_URL}/inventories/index.json`;
const IMAGE_BASE_URL = `${BUCKET_BASE_URL}/`;
const API_BASE_URL = "https://j2pdaptydpur4jjasyl7pz3xc40ckbqd.lambda-url.us-east-1.on.aws";

let indexData = null;
let currentPlatoon = null;
let inventory = null;
let templateLabels = [];
let isAuthed = false;
let lastPlatoonId = null;
let sessionAdminKey = "";
let pendingDeletedImages = [];

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.lucide.createIcons();
  }
}

function setButtonContent(button, icon, text) {
  button.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span>${text}</span>`;
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "status-text error" : "status-text";
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

function safeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openModal(html) {
  const backdrop = document.getElementById("modalBackdrop");
  const panel = document.getElementById("modalPanel");
  if (!backdrop || !panel) return;
  panel.innerHTML = html;
  backdrop.classList.remove("hidden");
  refreshIcons();
}

function closeModal() {
  const backdrop = document.getElementById("modalBackdrop");
  const panel = document.getElementById("modalPanel");
  if (!backdrop || !panel) return;
  backdrop.classList.add("hidden");
  panel.innerHTML = "";
}

function setAppVisible() {
  const app = document.getElementById("appPanel");
  if (!app) return;
  app.classList.remove("hidden");
}

function setAppHidden() {
  const app = document.getElementById("appPanel");
  if (!app) return;
  app.classList.add("hidden");
}

async function fetchJson(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return await res.json();
}

async function callApi(path, options, adminKeyValue) {
  const requestOptions = options || {};
  const requestHeaders = requestOptions.headers || {};
  const adminKey = adminKeyValue || "";

  if (adminKey) requestHeaders["x-admin-key"] = adminKey;
  requestOptions.headers = requestHeaders;

  const res = await fetch(API_BASE_URL + path, requestOptions);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message =
      typeof data === "string"
        ? data
        : (data && (data.error || data.details)) || res.statusText;
    throw new Error(message);
  }

  return data;
}

async function verifyAdminKey(adminKey) {
  const key = `images/auth-check-${Date.now()}.txt`;
  await callApi(
    "/presign",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, contentType: "text/plain" })
    },
    adminKey
  );
}

function ensureInventoryShape(data) {
  const inv = data && typeof data === "object" ? data : {};
  const items = Array.isArray(inv.items) ? inv.items : [];
  const password = typeof inv.password === "string" ? inv.password : "";

  items.forEach(item => {
    if (!item || typeof item !== "object") return;
    if (typeof item.title !== "string") item.title = "";
    if (!Array.isArray(item.fields)) item.fields = [];

    item.fields.forEach(field => {
      if (!field || typeof field !== "object") return;
      if (typeof field.label !== "string") field.label = "";

      const isImage = String(field.label || "").toLowerCase() === "image";
      if (isImage) {
        if (Array.isArray(field.value)) {
          field.value = field.value.map(v => String(v)).filter(Boolean);
        } else if (typeof field.value === "string" && field.value.trim()) {
          field.value = [field.value.trim()];
        } else {
          field.value = [];
        }
      } else {
        if (Array.isArray(field.value)) field.value = field.value.join(", ");
        if (field.value === null || field.value === undefined) field.value = "";
        field.value = String(field.value);
      }

      if (!field._custom) field._custom = false;
    });
  });

  return { password, items };
}

function buildTemplateLabels(items) {
  const defaultLabels = ["Image", "LIN", "Army Name", "Common Name", "NSN", "SN", "Description", "Location", "OH Qty", "Actual", "Status"];
  const labels = [];
  const seen = new Set();

  (items || []).forEach(item => {
    (item.fields || []).forEach(field => {
      const label = String(field.label || "").trim();
      if (!label) return;
      if (seen.has(label)) return;
      seen.add(label);
      labels.push(label);
    });
  });

  if (labels.length === 0) {
    return defaultLabels;
  }

  const merged = [];
  const mergedKeys = new Set();

  defaultLabels.forEach(label => {
    const existing = labels.find(l => l.toLowerCase() === label.toLowerCase()) || label;
    const key = existing.toLowerCase();
    if (mergedKeys.has(key)) return;
    mergedKeys.add(key);
    merged.push(existing);
  });

  labels.forEach(label => {
    const key = label.toLowerCase();
    if (mergedKeys.has(key)) return;
    mergedKeys.add(key);
    merged.push(label);
  });

  return merged;
}

function applyTemplates() {
  templateLabels = buildTemplateLabels(inventory.items);

  inventory.items.forEach(item => {
    templateLabels.forEach(label => {
      const exists = item.fields.some(f => String(f.label || "") === label);
      if (!exists) {
        const isImage = label.toLowerCase() === "image";
        item.fields.push({ label, value: isImage ? [] : "", _custom: false });
      }
    });

    item.fields = item.fields.slice().sort((a, b) => {
      const aIdx = templateLabels.indexOf(a.label);
      const bIdx = templateLabels.indexOf(b.label);
      const aRank = aIdx === -1 ? 9999 : aIdx;
      const bRank = bIdx === -1 ? 9999 : bIdx;
      return aRank - bRank;
    });
  });
}

async function loadIndex() {
  indexData = await fetchJson(INDEX_URL);
  if (!indexData || !Array.isArray(indexData.platoons) || indexData.platoons.length === 0) {
    throw new Error("index.json has no platoons");
  }
}

function getPlatoonById(id) {
  return (indexData.platoons || []).find(p => p.id === id) || null;
}

async function loadPlatoonInventory(platoon) {
  const data = await fetchJson(`${BUCKET_BASE_URL}/${platoon.file}`);
  return ensureInventoryShape(data);
}

function populatePlatoonSelect(selectedId) {
  const select = document.getElementById("platoonSelect");
  if (!select) return;

  select.innerHTML = "";

  (indexData.platoons || []).forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    select.appendChild(opt);
  });

  if (selectedId) select.value = selectedId;
}

function setAdminKeySession(value) {
  sessionAdminKey = value || "";
}

function getAdminKeyFromSession() {
  return sessionAdminKey;
}

function clearSession() {
  sessionAdminKey = "";
}

function clearPendingDeletes() {
  pendingDeletedImages = [];
}

function buildSavePayload() {
  const items = inventory.items.map(item => {
    const title = String(item.title || "").trim() || "Untitled";

    const fields = (item.fields || [])
      .map(field => {
        const label = String(field.label || "").trim();
        if (!label) return null;

        const isImage = label.toLowerCase() === "image";
        if (isImage) {
          const list = Array.isArray(field.value) ? field.value : [];
          const cleaned = list.map(v => String(v).trim()).filter(Boolean);
          return { label, value: cleaned };
        }

        const value = field.value === null || field.value === undefined ? "" : String(field.value);
        return { label, value };
      })
      .filter(Boolean);

    return { title, fields };
  });

  return { password: inventory.password, items };
}

async function saveInventory(adminKey) {
  if (!isAuthed || !inventory || !currentPlatoon) {
    setStatus("Sign in first", true);
    return;
  }

  setStatus("Saving...", false);

  const payload = buildSavePayload();

  await callApi(
    "/inventory",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: currentPlatoon.file,
        data: payload,
        deletedImages: pendingDeletedImages
      })
    },
    adminKey
  );

  clearPendingDeletes();
  setStatus("Saved", false);
}

function addItem() {
  if (!isAuthed || !inventory) return;

  const fields = templateLabels.map(label => {
    const isImage = label.toLowerCase() === "image";
    return { label, value: isImage ? [] : "", _custom: false };
  });

  inventory.items.push({ title: "New Item", fields });
  renderItems();

  const newIndex = inventory.items.length - 1;
  requestAnimationFrame(() => {
    const card = document.getElementById(`item-card-${newIndex}`);
    const title = document.getElementById(`item-title-${newIndex}`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    if (title) title.focus();
  });
}

function getDraftFields(values) {
  const valueMap = values || {};
  return templateLabels.map(label => {
    const isImage = label.toLowerCase() === "image";
    const value = Object.prototype.hasOwnProperty.call(valueMap, label)
      ? valueMap[label]
      : (isImage ? [] : "");

    return {
      label,
      value: isImage ? (Array.isArray(value) ? value : []) : String(value || ""),
      _custom: false
    };
  });
}

function addScannedItemDraft(draft) {
  if (!isAuthed || !inventory) return;

  const commonName = String(draft.commonName || "").trim();
  const armyName = String(draft.armyName || "").trim();
  const lin = String(draft.lin || "").trim().toUpperCase();
  const description = String(draft.description || "").trim();
  const location = String(draft.location || "").trim();
  const title = commonName || armyName || lin || "New Item";

  const values = {
    LIN: lin,
    "Army Name": armyName,
    "Common Name": commonName,
    Description: description,
    Location: location
  };

  inventory.items.push({ title, fields: getDraftFields(values) });
  renderItems();

  const newIndex = inventory.items.length - 1;
  requestAnimationFrame(() => {
    const card = document.getElementById(`item-card-${newIndex}`);
    const titleInput = document.getElementById(`item-title-${newIndex}`);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    if (titleInput) titleInput.focus();
  });
}

function scannedItemDraftFlow(parsed) {
  const safeLine = escapeHtml(parsed.line || "");
  const safeLin = escapeHtml(parsed.lin || "");
  const safeArmyName = escapeHtml(parsed.armyName || parsed.line || "");
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="scan-text" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">Packet scan</p>
          <div class="modal-title">Create draft item</div>
        </div>
      </div>
      <p class="modal-copy">Check the OCR result, then add the friendly name your squad will actually recognize.</p>
      <div id="modalCandidateWrap" class="modal-stack hidden">
        <p class="modal-copy">I found multiple item rows. Tap the one you want to add.</p>
        <div id="modalCandidateList" class="candidate-list"></div>
      </div>

      <label class="field-label" for="modalOcrLine">OCR line</label>
      <textarea id="modalOcrLine" class="input ocr-textarea">${safeLine}</textarea>

      <label class="field-label" for="modalLin">LIN</label>
      <input id="modalLin" type="text" class="input" value="${safeLin}" />

      <label class="field-label" for="modalArmyName">Army name</label>
      <input id="modalArmyName" type="text" class="input" value="${safeArmyName}" />

      <label class="field-label" for="modalCommonName">Common name</label>
      <input id="modalCommonName" type="text" class="input" placeholder="example: CROWS turret" />

      <label class="field-label" for="modalLocation">Location</label>
      <input id="modalLocation" type="text" class="input" placeholder="example: arms room cage, shelf 2" />

      <div class="button-row">
        <button id="modalCreateDraftBtn" class="btn btn-primary">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>Create draft</span>
        </button>
        <button id="modalCancelBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Cancel</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const fillDraftFields = nextParsed => {
    const ocrInput = document.getElementById("modalOcrLine");
    const linInput = document.getElementById("modalLin");
    const armyNameInput = document.getElementById("modalArmyName");
    if (ocrInput) ocrInput.value = nextParsed.line || "";
    if (linInput) linInput.value = nextParsed.lin || "";
    if (armyNameInput) armyNameInput.value = nextParsed.armyName || nextParsed.line || "";
  };

  if (candidates.length > 1) {
    const wrap = document.getElementById("modalCandidateWrap");
    const list = document.getElementById("modalCandidateList");
    if (wrap && list) {
      wrap.classList.remove("hidden");
      candidates.forEach(candidate => {
        const button = document.createElement("button");
        button.className = "btn btn-secondary candidate-btn";
        button.type = "button";
        appendPacketCandidateContent(button, candidate);
        button.addEventListener("click", () => {
          fillDraftFields(candidate);
        });
        list.appendChild(button);
      });
    }
  }

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => closeModal());
  document.getElementById("modalOcrLine").addEventListener("blur", e => {
    const reparsed = parsePacketLine(e.target.value);
    const linInput = document.getElementById("modalLin");
    const armyNameInput = document.getElementById("modalArmyName");
    if (linInput && !linInput.value.trim()) linInput.value = reparsed.lin;
    if (armyNameInput && !armyNameInput.value.trim()) armyNameInput.value = reparsed.armyName;
  });

  document.getElementById("modalCreateDraftBtn").addEventListener("click", () => {
    const armyName = document.getElementById("modalArmyName").value.trim();
    const lin = document.getElementById("modalLin").value.trim();
    const commonName = document.getElementById("modalCommonName").value.trim();
    const location = document.getElementById("modalLocation").value.trim();

    if (!armyName && !lin && !commonName) {
      setModalStatus("Add at least a LIN, Army name, or common name", true);
      return;
    }

    addScannedItemDraft({ lin, armyName, commonName, location });
    setStatus("Draft item added", false);
    closeModal();
  });
}

async function scanItemToDraft(file, activeButton) {
  const scanBtn = activeButton || document.getElementById("scanItemBtn");
  if (!file) return;

  try {
    if (scanBtn) scanBtn.disabled = true;
    setStatus("Reading packet file...", false);
    const parsed = await recognizePacketFile(file, setStatus);
    setStatus("Packet text found", false);
    scannedItemDraftFlow(parsed);
  } catch (e) {
    setStatus(e.message || "Could not read that file", true);
  } finally {
    if (scanBtn) scanBtn.disabled = false;
  }
}

function deleteItem(itemIndex) {
  inventory.items.splice(itemIndex, 1);
  renderItems();
}

function addCustomField(itemIndex) {
  inventory.items[itemIndex].fields.push({ label: "New Field", value: "", _custom: true });
  renderItems();
}

function removeField(itemIndex, fieldIndex) {
  inventory.items[itemIndex].fields.splice(fieldIndex, 1);
  renderItems();
}

function addImageKey(itemIndex, fieldIndex, keyOrUrl) {
  const value = String(keyOrUrl || "").trim();
  if (!value) return;

  const field = inventory.items[itemIndex].fields[fieldIndex];
  if (!Array.isArray(field.value)) field.value = [];
  field.value.push(value);

  const idx = pendingDeletedImages.indexOf(value);
  if (idx !== -1) pendingDeletedImages.splice(idx, 1);
}

function removeImageAt(itemIndex, fieldIndex, imgIndex) {
  const field = inventory.items[itemIndex].fields[fieldIndex];
  if (!Array.isArray(field.value)) field.value = [];

  const key = String(field.value[imgIndex] || "").trim();
  field.value.splice(imgIndex, 1);

  if (key.startsWith("images/") && !pendingDeletedImages.includes(key)) {
    pendingDeletedImages.push(key);
  }
}

async function uploadImageForField(adminKey, itemIndex, fieldIndex, file) {
  const key = `images/${Date.now()}-${safeFileName(file.name)}`;

  const presign = await callApi(
    "/presign",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, contentType: file.type })
    },
    adminKey
  );

  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file
  });

  if (!putRes.ok) throw new Error("Upload failed: " + putRes.status);

  addImageKey(itemIndex, fieldIndex, presign.key);
}

function renderItems() {
  const container = document.getElementById("itemsContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!inventory.items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No equipment has been added yet. Use Add item to start a platoon list.";
    container.appendChild(empty);
    refreshIcons();
    return;
  }

  inventory.items.forEach((item, itemIndex) => {
    const card = document.createElement("div");
    card.id = `item-card-${itemIndex}`;
    card.className = "editor-card";

    const titleRow = document.createElement("div");
    titleRow.className = "editor-card-header";

    const titleInput = document.createElement("input");
    titleInput.id = `item-title-${itemIndex}`;
    titleInput.className = "input title-input";
    titleInput.placeholder = "Equipment name";
    titleInput.value = item.title || "";
    titleInput.addEventListener("input", e => {
      inventory.items[itemIndex].title = e.target.value;
    });

    const addFieldBtn = document.createElement("button");
    addFieldBtn.className = "btn btn-secondary btn-small";
    setButtonContent(addFieldBtn, "list-plus", "Add field");
    addFieldBtn.addEventListener("click", () => addCustomField(itemIndex));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-danger btn-small";
    setButtonContent(deleteBtn, "trash-2", "Delete item");
    deleteBtn.addEventListener("click", () => deleteItem(itemIndex));

    const itemActions = document.createElement("details");
    itemActions.className = "action-menu item-actions";

    const itemActionsSummary = document.createElement("summary");
    itemActionsSummary.className = "btn btn-secondary btn-small";
    setButtonContent(itemActionsSummary, "more-horizontal", "Item actions");

    const itemActionsPanel = document.createElement("div");
    itemActionsPanel.className = "menu-panel";
    itemActionsPanel.appendChild(addFieldBtn);
    itemActionsPanel.appendChild(deleteBtn);
    itemActions.appendChild(itemActionsSummary);
    itemActions.appendChild(itemActionsPanel);

    titleRow.appendChild(titleInput);
    titleRow.appendChild(itemActions);
    card.appendChild(titleRow);

    const fieldList = document.createElement("div");
    fieldList.className = "field-editor-list";

    item.fields.forEach((field, fieldIndex) => {
      const row = document.createElement("div");
      row.className = "field-editor-row";

      const labelCell = document.createElement("div");
      labelCell.className = "field-editor-label";

      const valueCell = document.createElement("div");
      valueCell.className = "field-editor-control";

      const removeFieldBtn = document.createElement("button");
      removeFieldBtn.className = "btn btn-subtle btn-small field-remove-btn";
      removeFieldBtn.title = "Remove field";
      removeFieldBtn.setAttribute("aria-label", "Remove field");
      setButtonContent(removeFieldBtn, "x", "Remove");
      removeFieldBtn.addEventListener("click", () => removeField(itemIndex, fieldIndex));

      const isImage = String(field.label || "").toLowerCase() === "image";

      if (field._custom) {
        const labelInput = document.createElement("input");
        labelInput.className = "input";
        labelInput.value = field.label || "";
        labelInput.addEventListener("input", e => {
          inventory.items[itemIndex].fields[fieldIndex].label = e.target.value;
        });

        const top = document.createElement("div");
        top.className = "field-editor-top";

        const name = document.createElement("div");
        name.textContent = "Field label";

        top.appendChild(name);
        top.appendChild(removeFieldBtn);

        labelCell.appendChild(top);
        labelCell.appendChild(labelInput);
      } else {
        const top = document.createElement("div");
        top.className = "field-editor-top";

        const name = document.createElement("div");
        name.textContent = field.label || "";

        top.appendChild(name);
        top.appendChild(removeFieldBtn);

        labelCell.appendChild(top);
      }

      if (!isImage) {
        const valueInput = document.createElement("input");
        valueInput.className = "input";
        valueInput.placeholder = "Not recorded";
        valueInput.value = field.value || "";
        valueInput.addEventListener("input", e => {
          inventory.items[itemIndex].fields[fieldIndex].value = e.target.value;
        });

        valueCell.appendChild(valueInput);
      } else {
        if (!Array.isArray(field.value)) inventory.items[itemIndex].fields[fieldIndex].value = [];
        const images = inventory.items[itemIndex].fields[fieldIndex].value;

        const grid = document.createElement("div");
        grid.className = "image-thumb-grid";

        images.forEach((imgKeyOrUrl, imgIndex) => {
          const wrap = document.createElement("div");
          wrap.className = "image-thumb";

          const img = document.createElement("img");
          img.src = normalizeImageSrc(imgKeyOrUrl);
          img.alt = item.title || "Image";
          img.loading = "lazy";

          const small = document.createElement("div");
          small.className = "image-key";
          small.textContent = imgKeyOrUrl;

          const rm = document.createElement("button");
          rm.className = "btn btn-subtle btn-small btn-full";
          setButtonContent(rm, "image-minus", "Remove image");
          rm.addEventListener("click", () => {
            removeImageAt(itemIndex, fieldIndex, imgIndex);
            renderItems();
          });

          wrap.appendChild(img);
          wrap.appendChild(small);
          wrap.appendChild(rm);
          grid.appendChild(wrap);
        });

        if (!images.length) {
          const emptyImage = document.createElement("div");
          emptyImage.className = "empty-state";
          emptyImage.textContent = "No photos attached to this item.";
          grid.appendChild(emptyImage);
        }

        const controls = document.createElement("div");
        controls.className = "upload-controls";

        const addRow = document.createElement("div");
        addRow.className = "inline-control";

        const addInput = document.createElement("input");
        addInput.className = "input";
        addInput.placeholder = "Paste an image key like images/file.jpg";

        const addBtn = document.createElement("button");
        addBtn.className = "btn btn-secondary";
        setButtonContent(addBtn, "link", "Add image");
        addBtn.addEventListener("click", () => {
          addImageKey(itemIndex, fieldIndex, addInput.value);
          addInput.value = "";
          renderItems();
        });

        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);

        const uploadRow = document.createElement("div");
        uploadRow.className = "inline-control";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.className = "file-input";

        const uploadBtn = document.createElement("button");
        uploadBtn.className = "btn btn-accent";
        setButtonContent(uploadBtn, "upload", "Upload image");
        uploadBtn.addEventListener("click", async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) {
            setStatus("Choose a file first", true);
            return;
          }

          try {
            setStatus("Uploading...", false);
            await uploadImageForField(getAdminKeyFromSession(), itemIndex, fieldIndex, file);
            fileInput.value = "";
            renderItems();
            setStatus("Uploaded", false);
          } catch (e) {
            setStatus(e.message, true);
          }
        });

        uploadRow.appendChild(fileInput);
        uploadRow.appendChild(uploadBtn);

        controls.appendChild(addRow);
        controls.appendChild(uploadRow);

        valueCell.appendChild(grid);

        const photoTools = document.createElement("details");
        photoTools.className = "disclosure";

        const photoSummary = document.createElement("summary");
        photoSummary.className = "btn btn-secondary btn-full";
        setButtonContent(photoSummary, "settings-2", "Photo tools");

        const photoPanel = document.createElement("div");
        photoPanel.className = "disclosure-panel";
        photoPanel.appendChild(controls);

        photoTools.appendChild(photoSummary);
        photoTools.appendChild(photoPanel);
        valueCell.appendChild(photoTools);
      }

      row.appendChild(labelCell);
      row.appendChild(valueCell);
      fieldList.appendChild(row);
    });

    card.appendChild(fieldList);
    container.appendChild(card);
  });

  refreshIcons();
}

async function signInFlow() {
  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="shield-check" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">Admin access</p>
          <div class="modal-title">Sign in</div>
        </div>
      </div>

      <label class="field-label" for="modalAdminKey">Admin key</label>
      <input id="modalAdminKey" type="password" class="input" />

      <label class="field-label" for="modalPlatoonSelect">Platoon</label>
      <select id="modalPlatoonSelect" class="select"></select>

      <label class="field-label" for="modalPlatoonPw">Platoon password</label>
      <input id="modalPlatoonPw" type="password" class="input" />

      <div class="button-row">
        <button id="modalSignInBtn" class="btn btn-primary">
          <i data-lucide="log-in" aria-hidden="true"></i>
          <span>Sign in</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  const modalPlatoonSelect = document.getElementById("modalPlatoonSelect");
  modalPlatoonSelect.innerHTML = "";
  (indexData.platoons || []).forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || p.id;
    modalPlatoonSelect.appendChild(opt);
  });

  document.getElementById("modalSignInBtn").addEventListener("click", async () => {
    setModalStatus("Signing in...", false);

    const adminKey = document.getElementById("modalAdminKey").value.trim();
    const platoonId = document.getElementById("modalPlatoonSelect").value;
    const platoonPw = document.getElementById("modalPlatoonPw").value;

    if (!adminKey || !platoonPw || !platoonId) {
      setModalStatus("Enter admin key and platoon password", true);
      return;
    }

    try {
      await verifyAdminKey(adminKey);
    } catch {
      setModalStatus("Wrong admin key", true);
      return;
    }

    const platoon = getPlatoonById(platoonId);
    if (!platoon) {
      setModalStatus("Invalid platoon", true);
      return;
    }

    let loaded;
    try {
      loaded = await loadPlatoonInventory(platoon);
    } catch {
      setModalStatus("Failed to load platoon", true);
      return;
    }

    if (platoonPw !== loaded.password) {
      setModalStatus("Wrong platoon password", true);
      return;
    }

    setAdminKeySession(adminKey);
    isAuthed = true;
    currentPlatoon = platoon;
    inventory = loaded;
    applyTemplates();
    clearPendingDeletes();

    populatePlatoonSelect(platoon.id);
    lastPlatoonId = platoon.id;

    setAppVisible();
    renderItems();
    setStatus("Signed in", false);
    closeModal();
  });
}

async function switchPlatoonFlow(nextPlatoonId) {
  const platoon = getPlatoonById(nextPlatoonId);
  if (!platoon) return;
  const platoonName = escapeHtml(platoon.name || platoon.id);

  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="repeat-2" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">Switch list</p>
          <div class="modal-title">Switch platoon</div>
        </div>
      </div>
      <p class="modal-copy">Enter the password for ${platoonName}.</p>

      <label class="field-label" for="modalSwitchPw">Platoon password</label>
      <input id="modalSwitchPw" type="password" class="input" />

      <div class="button-row">
        <button id="modalSwitchBtn" class="btn btn-primary">
          <i data-lucide="check" aria-hidden="true"></i>
          <span>Switch</span>
        </button>
        <button id="modalCancelBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Cancel</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => {
    closeModal();
    populatePlatoonSelect(lastPlatoonId);
  });

  document.getElementById("modalSwitchBtn").addEventListener("click", async () => {
    setModalStatus("Loading...", false);
    const pw = document.getElementById("modalSwitchPw").value;

    let loaded;
    try {
      loaded = await loadPlatoonInventory(platoon);
    } catch {
      setModalStatus("Failed to load platoon", true);
      return;
    }

    if (pw !== loaded.password) {
      setModalStatus("Wrong password", true);
      return;
    }

    currentPlatoon = platoon;
    inventory = loaded;
    applyTemplates();
    clearPendingDeletes();
    lastPlatoonId = platoon.id;

    renderItems();
    setStatus("Loaded", false);
    closeModal();
  });
}

function addPlatoonFlow() {
  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="users-round" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">New unit list</p>
          <div class="modal-title">Add platoon</div>
        </div>
      </div>

      <label class="field-label" for="modalPlatoonId">Platoon id</label>
      <input id="modalPlatoonId" type="text" class="input" placeholder="example: 2nd" />

      <label class="field-label" for="modalPlatoonName">Platoon name</label>
      <input id="modalPlatoonName" type="text" class="input" placeholder="example: 2nd Platoon" />

      <label class="field-label" for="modalPw1">Platoon password</label>
      <input id="modalPw1" type="password" class="input" />

      <label class="field-label" for="modalPw2">Confirm password</label>
      <input id="modalPw2" type="password" class="input" />

      <div class="button-row">
        <button id="modalCreateBtn" class="btn btn-primary">
          <i data-lucide="plus" aria-hidden="true"></i>
          <span>Create</span>
        </button>
        <button id="modalCancelBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Cancel</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => closeModal());

  document.getElementById("modalCreateBtn").addEventListener("click", async () => {
    const id = document.getElementById("modalPlatoonId").value.trim();
    const name = document.getElementById("modalPlatoonName").value.trim();
    const pw1 = document.getElementById("modalPw1").value;
    const pw2 = document.getElementById("modalPw2").value;

    if (!id || !name || !pw1 || !pw2) {
      setModalStatus("Fill out all fields", true);
      return;
    }

    if (pw1 !== pw2) {
      setModalStatus("Passwords do not match", true);
      return;
    }

    setModalStatus("Creating...", false);

    try {
      await callApi(
        "/platoon",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, name, password: pw1 })
        },
        getAdminKeyFromSession()
      );
    } catch (e) {
      setModalStatus(e.message, true);
      return;
    }

    try {
      await loadIndex();
    } catch {
      setModalStatus("Created, but failed to reload index.json", true);
      return;
    }

    const p = getPlatoonById(id);
    if (!p) {
      setModalStatus("Created, but could not find new platoon", true);
      return;
    }

    currentPlatoon = p;
    inventory = { password: pw1, items: [] };
    applyTemplates();
    clearPendingDeletes();
    lastPlatoonId = p.id;

    populatePlatoonSelect(p.id);
    renderItems();
    setStatus("Platoon created", false);
    closeModal();
  });
}

function changePasswordFlow() {
  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="key-round" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">Access control</p>
          <div class="modal-title">Change password</div>
        </div>
      </div>

      <label class="field-label" for="modalPw1">New password</label>
      <input id="modalPw1" type="password" class="input" />

      <label class="field-label" for="modalPw2">Confirm password</label>
      <input id="modalPw2" type="password" class="input" />

      <div class="button-row">
        <button id="modalUpdateBtn" class="btn btn-primary">
          <i data-lucide="save" aria-hidden="true"></i>
          <span>Update</span>
        </button>
        <button id="modalCancelBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Cancel</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => closeModal());

  document.getElementById("modalUpdateBtn").addEventListener("click", async () => {
    const pw1 = document.getElementById("modalPw1").value;
    const pw2 = document.getElementById("modalPw2").value;

    if (!pw1 || !pw2) {
      setModalStatus("Enter password twice", true);
      return;
    }

    if (pw1 !== pw2) {
      setModalStatus("Passwords do not match", true);
      return;
    }

    inventory.password = pw1;

    setModalStatus("Saving...", false);
    try {
      await saveInventory(getAdminKeyFromSession());
    } catch (e) {
      setModalStatus(e.message, true);
      return;
    }

    setStatus("Password updated", false);
    closeModal();
  });
}

function deletePlatoonFlow() {
  const platoon = currentPlatoon;
  if (!platoon) return;

  openModal(`
    <div class="modal-stack">
      <div class="modal-heading">
        <span class="modal-icon"><i data-lucide="triangle-alert" aria-hidden="true"></i></span>
        <div>
          <p class="eyebrow">Destructive action</p>
          <div class="modal-title">Delete platoon</div>
        </div>
      </div>
      <p class="modal-copy">This will delete platoon data and images not used anywhere else.</p>
      <p class="modal-copy">Type permanently delete to confirm.</p>
      <input id="modalConfirmText" type="text" class="input" placeholder="permanently delete" />

      <div class="button-row">
        <button id="modalDeleteBtn" class="btn btn-danger">
          <i data-lucide="trash-2" aria-hidden="true"></i>
          <span>Delete</span>
        </button>
        <button id="modalCancelBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Cancel</span>
        </button>
        <div id="modalStatus" class="status-text"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "status-text error" : "status-text";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => closeModal());

  document.getElementById("modalDeleteBtn").addEventListener("click", async () => {
    const confirmText = document.getElementById("modalConfirmText").value.trim();
    if (confirmText !== "permanently delete") {
      setModalStatus("Type permanently delete exactly", true);
      return;
    }

    setModalStatus("Deleting...", false);

    try {
      await callApi(
        "/platoon/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: platoon.id, confirm: "permanently delete" })
        },
        getAdminKeyFromSession()
      );
    } catch (e) {
      setModalStatus(e.message, true);
      return;
    }

    closeModal();
    signOutToSignIn();
  });
}

function signOutToSignIn() {
  isAuthed = false;
  indexData = null;
  currentPlatoon = null;
  inventory = null;
  templateLabels = [];
  lastPlatoonId = null;
  clearSession();
  clearPendingDeletes();
  setAppHidden();
  setStatus("", false);

  loadIndex()
    .then(() => signInFlow())
    .catch(e => {
      const message = escapeHtml(e.message || "Failed to load index.json");
      openModal(`
        <div class="modal-stack">
          <div class="modal-heading">
            <span class="modal-icon"><i data-lucide="circle-alert" aria-hidden="true"></i></span>
            <div>
              <p class="eyebrow">Connection issue</p>
              <div class="modal-title">Error</div>
            </div>
          </div>
          <div class="status-text error">${message}</div>
          <button id="modalCloseBtn" class="btn btn-secondary">
            <i data-lucide="x" aria-hidden="true"></i>
            <span>Close</span>
          </button>
        </div>
      `);
      const btn = document.getElementById("modalCloseBtn");
      if (btn) btn.addEventListener("click", () => closeModal());
    });
}

document.addEventListener("DOMContentLoaded", async () => {
  setAppHidden();
  setStatus("", false);

  try {
    await loadIndex();
  } catch (e) {
    const message = escapeHtml(e.message || "Failed to load index.json");
    openModal(`
      <div class="modal-stack">
        <div class="modal-heading">
          <span class="modal-icon"><i data-lucide="circle-alert" aria-hidden="true"></i></span>
          <div>
            <p class="eyebrow">Connection issue</p>
            <div class="modal-title">Error</div>
          </div>
        </div>
        <div class="status-text error">${message}</div>
        <button id="modalCloseBtn" class="btn btn-secondary">
          <i data-lucide="x" aria-hidden="true"></i>
          <span>Close</span>
        </button>
      </div>
    `);
    const btn = document.getElementById("modalCloseBtn");
    if (btn) btn.addEventListener("click", () => closeModal());
    return;
  }

  const backdrop = document.getElementById("modalBackdrop");
  if (backdrop) {
    backdrop.addEventListener("click", e => {
      if (e.target && e.target.id === "modalBackdrop") closeModal();
    });
  }

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        await saveInventory(getAdminKeyFromSession());
      } catch (e) {
        setStatus(e.message, true);
      }
    });
  }

  const addItemBtn = document.getElementById("addItemBtn");
  if (addItemBtn) {
    addItemBtn.addEventListener("click", () => addItem());
  }

  const scanItemBtn = document.getElementById("scanItemBtn");
  const uploadDocBtn = document.getElementById("uploadDocBtn");
  const adminCameraInput = document.getElementById("adminCameraInput");
  const adminFileInput = document.getElementById("adminFileInput");
  if (scanItemBtn && adminCameraInput) {
    scanItemBtn.addEventListener("click", () => adminCameraInput.click());
    adminCameraInput.addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      scanItemToDraft(file, scanItemBtn);
      e.target.value = "";
    });
  }
  if (uploadDocBtn && adminFileInput) {
    uploadDocBtn.addEventListener("click", () => adminFileInput.click());
    adminFileInput.addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      scanItemToDraft(file, uploadDocBtn);
      e.target.value = "";
    });
  }

  const signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) {
    signOutBtn.addEventListener("click", () => signOutToSignIn());
  }

  const addPlatoonBtn = document.getElementById("addPlatoonBtn");
  if (addPlatoonBtn) {
    addPlatoonBtn.addEventListener("click", () => addPlatoonFlow());
  }

  const changePwBtn = document.getElementById("changePwBtn");
  if (changePwBtn) {
    changePwBtn.addEventListener("click", () => {
      if (!isAuthed || !inventory) return;
      changePasswordFlow();
    });
  }

  const deletePlatoonBtn = document.getElementById("deletePlatoonBtn");
  if (deletePlatoonBtn) {
    deletePlatoonBtn.addEventListener("click", () => {
      if (!isAuthed || !currentPlatoon) return;
      deletePlatoonFlow();
    });
  }

  const platoonSelect = document.getElementById("platoonSelect");
  if (platoonSelect) {
    platoonSelect.addEventListener("change", async e => {
      if (!isAuthed || !indexData) return;
      const nextId = e.target.value;
      if (!nextId || nextId === lastPlatoonId) return;
      await switchPlatoonFlow(nextId);
    });
  }

  signInFlow();
});
