const API_BASE_URL = "https://j2pdaptydpur4jjasyl7pz3xc40ckbqd.lambda-url.us-east-1.on.aws";
const INVENTORY_URL = "https://ms-inventories.s3.us-east-1.amazonaws.com/inventory.json";

function getAdminKey() {
  return document.getElementById("adminKeyInput").value.trim();
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

async function callApi(path, options) {
  const adminKey = getAdminKey();
  const requestOptions = options || {};
  const requestHeaders = requestOptions.headers || {};

  if (adminKey) {
    requestHeaders["x-admin-key"] = adminKey;
  }

  requestOptions.headers = requestHeaders;

  const res = await fetch(`${API_BASE_URL}${path}`, requestOptions);
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

async function loadInventory() {
  const res = await fetch(INVENTORY_URL + "?t=" + Date.now(), {
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("Failed to load inventory.json from S3");
  }

  const inventory = await res.json();

  const sitePasswordInput = document.getElementById("sitePwInput").value;
  if (sitePasswordInput !== inventory.password) {
    throw new Error("Site password does not match inventory.json");
  }

  document.getElementById("jsonEditor").value = JSON.stringify(inventory, null, 2);
}

async function saveInventory() {
  const raw = document.getElementById("jsonEditor").value;
  const inventory = JSON.parse(raw);

  await callApi("/inventory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inventory)
  });
}

async function uploadImage() {
  const fileInput = document.getElementById("fileInput");
  const file = fileInput.files && fileInput.files[0];

  const uploadResult = document.getElementById("uploadResult");
  uploadResult.textContent = "";

  if (!file) {
    throw new Error("Select an image first");
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
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

  if (!putRes.ok) {
    throw new Error(`S3 upload failed: ${putRes.status}`);
  }

  uploadResult.textContent = `Uploaded\nKey: ${presign.key}\nPublic URL: ${presign.publicUrl || ""}`;
}

document.getElementById("loadBtn").addEventListener("click", async () => {
  try {
    await loadInventory();
    alert("Loaded inventory.json");
  } catch (e) {
    console.error(e);
    alert(`Load failed: ${e.message}`);
  }
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    await saveInventory();
    alert("Saved inventory.json");
  } catch (e) {
    console.error(e);
    alert(`Save failed: ${e.message}`);
  }
});

document.getElementById("uploadBtn").addEventListener("click", async () => {
  try {
    await uploadImage();
  } catch (e) {
    console.error(e);
    alert(`Upload failed: ${e.message}`);
  }
});
