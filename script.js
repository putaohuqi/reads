const STORAGE_KEY = "wishlist-items-v1";
const CLOUD_LIST_ID = "wishlist";
const COLOR_SAMPLE_SIZE = 24;
const PURCHASE_STATUSES = ["not-bought", "on-the-way", "bought"];
const PURCHASE_STATUS_LABELS = {
  "not-bought": "Not bought",
  "on-the-way": "On the way",
  bought: "Bought"
};

const accentCache = new Map();

const state = {
  items: loadItems(),
  filter: "all",
  query: "",
  view: "list",
  editingId: null,
  pendingDeleteId: null,
  draggingId: null
};

const refs = {
  form: document.getElementById("wish-form"),
  purchaseStatus: document.getElementById("purchase-status"),
  trackingNumber: document.getElementById("tracking-number"),
  list: document.getElementById("wishlist"),
  template: document.getElementById("wish-template"),
  empty: document.getElementById("empty-state"),
  search: document.getElementById("search"),
  filters: Array.from(document.querySelectorAll("[data-filter]")),
  stats: document.getElementById("header-stats"),
  openAdd: document.getElementById("open-add"),
  refreshApp: document.getElementById("refresh-app"),
  closeAdd: document.getElementById("close-add"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalTitle: document.getElementById("modal-title"),
  saveWishButton: document.getElementById("save-wish-btn"),
  confirmBackdrop: document.getElementById("confirm-backdrop"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmDelete: document.getElementById("confirm-delete")
};

initialize();

function initialize() {
  refs.form.addEventListener("submit", handleSubmit);
  refs.purchaseStatus.addEventListener("change", handlePurchaseStatusChange);
  refs.list.addEventListener("click", handleListClick);
  refs.list.addEventListener("dragstart", handleCardDragStart);
  refs.list.addEventListener("dragover", handleCardDragOver);
  refs.list.addEventListener("drop", handleCardDrop);
  refs.list.addEventListener("dragend", handleCardDragEnd);
  refs.search.addEventListener("input", handleSearch);
  refs.filters.forEach((button) => button.addEventListener("click", handleFilterChange));
  refs.openAdd.addEventListener("click", openAddModal);
  refs.refreshApp?.addEventListener("click", handleManualRefresh);
  refs.closeAdd.addEventListener("click", closeModal);
  refs.modalBackdrop.addEventListener("click", handleModalBackdropClick);
  refs.confirmBackdrop.addEventListener("click", handleConfirmBackdropClick);
  refs.confirmCancel.addEventListener("click", closeDeleteConfirm);
  refs.confirmDelete.addEventListener("click", confirmDeleteItem);
  window.addEventListener("storage", handleStorageSync);
  window.addEventListener("pageshow", resetOverlayState);
  document.addEventListener("keydown", handleGlobalKeydown);

  resetOverlayState();

  if (!localStorage.getItem(STORAGE_KEY)) {
    persistItems(state.items);
  }

  ensureItemOrder();
  initializeCloudSync();

  setActiveFilterButton();
  syncTrackingFieldState();
  applyViewClass();
  render();
}

async function handleManualRefresh() {
  const refreshButton = refs.refreshApp;
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = "refreshing...";
  }

  const cloud = window.WishlistCloud;
  if (cloud && typeof cloud.getCurrentUser === "function" && cloud.getCurrentUser()) {
    try {
      if (typeof cloud.requestSync === "function") {
        await cloud.requestSync();
      }
    } catch (error) {
      console.error("Refresh sync failed:", error);
    }
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("refresh", String(Date.now()));
  window.location.replace(nextUrl.toString());
}

function initializeCloudSync() {
  const cloud = window.WishlistCloud;
  if (!cloud) {
    return;
  }

  cloud.noteLocalChange(STORAGE_KEY, getLatestUpdate(state.items));

  let syncTimerId = 0;

  const runSync = async ({ throwOnError = false } = {}) => {
    if (!cloud.getCurrentUser()) {
      return;
    }

    try {
      const syncedItems = await cloud.syncList(CLOUD_LIST_ID, STORAGE_KEY, state.items);
      if (JSON.stringify(syncedItems) === JSON.stringify(state.items)) {
        return;
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(syncedItems));
      state.items = loadItems();
      ensureItemOrder();
      render();
    } catch (error) {
      console.error("Cloud sync failed for wishlist:", error);
      if (throwOnError) {
        throw error;
      }
    }
  };

  if (typeof cloud.onSyncRequest === "function") {
    cloud.onSyncRequest(() => runSync({ throwOnError: true }));
  }

  cloud.onAuthChange(async (user) => {
    if (syncTimerId) {
      window.clearInterval(syncTimerId);
      syncTimerId = 0;
    }

    if (!user) {
      return;
    }

    await runSync();
    syncTimerId = window.setInterval(runSync, 12000);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      runSync();
    }
  });
}

function handleSubmit(event) {
  event.preventDefault();

  const formData = new FormData(refs.form);

  const title = getCleanValue(formData.get("title"));
  const urlValue = getCleanValue(formData.get("url"));
  const category = getCleanValue(formData.get("category"));
  const imageValue = getCleanValue(formData.get("image"));
  const priority = normalizePriority(formData.get("priority"));
  const purchaseStatus = normalizePurchaseStatus(formData.get("purchaseStatus"));

  if (!title || !urlValue || !category) {
    return;
  }

  const parsedUrl = normalizeRequiredUrl(urlValue);
  if (!parsedUrl) {
    refs.form.querySelector("#url").focus();
    return;
  }

  const parsedImage = normalizeOptionalUrl(imageValue);
  if (parsedImage === null) {
    refs.form.querySelector("#image").focus();
    return;
  }

  const payload = {
    title,
    url: parsedUrl,
    image: parsedImage,
    category,
    priority,
    purchaseStatus,
    owned: purchaseStatus !== "not-bought",
    trackingNumber:
      purchaseStatus === "on-the-way" ? normalizeTrackingNumber(formData.get("trackingNumber")) : "",
    price: getCleanValue(formData.get("price")),
    size: getCleanValue(formData.get("size")),
    color: getCleanValue(formData.get("color")),
    note: getCleanValue(formData.get("note")),
    _updatedAt: Date.now()
  };

  if (state.editingId) {
    state.items = state.items.map((item) => {
      if (item.id !== state.editingId) {
        return item;
      }
      return {
        ...item,
        ...payload
      };
    });
  } else {
    const frontOrder = getFrontOrder(state.items);
    const now = Date.now();
    state.items.unshift({
      id: createId(),
      owned: purchaseStatus !== "not-bought",
      order: frontOrder,
      createdAt: now,
      _updatedAt: now,
      ...payload
    });
  }

  persistItems(state.items);
  render();
  closeModal();
}

function handleListClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  if (!actionButton) {
    return;
  }

  const card = actionButton.closest(".wish-card");
  if (!card) {
    return;
  }

  const id = card.dataset.id;
  const action = actionButton.dataset.action;
  closeCardMenu(actionButton);

  if (action === "edit-item") {
    openEditModal(id);
    return;
  }

  if (action === "delete") {
    openDeleteConfirm(id);
    return;
  } else if (action === "toggle-owned") {
    const now = Date.now();
    state.items = state.items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const currentStatus = normalizePurchaseStatus(item.purchaseStatus, item.owned, item.trackingNumber);
      if (currentStatus === "not-bought") {
        return { ...item, purchaseStatus: "bought", owned: true, trackingNumber: "", _updatedAt: now };
      }
      return { ...item, purchaseStatus: "not-bought", owned: false, trackingNumber: "", _updatedAt: now };
    });
  } else if (action === "toggle-on-way") {
    const now = Date.now();
    state.items = state.items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      const currentStatus = normalizePurchaseStatus(item.purchaseStatus, item.owned, item.trackingNumber);
      if (currentStatus === "on-the-way") {
        return { ...item, purchaseStatus: "bought", owned: true, _updatedAt: now };
      }
      return { ...item, purchaseStatus: "on-the-way", owned: true, _updatedAt: now };
    });
  } else {
    return;
  }

  persistItems(state.items);
  render();
}

