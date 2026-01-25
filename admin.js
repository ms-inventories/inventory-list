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

function setStatus(text, isError) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "text-sm text-red-300" : "text-sm text-gray-300";
}

function normalizeImageSrc(src) {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  return IMAGE_BASE_URL + src.replace(/^\/+/, "");
}

function safeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function openModal(html) {
  const backdrop = document.getElementById("modalBackdrop");
  const panel = document.getElementById("modalPanel");
  if (!backdrop || !panel) return;
  panel.innerHTML = html;
  backdrop.classList.remove("hidden");
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

  const imageIndex = labels.findIndex(l => l.toLowerCase() === "image");
  if (imageIndex > 0) {
    const imageLabel = labels.splice(imageIndex, 1)[0];
    labels.unshift(imageLabel);
  }

  if (labels.length === 0) {
    return ["Image", "NSN", "SN", "Description", "Location", "OH Qty", "Actual"];
  }

  return labels;
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

  inventory.items.forEach((item, itemIndex) => {
    const card = document.createElement("div");
    card.id = `item-card-${itemIndex}`;
    card.className = "border border-gray-700 rounded p-4";

    const titleRow = document.createElement("div");
    titleRow.className = "flex flex-wrap gap-2 items-center mb-4";

    const titleInput = document.createElement("input");
    titleInput.id = `item-title-${itemIndex}`;
    titleInput.className = "flex-1 min-w-[280px] text-gray-900 px-3 py-2 rounded text-xl font-bold";
    titleInput.value = item.title || "";
    titleInput.addEventListener("input", e => {
      inventory.items[itemIndex].title = e.target.value;
    });

    const addFieldBtn = document.createElement("button");
    addFieldBtn.className = "bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded";
    addFieldBtn.textContent = "Add field";
    addFieldBtn.addEventListener("click", () => addCustomField(itemIndex));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "bg-red-600 hover:bg-red-700 px-3 py-2 rounded";
    deleteBtn.textContent = "Delete item";
    deleteBtn.addEventListener("click", () => deleteItem(itemIndex));

    titleRow.appendChild(titleInput);
    titleRow.appendChild(addFieldBtn);
    titleRow.appendChild(deleteBtn);
    card.appendChild(titleRow);

    const table = document.createElement("table");
    table.className = "table-auto w-full border border-gray-700";

    item.fields.forEach((field, fieldIndex) => {
      const row = document.createElement("tr");
      row.className = "border border-gray-700";

      const labelCell = document.createElement("td");
      labelCell.className = "p-2 font-semibold w-1/4 border border-gray-700 align-top";

      const valueCell = document.createElement("td");
      valueCell.className = "p-2 border border-gray-700";

      const removeFieldBtn = document.createElement("button");
      removeFieldBtn.className = "bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-sm";
      removeFieldBtn.textContent = "Remove";
      removeFieldBtn.addEventListener("click", () => removeField(itemIndex, fieldIndex));

      const isImage = String(field.label || "").toLowerCase() === "image";

      if (field._custom) {
        const labelInput = document.createElement("input");
        labelInput.className = "w-full text-gray-900 px-3 py-2 rounded";
        labelInput.value = field.label || "";
        labelInput.addEventListener("input", e => {
          inventory.items[itemIndex].fields[fieldIndex].label = e.target.value;
        });

        const top = document.createElement("div");
        top.className = "flex items-center justify-between gap-2 mb-2";

        const name = document.createElement("div");
        name.textContent = "Field label";

        top.appendChild(name);
        top.appendChild(removeFieldBtn);

        labelCell.appendChild(top);
        labelCell.appendChild(labelInput);
      } else {
        const top = document.createElement("div");
        top.className = "flex items-center justify-between gap-2";

        const name = document.createElement("div");
        name.textContent = field.label || "";

        top.appendChild(name);
        top.appendChild(removeFieldBtn);

        labelCell.appendChild(top);
      }

      if (!isImage) {
        const valueInput = document.createElement("input");
        valueInput.className = "w-full text-gray-900 px-3 py-2 rounded";
        valueInput.value = field.value || "";
        valueInput.addEventListener("input", e => {
          inventory.items[itemIndex].fields[fieldIndex].value = e.target.value;
        });

        valueCell.appendChild(valueInput);
      } else {
        if (!Array.isArray(field.value)) inventory.items[itemIndex].fields[fieldIndex].value = [];
        const images = inventory.items[itemIndex].fields[fieldIndex].value;

        const grid = document.createElement("div");
        grid.className = "flex flex-wrap gap-3";

        images.forEach((imgKeyOrUrl, imgIndex) => {
          const wrap = document.createElement("div");
          wrap.className = "border border-gray-700 rounded p-2";

          const img = document.createElement("img");
          img.className = "max-h-32";
          img.src = normalizeImageSrc(imgKeyOrUrl);
          img.alt = item.title || "Image";

          const small = document.createElement("div");
          small.className = "text-xs text-gray-400 mt-2 break-all max-w-[220px]";
          small.textContent = imgKeyOrUrl;

          const rm = document.createElement("button");
          rm.className = "mt-2 bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-sm w-full";
          rm.textContent = "Remove image";
          rm.addEventListener("click", () => {
            removeImageAt(itemIndex, fieldIndex, imgIndex);
            renderItems();
          });

          wrap.appendChild(img);
          wrap.appendChild(small);
          wrap.appendChild(rm);
          grid.appendChild(wrap);
        });

        const controls = document.createElement("div");
        controls.className = "mt-4 flex flex-col gap-3";

        const addRow = document.createElement("div");
        addRow.className = "flex flex-wrap gap-2 items-center";

        const addInput = document.createElement("input");
        addInput.className = "flex-1 min-w-[260px] text-gray-900 px-3 py-2 rounded";
        addInput.placeholder = "Paste an image key like images/file.jpg";

        const addBtn = document.createElement("button");
        addBtn.className = "bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded";
        addBtn.textContent = "Add image";
        addBtn.addEventListener("click", () => {
          addImageKey(itemIndex, fieldIndex, addInput.value);
          addInput.value = "";
          renderItems();
        });

        addRow.appendChild(addInput);
        addRow.appendChild(addBtn);

        const uploadRow = document.createElement("div");
        uploadRow.className = "flex flex-wrap gap-2 items-center";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.className = "text-sm";

        const uploadBtn = document.createElement("button");
        uploadBtn.className = "bg-purple-600 hover:bg-purple-700 px-3 py-2 rounded";
        uploadBtn.textContent = "Upload images";
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
        valueCell.appendChild(controls);
      }

      row.appendChild(labelCell);
      row.appendChild(valueCell);
      table.appendChild(row);
    });

    card.appendChild(table);
    container.appendChild(card);
  });
}

