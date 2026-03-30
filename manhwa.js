const STORAGE_KEY = "manhwa-items-v1";
const CLOUD_LIST_ID = "manhwa";
const COLOR_SAMPLE_SIZE = 24;
const MAX_UPLOAD_BYTES = 1200 * 1024;
const NOTES_EXPORT_FILENAME_PREFIX = "reads-backup";
const STATUSES = ["reading", "want-to-read", "completed"];
const SERIES_TYPES = ["manhwa", "manga", "manhua"];
const SERIES_GENRES = [
  "bl",
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
const STATUS_LABELS = {
  reading: "Reading",
  "want-to-read": "Want to read",
  completed: "Completed"
};
const TYPE_LABELS = {
  manhwa: "manhwa",
  manga: "manga",
  manhua: "manhua"
};
const GENRE_LABELS = {
  bl: "BL",
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

const accentCache = new Map();

const state = {
  items: loadItems(),
  filter: "all",
  typeFilter: "all",
  genreFilter: "all",
  query: "",
  editingId: null,
  pendingDeleteId: null,
  pendingStatusId: null,
  pendingStatusTarget: "",
  draggingId: null,
  draggingListId: null
};

const refs = {
  form: document.getElementById("manhwa-form"),
  listsWrap: document.getElementById("manhwa-lists"),
  ongoingSection: document.getElementById("ongoing-section"),
  wantSection: document.getElementById("want-section"),
  completedSection: document.getElementById("completed-section"),
  ongoingList: document.getElementById("ongoing-list"),
  wantList: document.getElementById("want-list"),
  completedList: document.getElementById("completed-list"),
  ongoingEmpty: document.getElementById("ongoing-empty"),
  wantEmpty: document.getElementById("want-empty"),
  completedEmpty: document.getElementById("completed-empty"),
  ongoingCount: document.getElementById("ongoing-count"),
  wantCount: document.getElementById("want-count"),
  completedCount: document.getElementById("completed-count"),
  template: document.getElementById("manhwa-template"),
  empty: document.getElementById("empty-state"),
  search: document.getElementById("search"),
  coverInput: document.getElementById("cover"),
  coverDataInput: document.getElementById("cover-data"),
  coverFileInput: document.getElementById("cover-file"),
  coverUploadButton: document.getElementById("cover-upload-btn"),
  coverUploadClear: document.getElementById("cover-upload-clear"),
  coverUploadStatus: document.getElementById("cover-upload-status"),
  filters: Array.from(document.querySelectorAll("[data-filter]")),
  typeFilters: Array.from(document.querySelectorAll("[data-type-filter]")),
  genreFilters: Array.from(document.querySelectorAll("[data-genre-filter]")),
  stats: document.getElementById("header-stats"),
  openAdd: document.getElementById("open-add"),
  exportNotes: document.getElementById("export-notes"),
  refreshApp: document.getElementById("refresh-app"),
  closeAdd: document.getElementById("close-add"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalTitle: document.getElementById("modal-title"),
  saveSeriesButton: document.getElementById("save-series-btn"),
  confirmBackdrop: document.getElementById("confirm-backdrop"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmDelete: document.getElementById("confirm-delete"),
  statusBackdrop: document.getElementById("status-backdrop"),
  statusForm: document.getElementById("status-form"),
  statusTitle: document.getElementById("status-title"),
  statusMessage: document.getElementById("status-message"),
  statusChapter: document.getElementById("status-chapter"),
  statusCancel: document.getElementById("status-cancel"),
  statusSave: document.getElementById("status-save")
};

initialize();

function initialize() {
  refs.form.addEventListener("submit", handleSubmit);
  refs.listsWrap.addEventListener("click", handleListClick);
  refs.listsWrap.addEventListener("dragstart", handleCardDragStart);
  refs.listsWrap.addEventListener("dragover", handleCardDragOver);
  refs.listsWrap.addEventListener("drop", handleCardDrop);
  refs.listsWrap.addEventListener("dragend", handleCardDragEnd);
  refs.search.addEventListener("input", handleSearch);
  refs.coverInput.addEventListener("input", handleCoverInputChange);
  refs.coverUploadButton.addEventListener("click", handleCoverUploadClick);
  refs.coverFileInput.addEventListener("change", handleCoverFileChange);
  refs.coverUploadClear.addEventListener("click", clearUploadedCover);
  refs.filters.forEach((button) => button.addEventListener("click", handleFilterChange));
  refs.typeFilters.forEach((button) => button.addEventListener("click", handleTypeFilterChange));
  refs.genreFilters.forEach((button) => button.addEventListener("click", handleGenreFilterChange));
  refs.openAdd.addEventListener("click", openAddModal);
  refs.exportNotes?.addEventListener("click", handleExportNotes);
  refs.refreshApp?.addEventListener("click", handleManualRefresh);
  refs.closeAdd.addEventListener("click", closeModal);
  refs.modalBackdrop.addEventListener("click", handleModalBackdropClick);
  refs.confirmBackdrop.addEventListener("click", handleConfirmBackdropClick);
  refs.confirmCancel.addEventListener("click", closeDeleteConfirm);
  refs.confirmDelete.addEventListener("click", confirmDeleteItem);
  refs.statusBackdrop.addEventListener("click", handleStatusBackdropClick);
  refs.statusCancel.addEventListener("click", closeStatusPrompt);
  refs.statusForm.addEventListener("submit", handleStatusFormSubmit);
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
  setActiveTypeFilterButton();
  setActiveGenreFilterButton();
  resetCoverInputs();
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
      console.error("Cloud sync failed for reads tracker:", error);
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
  const coverValue = getCleanValue(formData.get("cover"));
  const coverDataValue = getCleanValue(formData.get("coverData"));
  const seriesType = normalizeSeriesType(formData.get("seriesType"));
  const genre = normalizeGenre(formData.get("genre"));
  const chapter = getCleanValue(formData.get("chapter"));
  const status = normalizeStatus(formData.get("status"));
  const note = getCleanValue(formData.get("note"));

  if (!title || !urlValue) {
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
    url: parsedUrl,
    cover: parsedCover,
    seriesType,
    genre,
    chapter,
    status,
    note,
    _updatedAt: Date.now()
  };

  if (state.editingId) {
    const editingItem = state.items.find((item) => item.id === state.editingId);
    const nextStatus = normalizeStatus(payload.status || editingItem?.status);
    const chapterChanged = editingItem ? payload.chapter !== (editingItem.chapter || "") : false;
    const shouldPromoteForChapterUpdate = Boolean(editingItem) && nextStatus === "reading" && chapterChanged;
    const nextFrontOrder = shouldPromoteForChapterUpdate ? getFrontOrder(state.items) : null;

    state.items = state.items.map((item) => {
      if (item.id !== state.editingId) {
        return item;
      }
      const nextItem = {
        ...item,
        ...payload
      };

      if (shouldPromoteForChapterUpdate && nextFrontOrder !== null) {
        nextItem.order = nextFrontOrder;
      }

      return nextItem;
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
    return;
  }

  if (action === "toggle-favorite") {
    const now = Date.now();
    state.items = state.items.map((item) => {
      if (item.id !== id) {
        return item;
      }
      return {
        ...item,
        favorite: !normalizeFavorite(item.favorite),
        _updatedAt: now
      };
    });
    persistItems(state.items);
    render();
    return;
  }

  if (action === "cycle-status") {
    openStatusPrompt(id);
    return;
  }

  if (action === "set-complete") {
    openStatusPrompt(id, "completed");
  }
}

function handleSearch(event) {
  state.query = getCleanValue(event.target.value).toLowerCase();
  render();
}

function handleCardDragStart(event) {
  const card = event.target.closest(".wish-card");
  if (!card || !card.draggable) {
    return;
  }

  const listEl = card.closest(".manhwa-list");
  if (!listEl) {
    return;
  }

  state.draggingId = card.dataset.id;
  state.draggingListId = listEl.id;
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

  const targetCard = event.target.closest(".wish-card");
  const targetList = targetCard ? targetCard.closest(".manhwa-list") : event.target.closest(".manhwa-list");
  clearDropTargets();

  if (!targetList || targetList.id !== state.draggingListId) {
    return;
  }

  event.preventDefault();
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

  const sourceId = state.draggingId;
  const sourceListId = state.draggingListId;
  const targetCard = event.target.closest(".wish-card");
  const targetList = targetCard ? targetCard.closest(".manhwa-list") : event.target.closest(".manhwa-list");
  clearDropTargets();

  if (!targetList || targetList.id !== sourceListId) {
    cleanupDragState();
    return;
  }

  event.preventDefault();

  if (!targetCard) {
    reorderListItems(targetList, sourceId, null, false);
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
  reorderListItems(targetList, sourceId, targetId, insertAfter);
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

function handleFilterChange(event) {
  const nextFilter = event.currentTarget.dataset.filter;
  if (!nextFilter) {
    return;
  }

  state.filter = nextFilter;
  setActiveFilterButton();
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

async function handleExportNotes() {
  const exportButton = refs.exportNotes;
  if (!exportButton) {
    return;
  }

  const exportPayload = buildNotesExportPayload(state.items);
  const initialLabel = "export to notes";
  exportButton.disabled = true;
  exportButton.textContent = "exporting...";

  let copied = false;
  try {
    copied = await copyNotesExportToClipboard(exportPayload);
  } catch (error) {
    console.error("Could not copy notes export:", error);
  }

  if (copied) {
    exportButton.textContent = "copied";
  } else {
    downloadNotesExport(exportPayload.plainText);
    exportButton.textContent = "downloaded txt";
  }

  window.setTimeout(() => {
    exportButton.disabled = false;
    exportButton.textContent = initialLabel;
  }, 1500);
}

function handleConfirmBackdropClick(event) {
  if (event.target === refs.confirmBackdrop) {
    closeDeleteConfirm();
  }
}

function handleStatusBackdropClick(event) {
  if (event.target === refs.statusBackdrop) {
    closeStatusPrompt();
  }
}

function handleStatusFormSubmit(event) {
  event.preventDefault();

  if (!state.pendingStatusId || !state.pendingStatusTarget) {
    closeStatusPrompt();
    return;
  }

  const item = state.items.find((entry) => entry.id === state.pendingStatusId);
  if (!item) {
    closeStatusPrompt();
    return;
  }

  const chapterInput = getCleanValue(refs.statusChapter.value);
  const chapter = chapterInput || item.chapter || "";
  const now = Date.now();
  const currentStatus = normalizeStatus(item.status);
  const targetStatus = normalizeStatus(state.pendingStatusTarget);
  const isReadingChapterUpdate = currentStatus === "reading" && targetStatus === "reading";
  const nextFrontOrder = isReadingChapterUpdate ? getFrontOrder(state.items) : null;

  state.items = state.items.map((entry) => {
    if (entry.id !== state.pendingStatusId) {
      return entry;
    }

    const nextEntry = {
      ...entry,
      status: targetStatus,
      chapter,
      _updatedAt: now
    };

    if (isReadingChapterUpdate && nextFrontOrder !== null) {
      nextEntry.order = nextFrontOrder;
    }

    return nextEntry;
  });

  persistItems(state.items);
  render();
  closeStatusPrompt();
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") {
    return;
  }

  if (!refs.statusBackdrop.hidden) {
    closeStatusPrompt();
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
  refs.form.querySelector("#status").value = "";
  refs.modalTitle.textContent = "Add a read";
  refs.saveSeriesButton.textContent = "Save to tracker";
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
  populateCoverInputs(item.cover || "");
  refs.form.querySelector("#series-type").value = normalizeSeriesType(item.seriesType);
  refs.form.querySelector("#series-genre").value = normalizeGenre(item.genre);
  refs.form.querySelector("#chapter").value = item.chapter || "";
  refs.form.querySelector("#status").value = normalizeStatus(item.status);
  refs.form.querySelector("#note").value = item.note || "";

  refs.modalTitle.textContent = "Edit series";
  refs.saveSeriesButton.textContent = "Save changes";
  openModal();
  refs.form.querySelector("#title").focus();
}

function openModal() {
  refs.confirmBackdrop.hidden = true;
  refs.statusBackdrop.hidden = true;
  state.pendingDeleteId = null;
  state.pendingStatusId = null;
  state.pendingStatusTarget = "";
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
  refs.statusBackdrop.hidden = true;
  state.editingId = null;
  state.pendingStatusId = null;
  state.pendingStatusTarget = "";
  state.pendingDeleteId = id;
  refs.confirmBackdrop.hidden = false;
  syncBodyModalState();
}

function closeDeleteConfirm() {
  refs.confirmBackdrop.hidden = true;
  state.pendingDeleteId = null;
  syncBodyModalState();
}

function openStatusPrompt(id, requestedTarget = "") {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) {
    return;
  }

  const currentStatus = normalizeStatus(item.status);
  const targetStatus = requestedTarget
    ? normalizeStatus(requestedTarget)
    : currentStatus === "reading"
      ? "reading"
      : getQuickStatusTarget(currentStatus);
  if (!targetStatus) {
    return;
  }

  if (currentStatus === "completed" && targetStatus === "completed") {
    return;
  }

  state.pendingStatusId = id;
  state.pendingStatusTarget = targetStatus;
  state.editingId = null;
  state.pendingDeleteId = null;

  refs.modalBackdrop.hidden = true;
  refs.confirmBackdrop.hidden = true;
  refs.statusBackdrop.hidden = false;

  const isReadingChapterUpdate = currentStatus === "reading" && targetStatus === "reading";
  const isCompleting = targetStatus === "completed";
  const actionLabel = isReadingChapterUpdate
    ? "Update chapter"
    : isCompleting
      ? "Set to complete"
      : getStatusActionLabel(currentStatus);

  refs.statusTitle.textContent = actionLabel;
  refs.statusMessage.textContent = isReadingChapterUpdate
    ? "Add your latest chapter read."
    : isCompleting
      ? "Add your latest chapter before marking complete."
      : "Add your latest chapter before updating status.";
  refs.statusSave.textContent = actionLabel;
  refs.statusChapter.value = item.chapter || "";
  syncBodyModalState();
  refs.statusChapter.focus();
  refs.statusChapter.select();
}

function closeStatusPrompt() {
  refs.statusBackdrop.hidden = true;
  state.pendingStatusId = null;
  state.pendingStatusTarget = "";
  refs.statusChapter.value = "";
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
  const anyOpen =
    !refs.modalBackdrop.hidden ||
    !refs.confirmBackdrop.hidden ||
    !refs.statusBackdrop.hidden ||
    Boolean(authBackdrop && !authBackdrop.hidden);
  document.body.classList.toggle("modal-open", anyOpen);
}

function resetOverlayState() {
  refs.modalBackdrop.hidden = true;
  refs.confirmBackdrop.hidden = true;
  refs.statusBackdrop.hidden = true;
  state.editingId = null;
  state.pendingDeleteId = null;
  state.pendingStatusId = null;
  state.pendingStatusTarget = "";
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

function setActiveFilterButton() {
  refs.filters.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === state.filter);
  });
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
  const visibleItems = getVisibleItems(state.items, state.filter, state.typeFilter, state.genreFilter, state.query);
  const ongoingItems = visibleItems.filter((item) => {
    const status = normalizeStatus(item.status);
    return status !== "completed" && status !== "want-to-read";
  });
  const wantItems = visibleItems.filter((item) => normalizeStatus(item.status) === "want-to-read");
  const completedItems = visibleItems.filter((item) => normalizeStatus(item.status) === "completed");

  refs.ongoingCount.textContent = `${ongoingItems.length} series`;
  refs.wantCount.textContent = `${wantItems.length} series`;
  refs.completedCount.textContent = `${completedItems.length} series`;

  refs.empty.hidden = visibleItems.length !== 0;
  if (visibleItems.length === 0) {
    refs.ongoingSection.hidden = true;
    refs.wantSection.hidden = true;
    refs.completedSection.hidden = true;
    refs.ongoingList.innerHTML = "";
    refs.wantList.innerHTML = "";
    refs.completedList.innerHTML = "";
    refs.ongoingEmpty.hidden = true;
    refs.wantEmpty.hidden = true;
    refs.completedEmpty.hidden = true;
    renderStats(state.items);
    return;
  }

  const showOngoing = state.filter === "all" || state.filter === "reading";
  const showWant = state.filter === "all" || state.filter === "want-to-read";
  const showCompleted = state.filter === "all" || state.filter === "completed";

  refs.ongoingSection.hidden = !showOngoing;
  refs.wantSection.hidden = !showWant;
  refs.completedSection.hidden = !showCompleted;

  renderSection(refs.ongoingList, refs.ongoingEmpty, ongoingItems, showOngoing);
  renderSection(refs.wantList, refs.wantEmpty, wantItems, showWant);
  renderSection(refs.completedList, refs.completedEmpty, completedItems, showCompleted);

  renderStats(state.items);
}

function renderSection(listEl, emptyEl, items, visible) {
  if (!visible) {
    listEl.innerHTML = "";
    emptyEl.hidden = true;
    return;
  }

  const sortedItems = sortSectionItems(items);
  const canDrag = items.length > 1;
  listEl.innerHTML = "";
  sortedItems.forEach((item) => {
    listEl.append(createSeriesCard(item, canDrag));
  });

  emptyEl.hidden = items.length !== 0;
}

function createSeriesCard(item, canDrag) {
  const card = refs.template.content.firstElementChild.cloneNode(true);
  card.dataset.id = item.id;
  card.draggable = canDrag;
  card.classList.toggle("is-draggable", canDrag);
  card.classList.toggle("is-favorite", normalizeFavorite(item.favorite));
  clearCardAccent(card);

  const statusPill = card.querySelector(".series-status");
  statusPill.textContent = STATUS_LABELS[normalizeStatus(item.status)];
  statusPill.classList.add(`status-${normalizeStatus(item.status)}`);

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
    applyCardAccentFromImage(card, photo, item.cover);
  } else {
    setPlaceholderCover(photo, photoLink, item.title);
    photoLink.href = item.url;
  }

  const titleLink = card.querySelector(".wish-title-link");
  titleLink.textContent = normalizeFavorite(item.favorite) ? `${item.title} ✦` : item.title;
  titleLink.href = item.url;

  card.querySelector(".wish-meta-text").textContent = buildMetaLine(item);

  const note = card.querySelector(".series-note");
  if (item.note) {
    note.hidden = false;
    note.textContent = item.note;
  } else {
    note.hidden = true;
    note.textContent = "";
  }

  const cycleButton = card.querySelector("[data-action='cycle-status']");
  cycleButton.textContent = getCardMenuActionLabel(item.status);

  const completeButton = card.querySelector("[data-action='set-complete']");
  const isCompleted = normalizeStatus(item.status) === "completed";
  completeButton.hidden = isCompleted;
  completeButton.disabled = isCompleted;

  const favoriteButton = card.querySelector("[data-action='toggle-favorite']");
  favoriteButton.textContent = normalizeFavorite(item.favorite) ? "Unfavorite" : "Favorite";

  return card;
}

function buildMetaLine(item) {
  const parts = [];
  if (item.chapter) {
    parts.push(`Ch. ${item.chapter}`);
  }
  const type = normalizeSeriesType(item.seriesType);
  const genre = normalizeGenre(item.genre);
  if (type && TYPE_LABELS[type]) {
    parts.push(TYPE_LABELS[type]);
  }
  if (genre && GENRE_LABELS[genre]) {
    parts.push(GENRE_LABELS[genre]);
  }
  parts.push(STATUS_LABELS[normalizeStatus(item.status)]);
  return parts.join(" · ");
}

function renderStats(items) {
  const activeItems = items.filter((item) => !normalizeDeleted(item._deleted));
  const total = activeItems.length;
  const reading = activeItems.filter((item) => normalizeStatus(item.status) === "reading").length;
  const want = activeItems.filter((item) => normalizeStatus(item.status) === "want-to-read").length;
  refs.stats.textContent = `${total} series • ${reading} reading • ${want} want to read`;
}

function getVisibleItems(items, filter, typeFilter, genreFilter, query) {
  return getOrderedItems(items)
    .filter((item) => !normalizeDeleted(item._deleted))
    .filter((item) => {
      if (filter === "all") {
        return true;
      }
      return normalizeStatus(item.status) === filter;
    })
    .filter((item) => {
      if (typeFilter === "all") {
        return true;
      }
      return normalizeSeriesType(item.seriesType) === typeFilter;
    })
    .filter((item) => {
      if (genreFilter === "all") {
        return true;
      }
      return normalizeGenre(item.genre) === genreFilter;
    })
    .filter((item) => {
      if (!query) {
        return true;
      }
      const haystack =
        `${item.title} ${item.chapter} ${item.status} ${item.note} ${item.seriesType} ${item.genre}`.toLowerCase();
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
        url: String(item.url || "#"),
        cover: String(item.cover || ""),
        seriesType: normalizeSeriesType(item.seriesType),
        genre: normalizeGenre(item.genre),
        chapter: String(item.chapter || ""),
        status: normalizeStatus(item.status),
        favorite: normalizeFavorite(item.favorite ?? item.favourite ?? item.pinned),
        note: String(item.note || ""),
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

function normalizeUrl(value) {
  try {
    return new URL(String(value || "").trim()).toString();
  } catch {
    return String(value || "").trim();
  }
}

function normalizeStatus(value) {
  const clean = getCleanValue(value).toLowerCase();
  if (STATUSES.includes(clean)) {
    return clean;
  }
  return "reading";
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

function reorderListItems(listEl, sourceId, targetId, insertAfter) {
  const visibleIds = Array.from(listEl.querySelectorAll(".wish-card"))
    .map((card) => card.dataset.id)
    .filter(Boolean);

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
  refs.listsWrap.querySelectorAll(".drop-target").forEach((card) => card.classList.remove("drop-target"));
}

function cleanupDragState() {
  state.draggingId = null;
  state.draggingListId = null;
  refs.listsWrap.querySelectorAll(".is-dragging").forEach((card) => card.classList.remove("is-dragging"));
  clearDropTargets();
}

function getQuickStatusTarget(currentStatus) {
  const status = normalizeStatus(currentStatus);
  if (status === "want-to-read") {
    return "reading";
  }

  if (status === "reading") {
    return "completed";
  }

  if (status === "completed") {
    return "reading";
  }

  return "reading";
}

function getStatusActionLabel(currentStatus) {
  const targetStatus = getQuickStatusTarget(currentStatus);
  if (targetStatus === "completed") {
    return "Set to complete";
  }

  return `Set to ${STATUS_LABELS[targetStatus].toLowerCase()}`;
}

function getCardMenuActionLabel(currentStatus) {
  if (normalizeStatus(currentStatus) === "reading") {
    return "Update chapter";
  }
  return getStatusActionLabel(currentStatus);
}

function sortSectionItems(items) {
  return [...items].sort((a, b) => {
    const aFavorite = normalizeFavorite(a.favorite) ? 1 : 0;
    const bFavorite = normalizeFavorite(b.favorite) ? 1 : 0;
    if (aFavorite !== bFavorite) {
      return bFavorite - aFavorite;
    }
    return normalizeOrder(a.order, 0) - normalizeOrder(b.order, 0);
  });
}

function normalizeFavorite(value) {
  if (value === true || value === 1 || value === "1") {
    return true;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return false;
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
  return `series-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createCoverPlaceholder(title) {
  const firstLetter = getCleanValue(title).charAt(0).toUpperCase() || "?";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f2dfe3" />
          <stop offset="100%" stop-color="#e7cfc7" />
        </linearGradient>
      </defs>
      <rect width="200" height="200" fill="url(#g)" />
      <text x="100" y="118" text-anchor="middle" fill="#896d66" font-family="Nunito, sans-serif" font-size="84" font-weight="700">${firstLetter}</text>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function setPlaceholderCover(photo, photoLink, title) {
  photo.src = createCoverPlaceholder(title);
  photo.alt = `${title} cover placeholder`;
  photoLink.classList.add("is-placeholder");
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function buildNotesExportPayload(items) {
  const activeItems = getOrderedItems(items).filter((item) => !normalizeDeleted(item._deleted));
  const ongoingItems = sortSectionItems(
    activeItems.filter((item) => {
      const status = normalizeStatus(item.status);
      return status !== "completed" && status !== "want-to-read";
    })
  );
  const completedItems = sortSectionItems(activeItems.filter((item) => normalizeStatus(item.status) === "completed"));

  const ongoingLines = ongoingItems.map(formatOngoingNotesLine);
  const completedLines = completedItems.map(formatCompletedNotesLine);

  const plainText = [
    "ongoing reads:",
    ...ongoingLines,
    "",
    "completed reads:",
    ...completedLines
  ].join("\n");

  const ongoingBodyHtml = (ongoingLines.length ? ongoingLines : ["none yet"]).map(escapeHtml).join("<br />");
  const completedBodyHtml = (completedLines.length ? completedLines : ["none yet"]).map(escapeHtml).join("<br />");
  const html = `
    <h2 style="margin:0 0 6px 0;">ongoing reads:</h2>
    <p style="margin:0;">${ongoingBodyHtml}</p>
    <br />
    <h2 style="margin:0 0 6px 0;">completed reads:</h2>
    <p style="margin:0;">${completedBodyHtml}</p>
  `;

  return { plainText, html };
}

function formatOngoingNotesLine(item) {
  const chapter = getCleanValue(item.chapter);
  const chapterPart = /^chapter\b/i.test(chapter) ? chapter : chapter ? `chapter ${chapter}` : "chapter ?";
  const source = extractSourceLabel(item.url);
  return `${item.title} (${chapterPart}; ${source})`;
}

function formatCompletedNotesLine(item) {
  const chapter = getCleanValue(item.chapter);
  const chapterPart = /^\d+(\.\d+)?$/u.test(chapter)
    ? `${chapter} chapters`
    : chapter
      ? chapter
      : "chapters unknown";
  const source = extractSourceLabel(item.url);
  return `${item.title} (${source}; ${chapterPart})`;
}

function extractSourceLabel(urlValue) {
  const cleanUrl = getCleanValue(urlValue);
  if (!cleanUrl) {
    return "source unknown";
  }

  let hostname = "";
  try {
    hostname = new URL(cleanUrl).hostname.toLowerCase();
  } catch {
    return "source unknown";
  }

  const host = hostname.replace(/^www\./, "").replace(/^m\./, "");
  const knownSources = {
    "asurascans.com": "asurascans",
    "asuratoon.com": "asurascans",
    "asuracomic.com": "asurascans",
    "asuracomic.net": "asurascans",
    "mangabuddy.com": "mangabuddy",
    "bato.to": "bato",
    "harimanga.com": "harimanga",
    "mangadex.org": "mangadex",
    "webtoons.com": "webtoon",
    "mangaowl.io": "mangaowl",
    "manhuahot.com": "manhuahot",
    "zinmanga.com": "zinmanga",
    "kunmanga.com": "kunmanga",
    "vortexscans.org": "vortexscans"
  };

  const exact = knownSources[host];
  if (exact) {
    return exact;
  }

  const sourceSuffixes = Object.keys(knownSources);
  for (const suffix of sourceSuffixes) {
    if (host.endsWith(`.${suffix}`)) {
      return knownSources[suffix];
    }
  }

  if (host.includes("asuracomic")) {
    return "asurascans";
  }

  return deriveDomainLabel(host);
}

function deriveDomainLabel(host) {
  const segments = host.split(".").filter(Boolean);
  if (segments.length === 0) {
    return "source unknown";
  }
  if (segments.length === 1) {
    return segments[0];
  }

  let index = segments.length - 2;
  if (segments.length >= 3 && segments[segments.length - 1].length === 2 && segments[segments.length - 2].length <= 3) {
    index = segments.length - 3;
  }

  const core = segments[index] || segments[segments.length - 2];
  const cleanCore = core.replace(/[^a-z0-9-]/gi, "");
  return cleanCore || "source unknown";
}

async function copyNotesExportToClipboard(payload) {
  if (!navigator.clipboard) {
    return false;
  }

  if (window.ClipboardItem && payload.html) {
    try {
      const clipboardItem = new ClipboardItem({
        "text/plain": new Blob([payload.plainText], { type: "text/plain" }),
        "text/html": new Blob([payload.html], { type: "text/html" })
      });
      await navigator.clipboard.write([clipboardItem]);
      return true;
    } catch (error) {
      console.error("Rich clipboard write failed, falling back to plain text:", error);
    }
  }

  try {
    await navigator.clipboard.writeText(payload.plainText);
    return true;
  } catch (error) {
    console.error("Plain clipboard write failed:", error);
    return false;
  }
}

function downloadNotesExport(text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${NOTES_EXPORT_FILENAME_PREFIX}-${stamp}.txt`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
