const STORAGE_KEY = "favourite-chapters-items-v1";
const CLOUD_LIST_ID = "favourite-chapters";
const MAX_UPLOAD_BYTES = 1200 * 1024;
const SERIES_TYPES = ["manhwa", "manga", "manhua"];
const SERIES_GENRES = [
  "bl",
  "gl",
  "romance-fantasy",
  "action",
  "romance",
  "drama",
  "comedy",
  "academy",
  "idol",
  "slice-of-life",
  "horror",
  "revenge"
];
const LEGACY_GENRE_ALIASES = {
  "isekai-romance": "romance-fantasy",
  modern: "romance",
  "action-fantasy": "action",
  "horror-revenge": "revenge",
  school: "academy"
};
const TYPE_LABELS = {
  manhwa: "manhwa",
  manga: "manga",
  manhua: "manhua"
};
const GENRE_LABELS = {
  bl: "BL",
  gl: "GL",
  "romance-fantasy": "romance fantasy",
  action: "action",
  romance: "romance",
  drama: "drama",
  comedy: "comedy",
  academy: "academy",
  idol: "idol",
  "slice-of-life": "slice of life",
  horror: "horror",
  revenge: "revenge"
};

const state = {
  items: loadItems(),
  query: "",
  typeFilter: "all",
  genreFilter: "all",
  editingId: null,
  pendingDeleteId: null,
  draggingId: null
};