function handleSearch(event) {
  state.query = getCleanValue(event.target.value).toLowerCase();
  render();
}

function handlePurchaseStatusChange() {
  syncTrackingFieldState();
}

function handleCardDragStart(event) {
  const card = event.target.closest(".wish-card");
  if (!card || !card.draggable) {
    return;
  }

  state.draggingId = card.dataset.id;
  card.classList.add("is-dragging");

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", state.draggingId);
  }
}

function handleCardDragOver(event) {
  if (!state.draggingId) {
    return;
  }

  event.preventDefault();
  const targetCard = event.target.closest(".wish-card");

  clearDropTargets();
  if (targetCard && targetCard.dataset.id !== state.draggingId) {
    targetCard.classList.add("drop-target");
  }

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
}

function handleCardDrop(event) {
  if (!state.draggingId) {
    return;
  }

  event.preventDefault();
  const sourceId = state.draggingId;
  const targetCard = event.target.closest(".wish-card");
  clearDropTargets();

  if (!targetCard) {
    reorderVisibleItems(sourceId, null, false);
    cleanupDragState();
    return;
  }

  const targetId = targetCard.dataset.id;
  if (!targetId || targetId === sourceId) {
    cleanupDragState();
    return;
  }

  const rect = targetCard.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  reorderVisibleItems(sourceId, targetId, insertAfter);
  cleanupDragState();
}

