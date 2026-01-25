const BUCKET_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com";
const INDEX_URL = `${BUCKET_BASE_URL}/inventories/index.json`;
const IMAGE_BASE_URL = `${BUCKET_BASE_URL}/`;

let indexData = null;
let selectedPlatoon = null;
let inventory = null;

function setLoginStatus(text) {
  document.getElementById("loginStatus").textContent = text || "";
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

function buildItems() {
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  (inventory.items || []).forEach(item => {
    const itemCard = document.createElement("div");
    itemCard.className = "border border-gray-700 rounded p-4";

    const titleEl = document.createElement("h2");
    titleEl.textContent = item.title || "(Untitled)";
    titleEl.className = "text-xl font-bold mb-3";
    itemCard.appendChild(titleEl);

    const tableEl = document.createElement("table");
    tableEl.className = "table-auto w-full border border-gray-700";

    (item.fields || []).forEach(field => {
      const row = document.createElement("tr");
      row.className = "border border-gray-700";

      const labelCell = document.createElement("td");
      labelCell.className = "p-2 font-semibold w-1/4 border border-gray-700";
      labelCell.textContent = field.label || "";

      const valueCell = document.createElement("td");
      valueCell.className = "p-2 border border-gray-700";

      if ((field.label || "").toLowerCase() === "image") {
        const values = Array.isArray(field.value) ? field.value : [field.value];
        values.filter(Boolean).forEach(imgSrc => {
          const img = document.createElement("img");
          img.src = normalizeImageSrc(imgSrc);
          img.alt = item.title || "Inventory image";
          img.className = "max-h-48 inline-block mr-2 mb-2";
          valueCell.appendChild(img);
        });
      } else {
        valueCell.textContent = field.value ?? "";
      }

      row.appendChild(labelCell);
      row.appendChild(valueCell);
      tableEl.appendChild(row);
    });

    itemCard.appendChild(tableEl);
    container.appendChild(itemCard);
  });
}

async function attemptLogin() {
  setLoginStatus("");

  const selectId = document.getElementById("platoonSelect").value;
  selectedPlatoon = getSelectedPlatoonById(selectId);

  if (!selectedPlatoon) {
    setLoginStatus("Select a platoon");
    return;
  }

  setLoginStatus("Loading...");

  let data;
  try {
    data = await loadPlatoonInventory(selectedPlatoon.file);
  } catch (e) {
    setLoginStatus("Failed to load platoon inventory");
    return;
  }

  const userInput = document.getElementById("passwordInput").value;
  if (userInput !== data.password) {
    setLoginStatus("Incorrect password");
    return;
  }

  inventory = data;

  document.getElementById("passwordPrompt").classList.add("hidden");
  document.getElementById("mainContent").classList.remove("hidden");

  document.getElementById("pageTitle").textContent = selectedPlatoon.name || "Equipment Inventory";
  buildItems();
}

function resetToLogin() {
  document.getElementById("mainContent").classList.add("hidden");
  document.getElementById("passwordPrompt").classList.remove("hidden");
  document.getElementById("passwordInput").value = "";
  setLoginStatus("");
  inventory = null;
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadIndex();
    setLoginStatus("");
  } catch (e) {
    setLoginStatus("Failed to load index.json");
  }

  document.getElementById("submitBtn").addEventListener("click", attemptLogin);
  document.getElementById("changePlatoonBtn").addEventListener("click", resetToLogin);
});