const refs = {
  form: document.getElementById("chapter-form"),
  list: document.getElementById("chapter-list"),
  template: document.getElementById("chapter-template"),
  empty: document.getElementById("empty-state"),
  chapterEmpty: document.getElementById("chapter-empty"),
  chapterCount: document.getElementById("chapter-count"),
  search: document.getElementById("search"),
  typeFilters: Array.from(document.querySelectorAll("[data-type-filter]")),
  genreFilters: Array.from(document.querySelectorAll("[data-genre-filter]")),
  stats: document.getElementById("header-stats"),
  openAdd: document.getElementById("open-add"),
  refreshApp: document.getElementById("refresh-app"),
  closeAdd: document.getElementById("close-add"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalTitle: document.getElementById("modal-title"),
  saveChapterButton: document.getElementById("save-chapter-btn"),
  confirmBackdrop: document.getElementById("confirm-backdrop"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmDelete: document.getElementById("confirm-delete"),
  coverInput: document.getElementById("cover"),
  coverDataInput: document.getElementById("cover-data"),
  coverFileInput: document.getElementById("cover-file"),
  coverUploadButton: document.getElementById("cover-upload-btn"),
  coverUploadClear: document.getElementById("cover-upload-clear"),
  coverUploadStatus: document.getElementById("cover-upload-status")
};

initialize();

function initialize() {
  refs.form.addEventListener("submit", handleSubmit);
  refs.list.addEventListener("click", handleListClick);
  refs.list.addEventListener("dragstart", handleCardDragStart);
  refs.list.addEventListener("dragover", handleCardDragOver);
  refs.list.addEventListener("drop", handleCardDrop);
  refs.list.addEventListener("dragend", handleCardDragEnd);
  refs.search.addEventListener("input", handleSearch);
  refs.typeFilters.forEach((button) => button.addEventListener("click", handleTypeFilterChange));
  refs.genreFilters.forEach((button) => button.addEventListener("click", handleGenreFilterChange));
  refs.coverInput.addEventListener("input", handleCoverInputChange);
  refs.coverUploadButton.addEventListener("click", handleCoverUploadClick);
  refs.coverFileInput.addEventListener("change", handleCoverFileChange);
  refs.coverUploadClear.addEventListener("click", clearUploadedCover);
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
  resetCoverInputs();
  setActiveTypeFilterButton();
  setActiveGenreFilterButton();
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
      console.error("Cloud sync failed for favourite chapters:", error);
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
  const chapter = getCleanValue(formData.get("chapter"));
  const urlValue = getCleanValue(formData.get("url"));
  const coverValue = getCleanValue(formData.get("cover"));
  const coverDataValue = getCleanValue(formData.get("coverData"));
  const seriesType = normalizeSeriesType(formData.get("seriesType"));
  const genre = normalizeGenre(formData.get("genre"));

  if (!title || !chapter || !urlValue) {
    return;
  }

  const parsedUrl = normalizeRequiredUrl(urlValue);
  if (!parsedUrl) {
    refs.form.querySelector("#url").focus();
    return;
  }

  const parsedCover = normalizeCoverValue(coverDataValue || coverValue);
  if (parsedCover === null) {
    refs.form.querySelector("#cover").focus();
    return;
  }

  const payload = {
    title,
    chapter,
    url: parsedUrl,
    cover: parsedCover,
    seriesType,
    genre,
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
    const now = Date.now();
    const frontOrder = getFrontOrder(state.items);
    state.items.unshift({
      id: createId(),
      createdAt: now,
      _updatedAt: now,
      order: frontOrder,
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
  }
}

function handleSearch(event) {
  state.query = getCleanValue(event.target.value).toLowerCase();
  render();
}

function handleTypeFilterChange(event) {
  const nextFilter = event.currentTarget.dataset.typeFilter;
  if (!nextFilter) {
    return;
  }

  state.typeFilter = nextFilter;
  setActiveTypeFilterButton();
  render();
}

function handleGenreFilterChange(event) {
  const nextFilter = event.currentTarget.dataset.genreFilter;
  if (!nextFilter) {
    return;
  }

  state.genreFilter = nextFilter;
  setActiveGenreFilterButton();
  render();
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

function handleCoverInputChange(event) {
  const nextValue = getCleanValue(event.target.value);
  if (nextValue) {
    refs.coverDataInput.value = "";
    refs.coverFileInput.value = "";
    refs.coverUploadClear.hidden = true;
    setCoverUploadStatus("using cover link", "muted");
    return;
  }

  if (!refs.coverDataInput.value) {
    setCoverUploadStatus("or paste a cover image link above", "muted");
  }
}

function handleCoverUploadClick() {
  refs.coverFileInput.click();
}

async function handleCoverFileChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    setCoverUploadStatus("please choose an image file", "error");
    refs.coverFileInput.value = "";
    return;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    setCoverUploadStatus("image is too large (max 1.2MB)", "error");
    refs.coverFileInput.value = "";
    return;
  }

  try {
    const coverData = await readFileAsDataUrl(file);
    refs.coverDataInput.value = coverData;
    refs.coverInput.value = "";
    refs.coverUploadClear.hidden = false;
    setCoverUploadStatus(`uploaded: ${file.name}`, "success");
  } catch {
    setCoverUploadStatus("could not read this image file", "error");
  } finally {
    refs.coverFileInput.value = "";
  }
}

function clearUploadedCover() {
  refs.coverDataInput.value = "";
  refs.coverFileInput.value = "";
  refs.coverUploadClear.hidden = true;

  if (getCleanValue(refs.coverInput.value)) {
    setCoverUploadStatus("using cover link", "muted");
    return;
  }

  setCoverUploadStatus("or paste a cover image link above", "muted");
}

function handleStorageSync(event) {
  if (event.key !== STORAGE_KEY) {
    return;
  }
  state.items = loadItems();
  ensureItemOrder();
  render();
}

function handleModalBackdropClick(event) {
  if (event.target === refs.modalBackdrop) {
    closeModal();
  }
}

function handleConfirmBackdropClick(event) {
  if (event.target === refs.confirmBackdrop) {
    closeDeleteConfirm();
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
  resetCoverInputs();
  refs.form.querySelector("#series-type").value = "";
  refs.form.querySelector("#series-genre").value = "";
  refs.modalTitle.textContent = "Add a chapter";
  refs.saveChapterButton.textContent = "Save chapter";
  openModal();
  refs.form.querySelector("#title").focus();
}

function openEditModal(id) {
  const item = state.items.find((entry) => entry.id === id && !normalizeDeleted(entry._deleted));
  if (!item) {
    return;
  }

  state.editingId = id;
  refs.form.querySelector("#title").value = item.title;
  refs.form.querySelector("#chapter").value = item.chapter || "";
  refs.form.querySelector("#url").value = item.url;
  populateCoverInputs(item.cover || "");
  refs.form.querySelector("#series-type").value = normalizeSeriesType(item.seriesType);
  refs.form.querySelector("#series-genre").value = normalizeGenre(item.genre);
  refs.modalTitle.textContent = "Edit chapter";
  refs.saveChapterButton.textContent = "Save changes";
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

function syncBodyModalState() {
  const authBackdrop = document.getElementById("auth-backdrop");
  const anyOpen = !refs.modalBackdrop.hidden || !refs.confirmBackdrop.hidden || Boolean(authBackdrop && !authBackdrop.hidden);
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

function resetCoverInputs() {
  refs.coverInput.value = "";
  refs.coverDataInput.value = "";
  refs.coverFileInput.value = "";
  refs.coverUploadClear.hidden = true;
  setCoverUploadStatus("or paste a cover image link above", "muted");
}

function populateCoverInputs(coverValue) {
  resetCoverInputs();
  const cover = getCleanValue(coverValue);
  if (!cover) {
    return;
  }

  if (isDataImageUrl(cover)) {
    refs.coverDataInput.value = cover;
    refs.coverUploadClear.hidden = false;
    setCoverUploadStatus("using uploaded cover from device", "success");
    return;
  }

  refs.coverInput.value = cover;
  setCoverUploadStatus("using cover link", "muted");
}

function setCoverUploadStatus(message, stateName) {
  refs.coverUploadStatus.textContent = message;
  refs.coverUploadStatus.classList.remove("is-muted", "is-success", "is-error");
  refs.coverUploadStatus.classList.add(`is-${stateName}`);
}

function setActiveTypeFilterButton() {
  refs.typeFilters.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.typeFilter === state.typeFilter);
  });
}

function setActiveGenreFilterButton() {
  refs.genreFilters.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.genreFilter === state.genreFilter);
  });
}