function handleCardDragEnd() {
  cleanupDragState();
}

function handleFilterChange(event) {
  const nextFilter = event.currentTarget.dataset.filter;
  if (!nextFilter) {
    return;
  }

  state.filter = nextFilter;
  setActiveFilterButton();
  render();
}

function handleStorageSync(event) {
  if (event.key !== STORAGE_KEY) {
    return;
  }
  state.items = loadItems();
  render();
}

function handleModalBackdropClick(event) {
  if (event.target === refs.modalBackdrop) {
    closeModal();
  }
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (!refs.confirmBackdrop.hidden) {
    closeDeleteConfirm();
    return;
  }

  if (!refs.modalBackdrop.hidden) {
    closeModal();
  }
}

function openAddModal() {
  state.editingId = null;
  refs.form.reset();
  refs.form.querySelector("#category").value = "Fashion";
  refs.form.querySelector("#priority").value = "medium";
  refs.form.querySelector("#purchase-status").value = "not-bought";
  refs.form.querySelector("#tracking-number").value = "";
  syncTrackingFieldState();
  refs.modalTitle.textContent = "Add a wish";
  refs.saveWishButton.textContent = "Add to wishlist";
  openModal();
  refs.form.querySelector("#title").focus();
}

function openEditModal(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) {
    return;
  }

  state.editingId = id;

  refs.form.querySelector("#title").value = item.title;
  refs.form.querySelector("#url").value = item.url;
  refs.form.querySelector("#category").value = item.category || "Other";
  refs.form.querySelector("#image").value = item.image || "";
  refs.form.querySelector("#priority").value = normalizePriority(item.priority);
  refs.form.querySelector("#purchase-status").value = normalizePurchaseStatus(
    item.purchaseStatus,
    item.owned,
    item.trackingNumber
  );
  refs.form.querySelector("#tracking-number").value = item.trackingNumber || "";
  syncTrackingFieldState();
  refs.form.querySelector("#price").value = item.price || "";
  refs.form.querySelector("#size").value = item.size || "";
  refs.form.querySelector("#color").value = item.color || "";
  refs.form.querySelector("#note").value = item.note || "";

  refs.modalTitle.textContent = "Edit wish";
  refs.saveWishButton.textContent = "Save changes";
  openModal();
  refs.form.querySelector("#title").focus();
}

