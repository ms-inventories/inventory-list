const INVENTORY_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/inventory.json";
const IMAGE_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/";
const API_BASE_URL = "https://j2pdaptydpur4jjasyl7pz3xc40ckbqd.lambda-url.us-east-1.on.aws";

let inventory = null;
let templateLabels = [];

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  el.className = isError ? "text-sm text-red-300" : "text-sm text-gray-300";
}

function getSitePasswordInput() {
  return document.getElementById("sitePwInput").value;
}

function getAdminKey() {
  return document.getElementById("adminKeyInput").value.trim();
}

function normalizeImageSrc(src) {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("images/")) return IMAGE_BASE_URL + src.replace(/^\/+/, "");
  return src;
}

function safeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_");
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

async function loadInventory() {
  setStatus("Loading...", false);

  const res = await fetch(INVENTORY_URL + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load inventory.json from S3");

  const data = await res.json();
  inventory = ensureInventoryShape(data);

  const typedPw = getSitePasswordInput();
  if (typedPw !== inventory.password) {
    inventory = null;
    throw new Error("Wrong site password");
  }

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

  renderItems();
  setStatus("Loaded", false);
}

async function callApi(path, options) {
  const requestOptions = options || {};
  const requestHeaders = requestOptions.headers || {};

  const adminKey = getAdminKey();
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

async function saveInventory() {
  if (!inventory) throw new Error("Load inventory first");

  setStatus("Saving...", false);

  const payload = buildSavePayload();

  await callApi("/inventory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  setStatus("Saved", false);
}

function addItem() {
  if (!inventory) {
    setStatus("Load inventory first", true);
    return;
  }

  const fields = templateLabels.map(label => {
    const isImage = label.toLowerCase() === "image";
    return { label, value: isImage ? [] : "", _custom: false };
  });

  inventory.items.push({ title: "New Item", fields });
  renderItems();
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
}

function removeImageAt(itemIndex, fieldIndex, imgIndex) {
  const field = inventory.items[itemIndex].fields[fieldIndex];
  if (!Array.isArray(field.value)) field.value = [];
  field.value.splice(imgIndex, 1);
}

async function uploadImageForField(itemIndex, fieldIndex, file) {
  const safeName = safeFileName(file.name);
  const key = `images/${Date.now()}-${safeName}`;

  const presign = await callApi("/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, contentType: file.type })
  });

  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file
  });

  if (!putRes.ok) throw new Error("S3 upload failed: " + putRes.status);

  addImageKey(itemIndex, fieldIndex, presign.key);
}

function renderItems() {
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  inventory.items.forEach((item, itemIndex) => {
    const card = document.createElement("div");
    card.className = "border border-gray-700 rounded p-4";

    const header = document.createElement("div");
    header.className = "flex flex-col gap-3 mb-4";

    const titleRow = document.createElement("div");
    titleRow.className = "flex flex-wrap gap-3 items-center";

    const titleInput = document.createElement("input");
    titleInput.className = "flex-1 min-w-[280px] text-gray-900 px-3 py-2 rounded text-xl font-bold";
    titleInput.value = item.title || "";
    titleInput.addEventListener("input", e => {
      inventory.items[itemIndex].title = e.target.value;
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "bg-red-600 hover:bg-red-700 px-3 py-2 rounded";
    deleteBtn.textContent = "Delete Item";
    deleteBtn.addEventListener("click", () => {
      deleteItem(itemIndex);
    });

    const addFieldBtn = document.createElement("button");
    addFieldBtn.className = "bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded";
    addFieldBtn.textContent = "Add Field";
    addFieldBtn.addEventListener("click", () => {
      addCustomField(itemIndex);
    });

    titleRow.appendChild(titleInput);
    titleRow.appendChild(addFieldBtn);
    titleRow.appendChild(deleteBtn);

    header.appendChild(titleRow);
    card.appendChild(header);

    const table = document.createElement("table");
    table.className = "table-auto w-full border border-gray-700";

    item.fields.forEach((field, fieldIndex) => {
      const row = document.createElement("tr");
      row.className = "border border-gray-700";

      const labelCell = document.createElement("td");
      labelCell.className = "p-2 font-semibold w-1/4 border border-gray-700 align-top";

      const valueCell = document.createElement("td");
      valueCell.className = "p-2 border border-gray-700";

      const labelText = document.createElement("div");
      labelText.className = "flex items-center justify-between gap-2";

      const labelLeft = document.createElement("div");
      labelLeft.textContent = field.label || "";

      const removeFieldBtn = document.createElement("button");
      removeFieldBtn.className = "bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded text-sm";
      removeFieldBtn.textContent = "Remove";
      removeFieldBtn.addEventListener("click", () => {
        removeField(itemIndex, fieldIndex);
      });

      labelText.appendChild(labelLeft);
      labelText.appendChild(removeFieldBtn);
      labelCell.appendChild(labelText);

      const isImage = String(field.label || "").toLowerCase() === "image";

      if (!isImage) {
        const valueInput = document.createElement("input");
        valueInput.className = "w-full text-gray-900 px-3 py-2 rounded";
        valueInput.value = field.value || "";
        valueInput.addEventListener("input", e => {
          inventory.items[itemIndex].fields[fieldIndex].value = e.target.value;
        });

        const labelEditWrap = document.createElement("div");
        labelEditWrap.className = "mt-2";

        if (field._custom) {
          const labelInput = document.createElement("input");
          labelInput.className = "w-full text-gray-900 px-3 py-2 rounded";
          labelInput.value = field.label || "";
          labelInput.addEventListener("input", e => {
            inventory.items[itemIndex].fields[fieldIndex].label = e.target.value;
          });

          labelCell.innerHTML = "";
          const customLabelTitle = document.createElement("div");
          customLabelTitle.className = "flex items-center justify-between gap-2 mb-2";

          const customLabelName = document.createElement("div");
          customLabelName.className = "font-semibold";
          customLabelName.textContent = "Field Label";

          customLabelTitle.appendChild(customLabelName);
          customLabelTitle.appendChild(removeFieldBtn);

          labelCell.appendChild(customLabelTitle);
          labelCell.appendChild(labelInput);
        }

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
          rm.textContent = "Remove Image";
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
        addInput.placeholder = "Paste an image key like images/file.jpg (or a full URL)";

        const addBtn = document.createElement("button");
        addBtn.className = "bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded";
        addBtn.textContent = "Add";
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
        uploadBtn.textContent = "Upload to S3";
        uploadBtn.addEventListener("click", async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) {
            setStatus("Choose a file first", true);
            return;
          }

          try {
            setStatus("Uploading image...", false);
            await uploadImageForField(itemIndex, fieldIndex, file);
            fileInput.value = "";
            renderItems();
            setStatus("Uploaded", false);
          } catch (e) {
            setStatus("Upload failed: " + e.message, true);
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

document.getElementById("loadBtn").addEventListener("click", async () => {
  try {
    await loadInventory();
  } catch (e) {
    setStatus(e.message, true);
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    await saveInventory();
  } catch (e) {
    setStatus(e.message, true);
  }
});

document.getElementById("addItemBtn").addEventListener("click", () => {
  addItem();
});