function render() {
  const activeItems = getActiveItems(state.items);
  const visibleItems = getVisibleItems(activeItems, state.query, state.typeFilter, state.genreFilter);
  const canDrag = visibleItems.length > 1;

  refs.stats.textContent = `${activeItems.length} chapters saved`;
  refs.chapterCount.textContent = `${visibleItems.length} chapters`;

  if (activeItems.length === 0) {
    refs.list.innerHTML = "";
    refs.chapterEmpty.hidden = false;
    refs.empty.hidden = true;
    return;
  }

  if (visibleItems.length === 0) {
    refs.list.innerHTML = "";
    refs.chapterEmpty.hidden = true;
    refs.empty.hidden = false;
    return;
  }

  refs.empty.hidden = true;
  refs.chapterEmpty.hidden = true;
  refs.list.innerHTML = "";
  visibleItems.forEach((item) => {
    refs.list.append(createChapterCard(item, canDrag));
  });
}

function createChapterCard(item, canDrag) {
  const card = refs.template.content.firstElementChild.cloneNode(true);
  card.dataset.id = item.id;
  card.draggable = canDrag;
  card.classList.toggle("is-draggable", canDrag);

  const photoLink = card.querySelector(".wish-photo-link");
  const photo = card.querySelector(".wish-photo");
  if (item.cover) {
    photo.addEventListener(
      "error",
      () => {
        setPlaceholderCover(photo, photoLink, item.title);
      },
      { once: true }
    );
    photo.src = item.cover;
    photo.alt = `${item.title} cover`;
    photoLink.href = item.url;
    photoLink.classList.remove("is-placeholder");
  } else {
    setPlaceholderCover(photo, photoLink, item.title);
    photoLink.href = item.url;
  }

  const titleLink = card.querySelector(".wish-title-link");
  titleLink.textContent = item.title;
  titleLink.href = item.url;

  card.querySelector(".wish-meta-text").textContent = buildMetaLine(item);

  return card;
}