function openModal() {
  refs.confirmBackdrop.hidden = true;
  state.pendingDeleteId = null;
  refs.modalBackdrop.hidden = false;
  syncBodyModalState();
}

function closeModal() {
  refs.modalBackdrop.hidden = true;
  state.editingId = null;
  refs.form.reset();
  syncTrackingFieldState();
  syncBodyModalState();
}

function openDeleteConfirm(id) {
  refs.modalBackdrop.hidden = true;
  state.editingId = null;
  state.pendingDeleteId = id;
  refs.confirmBackdrop.hidden = false;
  syncBodyModalState();
}

function closeDeleteConfirm() {
  refs.confirmBackdrop.hidden = true;
  state.pendingDeleteId = null;
  syncBodyModalState();
}

function syncTrackingFieldState() {
  const status = normalizePurchaseStatus(refs.purchaseStatus.value);
  const shouldEnableTracking = status === "on-the-way";
  refs.trackingNumber.disabled = !shouldEnableTracking;
  if (!shouldEnableTracking) {
    refs.trackingNumber.value = "";
    refs.trackingNumber.placeholder = "Only needed when item is on the way";
  } else {
    refs.trackingNumber.placeholder = "1Z999...";
  }
}

function confirmDeleteItem() {
  if (!state.pendingDeleteId) {
    closeDeleteConfirm();
    return;
  }

  const now = Date.now();
  state.items = state.items.map((item) => {
    if (item.id !== state.pendingDeleteId) {
      return item;
    }
    return {
      ...item,
      _deleted: true,
      _updatedAt: now
    };
  });
  persistItems(state.items);
  render();
  closeDeleteConfirm();
}

function handleConfirmBackdropClick(event) {
  if (event.target === refs.confirmBackdrop) {
    closeDeleteConfirm();
  }
}

function syncBodyModalState() {
  const authBackdrop = document.getElementById("auth-backdrop");
  const anyOpen =
    !refs.modalBackdrop.hidden ||
    !refs.confirmBackdrop.hidden ||
    Boolean(authBackdrop && !authBackdrop.hidden);
  document.body.classList.toggle("modal-open", anyOpen);
}

function resetOverlayState() {
  refs.modalBackdrop.hidden = true;
  refs.confirmBackdrop.hidden = true;
  state.editingId = null;
  state.pendingDeleteId = null;
  syncBodyModalState();
}

function closeCardMenu(actionButton) {
  const menu = actionButton.closest(".card-menu");
  if (menu) {
    menu.open = false;
  }
}

function setActiveFilterButton() {
  refs.filters.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.filter);
  });
}

function applyViewClass() {
  refs.list.classList.remove("view-grid");
  refs.list.classList.add("view-list");
}

