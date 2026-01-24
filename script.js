const INVENTORY_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/inventory.json";
const IMAGE_BASE_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/";


let inventory = null; 
let items = [];

function normalizeImageSrc(src) {
  if (!src) return "";
  if (src.startsWith("http://") || src.startsWith("https://")) return src;
  if (src.startsWith("images/")) return IMAGE_BASE_URL + src.replace(/^\/+/, "");
  return src;
}

async function loadInventory() {
  const url =
    INVENTORY_URL +
    (INVENTORY_URL.includes("?") ? "&" : "?") +
    "t=" +
    Date.now();

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load inventory (${res.status})`);

  inventory = await res.json();
  items = Array.isArray(inventory.items) ? inventory.items : [];
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadInventory();
  } catch (err) {
    console.error(err);
    alert(
      "Could not load inventory data. Check S3 permissions/CORS and INVENTORY_URL."
    );
  }
});

function checkPassword() {
  const userInput = document.getElementById("passwordInput").value;

  if (!inventory) {
    alert("Inventory still loading. Try again in a second.");
    return;
  }

  if (userInput === inventory.password) {
    document.getElementById("passwordPrompt").classList.add("hidden");
    document.getElementById("mainContent").classList.remove("hidden");
    buildItems();
  } else {
    alert("Incorrect password!");
  }
}

function buildItems() {
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  items.forEach((item) => {
    const itemCard = document.createElement("div");
    itemCard.className = "border border-gray-700 rounded p-4";

    const titleEl = document.createElement("h2");
    titleEl.textContent = item.title || "(Untitled)";
    titleEl.className = "text-xl font-bold mb-3";
    itemCard.appendChild(titleEl);

    const tableEl = document.createElement("table");
    tableEl.className = "table-auto w-full border border-gray-700";

    (item.fields || []).forEach((field) => {
      const row = document.createElement("tr");
      row.className = "border border-gray-700";

      const labelCell = document.createElement("td");
      labelCell.className = "p-2 font-semibold w-1/4 border border-gray-700";
      labelCell.textContent = field.label || "";

      const valueCell = document.createElement("td");
      valueCell.className = "p-2 border border-gray-700";

      if ((field.label || "").toLowerCase() === "image") {
        const values = Array.isArray(field.value) ? field.value : [field.value];
        values.filter(Boolean).forEach((imgSrc) => {
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