function buildMetaLine(item) {
  const parts = [`Ch. ${item.chapter}`];
  const type = normalizeSeriesType(item.seriesType);
  const genre = normalizeGenre(item.genre);

  if (type && TYPE_LABELS[type]) {
    parts.push(TYPE_LABELS[type]);
  }

  if (genre && GENRE_LABELS[genre]) {
    parts.push(GENRE_LABELS[genre]);
  }

  return parts.join(" · ");
}

function getActiveItems(items) {
  return getOrderedItems(items).filter((item) => !normalizeDeleted(item._deleted));
}

function getVisibleItems(items, query, typeFilter, genreFilter) {
  return items.filter((item) => {
    if (typeFilter !== "all" && normalizeSeriesType(item.seriesType) !== typeFilter) {
      return false;
    }

    if (genreFilter !== "all" && normalizeGenre(item.genre) !== genreFilter) {
      return false;
    }

    if (!query) {
      return true;
    }
    const haystack = `${item.title} ${item.chapter} ${item.seriesType} ${item.genre}`.toLowerCase();
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
      .map((item, index) => ({
        id: String(item.id || createId()),
        createdAt: normalizeTimestamp(item.createdAt, Date.now()),
        _updatedAt: normalizeTimestamp(item._updatedAt || item.updatedAt || item.createdAt, Date.now()),
        order: normalizeOrder(item.order, index),
        title: String(item.title || "Untitled"),
        chapter: String(item.chapter || ""),
        url: String(item.url || "#"),
        cover: String(item.cover || ""),
        seriesType: normalizeSeriesType(item.seriesType),
        genre: normalizeGenre(item.genre),
        _deleted: normalizeDeleted(item._deleted ?? item.deleted)
      }));
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

function normalizeTimestamp(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function normalizeOrder(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
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

function normalizeCoverValue(value) {
  const clean = getCleanValue(value);
  if (!clean) {
    return "";
  }

  if (isDataImageUrl(clean)) {
    return clean;
  }

  return normalizeOptionalUrl(clean);
}

function normalizeSeriesType(value) {
  const clean = getCleanValue(value).toLowerCase();
  if (SERIES_TYPES.includes(clean)) {
    return clean;
  }
  return "";
}

function normalizeGenre(value) {
  const clean = getCleanValue(value).toLowerCase();
  const mapped = LEGACY_GENRE_ALIASES[clean] || clean;
  if (SERIES_GENRES.includes(mapped)) {
    return mapped;
  }
  return "";
}

function normalizeDeleted(value) {
  return value === true;
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

function reorderVisibleItems(sourceId, targetId, insertAfter) {
  const visibleIds = getVisibleItems(getActiveItems(state.items), state.query, state.typeFilter, state.genreFilter).map(
    (item) => item.id
  );
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

function getCleanValue(value) {
  return String(value || "").trim();
}

function isDataImageUrl(value) {
  return getCleanValue(value).toLowerCase().startsWith("data:image/");
}

function createId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chapter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createCoverPlaceholder(title) {
  const firstLetter = getCleanValue(title).charAt(0).toUpperCase() || "?";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#e5f3fd" />
          <stop offset="100%" stop-color="#d1e5f4" />
        </linearGradient>
      </defs>
      <rect width="200" height="200" fill="url(#g)" />
      <text x="100" y="118" text-anchor="middle" fill="#7b7b85" font-family="Nunito, sans-serif" font-size="84" font-weight="700">${firstLetter}</text>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function setPlaceholderCover(photo, photoLink, title) {
  photo.src = createCoverPlaceholder(title);
  photo.alt = `${title} cover placeholder`;
  photoLink.classList.add("is-placeholder");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}