function render() {
  const filtered = getVisibleItems(state.items, state.filter, state.query);
  const canDrag = filtered.length > 1;
  applyViewClass();

  refs.list.innerHTML = "";
  filtered.forEach((item) => {
    const card = refs.template.content.firstElementChild.cloneNode(true);
    card.dataset.id = item.id;
    card.draggable = canDrag;
    card.classList.toggle("is-draggable", canDrag);
    clearCardAccent(card);

    const photoLink = card.querySelector(".wish-photo-link");
    const photo = card.querySelector(".wish-photo");
    const titleLink = card.querySelector(".wish-title-link");
    if (item.image) {
      photo.src = item.image;
      photo.alt = item.title;
      photoLink.href = item.url;
      applyCardAccentFromImage(card, photo, item.image);
    } else {
      photoLink.remove();
    }

    titleLink.textContent = item.title;
    titleLink.href = item.url;
    const purchaseStatus = normalizePurchaseStatus(item.purchaseStatus, item.owned, item.trackingNumber);
    const trackingNumber = normalizeTrackingNumber(item.trackingNumber);
    const metaText = buildMetaLine(item);
    card.querySelector(".wish-meta-text").textContent =
      purchaseStatus === "on-the-way" && trackingNumber
        ? `${metaText} · Tracking ${trackingNumber}`
        : metaText;

    const statusBadge = card.querySelector(".wish-status");
    if (purchaseStatus === "not-bought") {
      statusBadge.hidden = true;
      statusBadge.textContent = "";
      statusBadge.classList.remove("is-on-way", "is-bought");
    } else {
      statusBadge.hidden = false;
      statusBadge.textContent = PURCHASE_STATUS_LABELS[purchaseStatus];
      statusBadge.classList.toggle("is-on-way", purchaseStatus === "on-the-way");
      statusBadge.classList.toggle("is-bought", purchaseStatus === "bought");
    }

    const toggleOwned = card.querySelector("[data-action='toggle-owned']");
    toggleOwned.textContent = purchaseStatus === "not-bought" ? "Mark bought" : "Mark not bought";

    const toggleOnWay = card.querySelector("[data-action='toggle-on-way']");
    toggleOnWay.textContent = purchaseStatus === "on-the-way" ? "Mark delivered" : "Mark on the way";

    const canTrack = purchaseStatus === "on-the-way" && Boolean(trackingNumber);
    const trackingUrl = canTrack ? buildCanadaPostTrackingUrl(trackingNumber) : "";

    const trackBubble = card.querySelector("[data-track-bubble]");
    if (trackBubble) {
      trackBubble.hidden = !canTrack;
      if (canTrack) {
        trackBubble.href = trackingUrl;
        trackBubble.title = `Track ${trackingNumber}`;
      } else {
        trackBubble.href = "#";
        trackBubble.removeAttribute("title");
      }
    }

    refs.list.append(card);
  });

  refs.empty.hidden = filtered.length !== 0;
  renderStats(state.items);
}

function buildMetaLine(item) {
  const pieces = [];

  if (item.price) {
    pieces.push(item.price);
  }
  if (item.color) {
    pieces.push(item.color);
  }
  if (item.size) {
    pieces.push(`Size ${item.size}`);
  }

  pieces.push(`${capitalize(item.priority)} priority`);
  return pieces.join(" · ");
}

function renderStats(items) {
  const activeItems = items.filter((item) => !normalizeDeleted(item._deleted));
  const total = activeItems.length;
  const open = activeItems.filter(
    (item) => normalizePurchaseStatus(item.purchaseStatus, item.owned, item.trackingNumber) === "not-bought"
  ).length;

  refs.stats.textContent = `${total} items • ${open} not bought`;
}

function getVisibleItems(items, filter, query) {
  return getOrderedItems(items)
    .filter((item) => !normalizeDeleted(item._deleted))
    .filter((item) => {
      const purchaseStatus = normalizePurchaseStatus(item.purchaseStatus, item.owned, item.trackingNumber);
      if (filter === "open") {
        return purchaseStatus === "not-bought";
      }
      if (filter === "owned") {
        return purchaseStatus !== "not-bought";
      }
      return true;
    })
    .filter((item) => {
      if (!query) {
        return true;
      }

      const haystack =
        `${item.title} ${item.category} ${item.price} ${item.priority} ${item.size} ${item.color} ${item.note} ${item.trackingNumber} ${item.purchaseStatus}`.toLowerCase();
      return haystack.includes(query);
    });
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const trackingNumber = normalizeTrackingNumber(item.trackingNumber);
        const purchaseStatus = normalizePurchaseStatus(item.purchaseStatus, Boolean(item.owned), trackingNumber);
        return {
          id: String(item.id || createId()),
          createdAt: normalizeTimestamp(item.createdAt, Date.now()),
          _updatedAt: normalizeTimestamp(item._updatedAt || item.updatedAt || item.createdAt, Date.now()),
          title: String(item.title || "Untitled item"),
          url: String(item.url || "#"),
          image: String(item.image || ""),
          category: String(item.category || "Other"),
          priority: normalizePriority(item.priority),
          purchaseStatus,
          trackingNumber: purchaseStatus === "on-the-way" ? trackingNumber : "",
          order: normalizeOrder(item.order, index),
          price: String(item.price || ""),
          size: String(item.size || ""),
          color: String(item.color || ""),
          note: String(item.note || ""),
          owned: purchaseStatus !== "not-bought",
          _deleted: normalizeDeleted(item._deleted ?? item.deleted)
        };
      });
  } catch {
    return [];
  }
}