async function signInFlow() {
  openModal(`
    <div class="flex flex-col gap-3">
      <div class="text-xl font-bold">Sign in</div>

      <label class="text-sm text-gray-300">Admin key</label>
      <input id="modalAdminKey" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <label class="text-sm text-gray-300">Platoon</label>
      <select id="modalPlatoonSelect" class="text-gray-900 px-3 py-2 rounded"></select>

      <label class="text-sm text-gray-300">Platoon password</label>
      <input id="modalPlatoonPw" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <div class="flex gap-2 items-center mt-2">
        <button id="modalSignInBtn" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Sign in</button>
        <div id="modalStatus" class="text-sm text-gray-300"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "text-sm text-red-300" : "text-sm text-gray-300";
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

  openModal(`
    <div class="flex flex-col gap-3">
      <div class="text-xl font-bold">Switch platoon</div>
      <div class="text-sm text-gray-300">Enter password for ${platoon.name || platoon.id}</div>

      <label class="text-sm text-gray-300">Platoon password</label>
      <input id="modalSwitchPw" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <div class="flex gap-2 items-center mt-2">
        <button id="modalSwitchBtn" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Switch</button>
        <button id="modalCancelBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded">Cancel</button>
        <div id="modalStatus" class="text-sm text-gray-300"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "text-sm text-red-300" : "text-sm text-gray-300";
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
    <div class="flex flex-col gap-3">
      <div class="text-xl font-bold">Add platoon</div>

      <label class="text-sm text-gray-300">Platoon id</label>
      <input id="modalPlatoonId" type="text" class="text-gray-900 px-3 py-2 rounded" placeholder="example: 2nd" />

      <label class="text-sm text-gray-300">Platoon name</label>
      <input id="modalPlatoonName" type="text" class="text-gray-900 px-3 py-2 rounded" placeholder="example: 2nd Platoon" />

      <label class="text-sm text-gray-300">Platoon password</label>
      <input id="modalPw1" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <label class="text-sm text-gray-300">Confirm password</label>
      <input id="modalPw2" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <div class="flex gap-2 items-center mt-2">
        <button id="modalCreateBtn" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Create</button>
        <button id="modalCancelBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded">Cancel</button>
        <div id="modalStatus" class="text-sm text-gray-300"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "text-sm text-red-300" : "text-sm text-gray-300";
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
    <div class="flex flex-col gap-3">
      <div class="text-xl font-bold">Change password</div>

      <label class="text-sm text-gray-300">New password</label>
      <input id="modalPw1" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <label class="text-sm text-gray-300">Confirm password</label>
      <input id="modalPw2" type="password" class="text-gray-900 px-3 py-2 rounded" />

      <div class="flex gap-2 items-center mt-2">
        <button id="modalUpdateBtn" class="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Update</button>
        <button id="modalCancelBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded">Cancel</button>
        <div id="modalStatus" class="text-sm text-gray-300"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "text-sm text-red-300" : "text-sm text-gray-300";
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
    <div class="flex flex-col gap-3">
      <div class="text-xl font-bold">Delete platoon</div>
      <div class="text-sm text-red-300">This will delete platoon data and delete images not used anywhere else.</div>
      <div class="text-sm text-gray-300">Type permanently delete to confirm:</div>
      <input id="modalConfirmText" type="text" class="text-gray-900 px-3 py-2 rounded" />

      <div class="flex gap-2 items-center mt-2">
        <button id="modalDeleteBtn" class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded">Delete</button>
        <button id="modalCancelBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded">Cancel</button>
        <div id="modalStatus" class="text-sm text-gray-300"></div>
      </div>
    </div>
  `);

  const modalStatus = document.getElementById("modalStatus");
  const setModalStatus = (t, e) => {
    modalStatus.textContent = t || "";
    modalStatus.className = e ? "text-sm text-red-300" : "text-sm text-gray-300";
  };

  document.getElementById("modalCancelBtn").addEventListener("click", () => closeModal());

  document.getElementById("modalDeleteBtn").addEventListener("click", async () => {
    const confirmText = document.getElementById("modalConfirmText").value.trim();
    if (confirmText !== "permanently delete") {
      setModalStatus("You must type permanently delete", true);
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
      openModal(`
        <div class="flex flex-col gap-3">
          <div class="text-xl font-bold">Error</div>
          <div class="text-sm text-red-300">${String(e.message || "Failed to load index.json")}</div>
          <button id="modalCloseBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded mt-2">Close</button>
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
    openModal(`
      <div class="flex flex-col gap-3">
        <div class="text-xl font-bold">Error</div>
        <div class="text-sm text-red-300">${String(e.message || "Failed to load index.json")}</div>
        <button id="modalCloseBtn" class="bg-gray-800 hover:bg-gray-700 px-4 py-2 rounded mt-2">Close</button>
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
