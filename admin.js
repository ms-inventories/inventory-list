const INVENTORY_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/inventory.json";
const API_BASE_URL = "https://j2pdaptydpur4jjasyl7pz3xc40ckbqd.lambda-url.us-east-1.on.aws";

let inventory = null;

function getAdminKey() {
  return document.getElementById("adminKeyInput").value.trim();
}

async function loadInventory() {
  const res = await fetch(INVENTORY_URL + "?t=" + Date.now());
  if (!res.ok) throw new Error("Failed to load inventory");

  inventory = await res.json();

  const pw = document.getElementById("sitePwInput").value;
  if (pw !== inventory.password) throw new Error("Wrong site password");

  renderItems();
}

function renderItems() {
  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";

  inventory.items.forEach((item, itemIndex) => {
    const card = document.createElement("div");
    card.className = "border border-gray-700 rounded p-4";

    card.innerHTML = `
      <input class="text-xl font-bold mb-4 w-full text-gray-900 px-2 py-1"
        value="${item.title}"
        oninput="inventory.items[${itemIndex}].title = this.value" />

      <div class="space-y-3" id="fields-${itemIndex}"></div>

      <button class="mt-3 bg-blue-600 px-3 py-1 rounded"
        onclick="addField(${itemIndex})">
        + Add Field
      </button>
    `;

    container.appendChild(card);

    item.fields.forEach((field, fieldIndex) => {
      renderField(itemIndex, fieldIndex);
    });
  });
}

function renderField(itemIndex, fieldIndex) {
  const fieldsDiv = document.getElementById(`fields-${itemIndex}`);
  const field = inventory.items[itemIndex].fields[fieldIndex];

  const row = document.createElement("div");
  row.className = "flex gap-2";

  row.innerHTML = `
    <input class="w-1/4 text-gray-900 px-2 py-1"
      value="${field.label}"
      oninput="inventory.items[${itemIndex}].fields[${fieldIndex}].label = this.value" />

    <input class="flex-1 text-gray-900 px-2 py-1"
      value="${Array.isArray(field.value) ? field.value.join(', ') : field.value}"
      oninput="inventory.items[${itemIndex}].fields[${fieldIndex}].value = this.value" />

    <button class="bg-red-600 px-2 rounded"
      onclick="removeField(${itemIndex}, ${fieldIndex})">X</button>
  `;

  fieldsDiv.appendChild(row);
}

function addField(itemIndex) {
  inventory.items[itemIndex].fields.push({ label: "", value: "" });
  renderItems();
}

function removeField(itemIndex, fieldIndex) {
  inventory.items[itemIndex].fields.splice(fieldIndex, 1);
  renderItems();
}

function addItem() {
  inventory.items.push({ title: "New Item", fields: [] });
  renderItems();
}

async function saveInventory() {
  const res = await fetch(API_BASE_URL + "/inventory", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": getAdminKey()
    },
    body: JSON.stringify(inventory)
  });

  if (!res.ok) throw new Error("Save failed");
  alert("Saved");
}

document.getElementById("loadBtn").onclick = () => loadInventory().catch(e => alert(e.message));
document.getElementById("saveBtn").onclick = () => saveInventory().catch(e => alert(e.message));
document.getElementById("addItemBtn").onclick = addItem;