function persistItems(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));

  const cloud = window.WishlistCloud;
  if (!cloud) {
    return;
  }

  const updatedAt = getLatestUpdate(items);
  cloud.noteLocalChange(STORAGE_KEY, updatedAt);
  cloud.saveList(CLOUD_LIST_ID, STORAGE_KEY, items);
}

function normalizePriority(value) {
  const clean = getCleanValue(value).toLowerCase();
  if (clean === "high" || clean === "low") {
    return clean;
  }
  return "medium";
}

function normalizePurchaseStatus(value, ownedFallback = false, trackingFallback = "") {
  const clean = getCleanValue(value).toLowerCase();
  if (PURCHASE_STATUSES.includes(clean)) {
    return clean;
  }

  const hasTracking = Boolean(getCleanValue(trackingFallback));
  if (ownedFallback && hasTracking) {
    return "on-the-way";
  }

  if (ownedFallback) {
    return "bought";
  }

  return "not-bought";
}

function normalizeTrackingNumber(value) {
  return getCleanValue(value).replace(/\s+/g, "");
}

function normalizeDeleted(value) {
  return value === true;
}

function buildCanadaPostTrackingUrl(trackingNumber) {
  return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${encodeURIComponent(trackingNumber)}&searchBy=pin`;
}

function normalizeOrder(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function normalizeTimestamp(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function getOrderedItems(items) {
  return [...items].sort((a, b) => normalizeOrder(a.order, 0) - normalizeOrder(b.order, 0));
}

function ensureItemOrder() {
  const ordered = getOrderedItems(state.items);
  let changed = false;

  state.items = ordered.map((item, index) => {
    if (item.order !== index) {
      changed = true;
    }
    return { ...item, order: index };
  });

  if (changed) {
    persistItems(state.items);
  }
}

function getFrontOrder(items) {
  if (items.length === 0) {
    return 0;
  }
  let minOrder = normalizeOrder(items[0].order, 0);
  items.forEach((item) => {
    const nextOrder = normalizeOrder(item.order, 0);
    if (nextOrder < minOrder) {
      minOrder = nextOrder;
    }
  });
  return minOrder - 1;
}

function getLatestUpdate(items) {
  if (!items.length) {
    return Date.now();
  }

  return items.reduce((latest, item) => {
    const nextValue = normalizeTimestamp(item._updatedAt || item.createdAt, 0);
    return nextValue > latest ? nextValue : latest;
  }, 0);
}

function reorderVisibleItems(sourceId, targetId, insertAfter) {
  const visibleIds = getVisibleItems(state.items, state.filter, state.query).map((item) => item.id);
  if (!visibleIds.includes(sourceId)) {
    return;
  }

  const reorderedVisibleIds = visibleIds.filter((id) => id !== sourceId);
  if (targetId && reorderedVisibleIds.includes(targetId)) {
    let targetIndex = reorderedVisibleIds.indexOf(targetId);
    if (insertAfter) {
      targetIndex += 1;
    }
    reorderedVisibleIds.splice(targetIndex, 0, sourceId);
  } else {
    reorderedVisibleIds.push(sourceId);
  }

  applyVisibleOrderToAllItems(reorderedVisibleIds);
}

function applyVisibleOrderToAllItems(reorderedVisibleIds) {
  const ordered = getOrderedItems(state.items);
  const visibleSet = new Set(reorderedVisibleIds);
  const pointer = { value: 0 };

  const nextGlobalIds = ordered.map((item) => {
    if (!visibleSet.has(item.id)) {
      return item.id;
    }
    const nextId = reorderedVisibleIds[pointer.value];
    pointer.value += 1;
    return nextId;
  });

  const itemById = new Map(state.items.map((item) => [item.id, item]));
  state.items = nextGlobalIds.map((id, index) => {
    const base = itemById.get(id);
    return { ...base, order: index };
  });

  persistItems(state.items);
  render();
}

function clearDropTargets() {
  refs.list.querySelectorAll(".drop-target").forEach((card) => card.classList.remove("drop-target"));
}

function cleanupDragState() {
  state.draggingId = null;
  refs.list.querySelectorAll(".is-dragging").forEach((card) => card.classList.remove("is-dragging"));
  clearDropTargets();
}

function applyCardAccentFromImage(card, photo, imageUrl) {
  const cacheKey = normalizeUrl(imageUrl);
  const cachedAccent = accentCache.get(cacheKey);
  if (cachedAccent) {
    setCardAccent(card, cachedAccent);
    return;
  }

  const assignAccent = () => {
    const accent = extractDominantAccent(photo);
    if (!accent) {
      return;
    }

    accentCache.set(cacheKey, accent);
    if (card.isConnected) {
      setCardAccent(card, accent);
    }
  };

  if (photo.complete && photo.naturalWidth > 0) {
    assignAccent();
    return;
  }

  photo.addEventListener("load", assignAccent, { once: true });
}

function setCardAccent(card, accentRgb) {
  card.style.setProperty("--card-accent-rgb", accentRgb);
  card.classList.add("has-accent");
}

function clearCardAccent(card) {
  card.style.removeProperty("--card-accent-rgb");
  card.classList.remove("has-accent");
}

function extractDominantAccent(photo) {
  if (!photo.naturalWidth || !photo.naturalHeight) {
    return "";
  }

  const canvas = document.createElement("canvas");
  canvas.width = COLOR_SAMPLE_SIZE;
  canvas.height = COLOR_SAMPLE_SIZE;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return "";
  }

  try {
    context.drawImage(photo, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
  } catch {
    return "";
  }

  let pixelData;
  try {
    pixelData = context.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
  } catch {
    return "";
  }

  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let weightTotal = 0;

  for (let index = 0; index < pixelData.length; index += 4) {
    const red = pixelData[index];
    const green = pixelData[index + 1];
    const blue = pixelData[index + 2];
    const alpha = pixelData[index + 3] / 255;

    if (alpha < 0.45) {
      continue;
    }

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

    if (luminance > 0.95 || luminance < 0.08) {
      continue;
    }

    const weight = (0.25 + saturation * 0.75) * alpha;
    redTotal += red * weight;
    greenTotal += green * weight;
    blueTotal += blue * weight;
    weightTotal += weight;
  }

  if (weightTotal < 1) {
    return "";
  }

  const softened = softenAccentColor({
    red: Math.round(redTotal / weightTotal),
    green: Math.round(greenTotal / weightTotal),
    blue: Math.round(blueTotal / weightTotal)
  });

  return `${softened.red} ${softened.green} ${softened.blue}`;
}

function softenAccentColor(color) {
  const blend = 0.2;
  return {
    red: blendChannel(color.red, 255, blend),
    green: blendChannel(color.green, 255, blend),
    blue: blendChannel(color.blue, 255, blend)
  };
}

function blendChannel(source, target, amount) {
  return Math.round(source * (1 - amount) + target * amount);
}

function normalizeRequiredUrl(value) {
  const clean = getCleanValue(value);
  if (!clean) {
    return "";
  }

  try {
    return new URL(clean).toString();
  } catch {
    return "";
  }
}

function normalizeOptionalUrl(value) {
  const clean = getCleanValue(value);
  if (!clean) {
    return "";
  }

  try {
    return new URL(clean).toString();
  } catch {
    return null;
  }
}

function normalizeUrl(value) {
  try {
    return new URL(String(value || "").trim()).toString();
  } catch {
    return String(value || "").trim();
  }
}

function getCleanValue(value) {
  return String(value || "").trim();
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `wish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function capitalize(value) {
  const clean = getCleanValue(value);
  if (!clean) {
    return "";
  }
  return clean[0].toUpperCase() + clean.slice(1);
}
