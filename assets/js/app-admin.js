import { createOrderSnapshot, exportOrdersBackup, getCategories, getInventory, getOrders, getSession, getSettings, importOrdersBackup, loginAdmin, logoutAdmin, saveInventory, saveOrders, saveSettings } from './store.js';
import { CONTACT_METHODS, ORDER_STATUSES, PAYMENT_STATUSES, addDays, buildContactMap, compareCompletedDesc, compareExchangeAsc, contactSummary, currency, formatDateTime, getOrderColumn, normalizeCategory, overlaps, parseDateTime, safeText, uid } from './utils.js';
import { debounce, geocodeAddress, searchAddresses } from './geo.js';

const state = {
  inventory: [],
  orders: [],
  settings: {},
  activeTab: 'orders',
  editingOrderId: null,
  editingInventoryId: null,
  expandedOrderId: null,
  imageLibrary: [],
  pickupSuggestions: [],
  pickupLookupToken: 0,
  orderActionDelegatesBound: false,
  collapsedColumns: {
    pending: false,
    completed: false
  }
};

const els = {};

const DEPOSIT_THRESHOLD = 100;
const DEPOSIT_RATE = 0.35;

function formatDistanceTag(match) {
  return Number.isFinite(match?.distanceFromOriginMiles)
    ? `${match.distanceFromOriginMiles.toFixed(1)} mi from saved pickup`
    : '';
}

function hidePickupSuggestions() {
  if (!els.pickupAddressSuggestions) return;
  els.pickupAddressSuggestions.classList.add('hidden');
}

function renderPickupSuggestions(matches = []) {
  if (!els.pickupAddressSuggestions) return;
  state.pickupSuggestions = Array.isArray(matches) ? matches : [];
  if (!state.pickupSuggestions.length) {
    els.pickupAddressSuggestions.innerHTML = '';
    hidePickupSuggestions();
    return;
  }
  els.pickupAddressSuggestions.innerHTML = state.pickupSuggestions.map((match, index) => `
    <button type="button" class="address-suggestion${index === 0 ? ' active' : ''}" data-pickup-suggestion="${index}">
      <div class="address-suggestion-primary">${safeText(match.primaryLine || match.label)}</div>
      <div class="address-suggestion-secondary">${safeText(match.secondaryLine || match.label)}</div>
      ${formatDistanceTag(match) ? `<div class="address-suggestion-distance">${safeText(formatDistanceTag(match))}</div>` : ''}
    </button>
  `).join('');
  els.pickupAddressSuggestions.classList.remove('hidden');
}


function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
  if (els.settingsForm?.elements?.emailNotificationsEnabled) {
    els.settingsForm.elements.emailNotificationsEnabled.checked = Boolean(settings.emailNotificationsEnabled);
  }
  if (els.pickupLookupStatus) {
    const coords = settings.pickupCoords;
    els.pickupLookupStatus.textContent = coords?.lat != null && coords?.lon != null
      ? `Saved pickup coordinates: ${Number(coords.lat).toFixed(5)}, ${Number(coords.lon).toFixed(5)}`
      : 'Save a valid pickup address to store coordinates for delivery quotes.';
  }
}


function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      reject(new Error('No image source provided'));
      return;
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

async function compressImageFile(file, maxSize = 900, quality = 0.82) {
  if (!file) return '';
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImageElement(dataUrl);

  let { width, height } = img;
  const longest = Math.max(width, height);
  if (longest > maxSize) {
    const scale = maxSize / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL('image/jpeg', quality);
}

function getInventoryImageSrc(item) {
  return item?.imageData || item?.imageUrl || '';
}

function normalizeAccessories(accessories = []) {
  return Array.isArray(accessories) ? accessories.map((entry) => ({
    id: entry?.id || uid('acc'),
    name: (entry?.name || '').trim(),
    price: Number(entry?.price || 0),
    imageData: entry?.imageData || ''
  })).filter((entry) => entry.name) : [];
}

function getAccessoryImageSrc(accessory) {
  return accessory?.imageData || '';
}

function getSelectedAccessoryIds(inventoryId) {
  return Array.isArray(state.selectedAccessories?.[inventoryId]) ? state.selectedAccessories[inventoryId] : [];
}

function getSelectedAccessoriesForItem(item) {
  const selectedIds = getSelectedAccessoryIds(item.id);
  return normalizeAccessories(item.accessories).filter((accessory) => selectedIds.includes(accessory.id));
}

function getDisplayImageForPickerItem(item) {
  const selected = getSelectedAccessoriesForItem(item);
  const accessoryWithImage = [...selected].reverse().find((entry) => getAccessoryImageSrc(entry));
  return getAccessoryImageSrc(accessoryWithImage) || getInventoryImageSrc(item);
}

function createAccessoryRow(accessory = {}) {
  const row = document.createElement('div');
  row.className = 'accessory-admin-row';
  row.innerHTML = `
    <div class="accessory-admin-grid">
      <div class="form-row">
        <label>Accessory Name</label>
        <input type="text" data-acc-name placeholder="Black Fitted Cover" value="${safeText(accessory.name || '')}" />
      </div>
      <div class="form-row">
        <label>Cost Each</label>
        <input type="number" min="0" step="0.01" data-acc-price value="${Number(accessory.price || 0)}" />
      </div>
      <div class="form-row">
        <label>Accessory Image</label>
        <input type="file" data-acc-upload accept="image/*" />
        <input type="hidden" data-acc-image value="${safeText(accessory.imageData || '')}" />
        <div class="small muted" style="margin-top:6px;">Optional. If chosen by the customer, the item image swaps to this image.</div>
      </div>
      <div class="form-row">
        <label>Preview</label>
        <img class="inventory-image accessory-preview" data-acc-preview alt="Accessory preview" ${accessory.imageData ? `src="${safeText(accessory.imageData)}"` : ''} ${accessory.imageData ? '' : 'hidden'} />
      </div>
    </div>
    <div class="accessory-admin-actions">
      <button type="button" class="btn btn-ghost btn-small" data-remove-accessory>Remove Accessory</button>
    </div>
  `;
  row.dataset.accessoryId = accessory.id || uid('acc');
  return row;
}

function renderAccessoryRows(accessories = []) {
  if (!els.accessoriesBox) return;
  els.accessoriesBox.innerHTML = '';
  const normalized = normalizeAccessories(accessories);
  if (!normalized.length) {
    els.accessoriesBox.innerHTML = '<div class="empty-state">No accessories yet.</div>';
    return;
  }
  normalized.forEach((accessory) => {
    els.accessoriesBox.appendChild(createAccessoryRow(accessory));
  });
}

function collectAccessoriesFromForm() {
  if (!els.accessoriesBox) return [];
  return [...els.accessoriesBox.querySelectorAll('.accessory-admin-row')].map((row) => ({
    id: row.dataset.accessoryId || uid('acc'),
    name: (row.querySelector('[data-acc-name]')?.value || '').trim(),
    price: Number(row.querySelector('[data-acc-price]')?.value || 0),
    imageData: row.querySelector('[data-acc-image]')?.value || ''
  })).filter((accessory) => accessory.name);
}



document.addEventListener('DOMContentLoaded', () => { init().catch(handleFatalError); });

async function init() {
  cacheEls();
  const session = await getSession();
  if (!session) {
    els.loginView.classList.remove('hidden');
    els.appView.classList.add('hidden');
    bindLogin();
    return;
  }
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
  bindApp();
  await loadImageLibrary();
  await loadData();
  renderAll();
}

function cacheEls() {
  Object.assign(els, {
    loginView: document.getElementById('loginView'),
    appView: document.getElementById('appView'),
    loginForm: document.getElementById('loginForm'),
    loginError: document.getElementById('loginError'),
    tabButtons: [...document.querySelectorAll('[data-tab-btn]')],
    panels: [...document.querySelectorAll('[data-tab-panel]')],
    logoutBtn: document.getElementById('logoutBtn'),
    copyPickupAddressBtn: document.getElementById('copyPickupAddressBtn'),
    pendingList: document.getElementById('pendingList'),
    confirmedList: document.getElementById('confirmedList'),
    completedList: document.getElementById('completedList'),
    pendingTotal: document.getElementById('pendingTotal'),
    confirmedTotal: document.getElementById('confirmedTotal'),
    completedTotal: document.getElementById('completedTotal'),
    pendingColumn: document.getElementById('pendingColumn'),
    confirmedColumn: document.getElementById('confirmedColumn'),
    completedColumn: document.getElementById('completedColumn'),
    collapsedColumnsRail: document.getElementById('collapsedColumnsRail'),
    addOrderBtn: document.getElementById('addOrderBtn'),
    addInventoryBtn: document.getElementById('addInventoryBtn'),
    inventoryList: document.getElementById('inventoryList'),
    settingsForm: document.getElementById('settingsForm'),
    settingsSaved: document.getElementById('settingsSaved'),
    orderModalWrap: document.getElementById('orderModalWrap'),
    orderModalTitle: document.getElementById('orderModalTitle'),
    orderForm: document.getElementById('orderForm'),
    orderItemsBox: document.getElementById('orderItemsBox'),
    inventoryModalWrap: document.getElementById('inventoryModalWrap'),
    inventoryModalTitle: document.getElementById('inventoryModalTitle'),
    inventoryForm: document.getElementById('inventoryForm'),
    categorySuggestions: document.getElementById('categorySuggestions'),
    imageUpload: document.getElementById('imageUpload'),
    imageData: document.getElementById('imageData'),
    addAccessoryBtn: document.getElementById('addAccessoryBtn'),
    accessoriesBox: document.getElementById('accessoriesBox'),
    inventoryStats: document.getElementById('inventoryStats'),
    backupExportBtn: document.getElementById('backupExportBtn'),
    backupSnapshotBtn: document.getElementById('backupSnapshotBtn'),
    backupImportBtn: document.getElementById('backupImportBtn'),
    backupImportFile: document.getElementById('backupImportFile'),
    backupStatus: document.getElementById('backupStatus'),
    pickupAddressInput: document.getElementById('pickupAddressInput'),
    pickupAddressSuggestions: document.getElementById('pickupAddressSuggestions'),
    pickupLookupStatus: document.getElementById('pickupLookupStatus'),
    pendingColumn: document.getElementById('pendingColumn'),
    confirmedColumn: document.getElementById('confirmedColumn'),
    completedColumn: document.getElementById('completedColumn'),
    collapsedColumnsRail: document.getElementById('collapsedColumnsRail'),
    orderDiscountPreview: document.getElementById('orderDiscountPreview')
  });
}

function bindLogin() {
  els.loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.loginError.textContent = '';
    const form = new FormData(els.loginForm);
    try {
      await loginAdmin(form.get('email'), form.get('password'));
      window.location.reload();
    } catch (error) {
      els.loginError.textContent = error.message;
    }
  });
}


  const debouncedPickupLookup = debounce(async (query) => {
    if (!els.pickupAddressSuggestions) return;
    const text = (query || '').trim();
    const token = ++state.pickupLookupToken;
    if (text.length < 3) {
      renderPickupSuggestions([]);
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = text ? 'Keep typing for address suggestions.' : '';
      return;
    }
    try {
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = 'Looking up address…';
      const matches = await searchAddresses(text, { limit: 6, origin: state.settings?.pickupCoords || null, context: state.settings || null });
      if (token !== state.pickupLookupToken) return;
      renderPickupSuggestions(matches);
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = matches.length ? (state.settings?.googleMapsApiKey ? 'Choose a Google suggestion below.' : 'Choose a suggestion below. Nearby matches are pushed to the top.') : 'No suggestions found yet. You can still save the typed address.';
    } catch (error) {
      if (token !== state.pickupLookupToken) return;
      renderPickupSuggestions([]);
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = 'Autocomplete is unavailable right now. You can still save the typed address.';
    }
  }, 280);

function bindApp() {
  els.tabButtons.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tabBtn)));
  els.logoutBtn.addEventListener('click', async () => {
    await logoutAdmin();
    window.location.reload();
  });
  els.copyPickupAddressBtn?.addEventListener('click', async () => {
    await copyPickupAddressMessage();
  });
  els.addOrderBtn.addEventListener('click', () => openOrderModal());
  els.addInventoryBtn.addEventListener('click', () => openInventoryModal());
  document.querySelectorAll('[data-close-modal]').forEach((btn) => btn.addEventListener('click', closeModals));
  els.orderModalWrap.addEventListener('click', (e) => { if (e.target === els.orderModalWrap) closeModals(); });
  els.inventoryModalWrap.addEventListener('click', (e) => { if (e.target === els.inventoryModalWrap) closeModals(); });
  els.orderForm.addEventListener('submit', handleOrderSave);
  els.orderForm.elements.exchangeDate?.addEventListener('change', () => setReturnDateFromExchange(false));
  els.orderForm.elements.returnDate?.addEventListener('change', () => { els.orderForm.elements.returnDate.dataset.userEdited = 'true'; });
  ['deliveryFee', 'adjustedTotal'].forEach((name) => {
    els.orderForm.elements[name]?.addEventListener('input', syncOrderTotalsPreview);
  });
  els.orderForm.elements.eventDate?.addEventListener('input', () => setExchangeAndReturnFromEventDate(false));
  ['exchangeDate', 'returnDate'].forEach((name) => {
    els.orderForm.elements[name]?.addEventListener('input', () => { els.orderForm.elements[name].dataset.userEdited = 'true'; });
  });
  document.querySelectorAll('[data-toggle-column]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.toggleColumn;
    state.collapsedColumns[key] = !state.collapsedColumns[key];
    applyOrderColumnCollapseState();
  }));
  els.inventoryForm.addEventListener('submit', handleInventorySave);
  els.settingsForm.addEventListener('submit', handleSettingsSave);
  els.pickupAddressInput?.addEventListener('input', (event) => debouncedPickupLookup(event.target.value));
  els.pickupAddressInput?.addEventListener('focus', () => {
    if (state.pickupSuggestions.length) renderPickupSuggestions(state.pickupSuggestions);
  });
  els.pickupAddressInput?.addEventListener('blur', () => {
    window.setTimeout(() => hidePickupSuggestions(), 160);
  });
  els.pickupAddressSuggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pickup-suggestion]');
    if (!button) return;
    const match = state.pickupSuggestions[Number(button.dataset.pickupSuggestion)];
    if (!match) return;
    els.pickupAddressInput.value = match.label;
    hidePickupSuggestions();
    if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = 'Selected address suggestion.';
  });
  document.addEventListener('click', (event) => {
    if (event.target === els.pickupAddressInput || els.pickupAddressSuggestions?.contains(event.target)) return;
    hidePickupSuggestions();
  });
  els.backupExportBtn?.addEventListener('click', handleBackupExport);
  els.backupSnapshotBtn?.addEventListener('click', handleCreateSnapshot);
  els.backupImportBtn?.addEventListener('click', () => els.backupImportFile?.click());
  els.backupImportFile?.addEventListener('change', handleBackupImport);
  els.addAccessoryBtn?.addEventListener('click', () => {
    const emptyState = els.accessoriesBox?.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    els.accessoriesBox?.appendChild(createAccessoryRow());
  });
  els.accessoriesBox?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-accessory]');
    if (!btn) return;
    btn.closest('.accessory-admin-row')?.remove();
    if (!els.accessoriesBox?.querySelector('.accessory-admin-row')) {
      renderAccessoryRows([]);
    }
  });
  els.accessoriesBox?.addEventListener('change', async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-acc-upload]')) return;
    const row = input.closest('.accessory-admin-row');
    if (!row) return;
    const hidden = row.querySelector('[data-acc-image]');
    const preview = row.querySelector('[data-acc-preview]');
    try {
      const file = input.files?.[0];
      if (!file) {
        if (hidden) hidden.value = '';
        if (preview) {
          preview.src = '';
          preview.hidden = true;
        }
        return;
      }
      const compressed = await compressImageFile(file);
      if (hidden) hidden.value = compressed;
      if (preview) {
        preview.src = compressed;
        preview.hidden = false;
      }
    } catch (error) {
      console.error(error);
      alert('Could not process that accessory image.');
    }
  });
  els.imageUpload?.addEventListener('change', async () => {
    try {
      const file = els.imageUpload.files?.[0];
      if (!file) {
        if (els.imageData) els.imageData.value = '';
        handleInventoryImagePreview();
        return;
      }
      const compressed = await compressImageFile(file);
      if (els.imageData) els.imageData.value = compressed;
      handleInventoryImagePreview();
    } catch (error) {
      console.error(error);
      alert('Could not process that image.');
    }
  });
}


async function loadImageLibrary() {
  state.imageLibrary = [];
}

function normalizeLibraryImageUrl(url) {
  return url || '';
}

function renderImageLibraryOptions(selected = '') {
  return;
}

function handleInventoryImagePreview() {
  const preview = document.getElementById('inventoryPreview');
  if (!preview) return;
  const src = els.imageData?.value || '';
  preview.src = src;
  preview.hidden = !src;
}

async function loadData() {
  state.inventory = await getInventory();
  state.orders = await getOrders();
  state.settings = await getSettings();
}

async function saveAndRefresh(actor = 'admin') {
  await saveInventory(state.inventory);
  await saveOrders(state.orders, { actor });
  await saveSettings(state.settings);
  await loadData();
  renderAll();
}

function renderAll() {
  renderTabs();
  renderOrders();
  renderInventory();
  renderSettings();
}

function setTab(tab) {
  state.activeTab = tab;
  renderTabs();
}

function renderTabs() {
  els.tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tabBtn === state.activeTab));
  els.panels.forEach((panel) => panel.classList.toggle('active', panel.dataset.tabPanel === state.activeTab));
}


function calculateOrderItemsSubtotal(items = []) {
  return (items || []).reduce((sum, item) => sum + Number(item?.subtotal || 0), 0);
}

function getBaseOrderTotal(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length) {
    const originalItemsTotal = items.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unitPrice || 0)), 0);
    return originalItemsTotal + Number(order.deliveryFee || 0);
  }
  if (Number.isFinite(Number(order.baseTotal)) && Number(order.baseTotal) > 0) return Number(order.baseTotal);
  return calculateOrderItemsSubtotal(order.items || []) + Number(order.deliveryFee || 0);
}

function getEffectiveOrderTotal(order = {}) {
  if (order.adjustedTotal !== '' && order.adjustedTotal != null && !Number.isNaN(Number(order.adjustedTotal))) {
    return Number(order.adjustedTotal);
  }
  if (!Number.isNaN(Number(order.total))) return Number(order.total || 0);
  return getBaseOrderTotal(order);
}

function getOrderDiscountAmount(order = {}) {
  const diff = getBaseOrderTotal(order) - getEffectiveOrderTotal(order);
  return diff > 0.004 ? diff : 0;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function orderRequiresDeposit(order = {}) {
  return getEffectiveOrderTotal(order) > DEPOSIT_THRESHOLD;
}

function getOrderDepositAmount(order = {}) {
  return orderRequiresDeposit(order) ? roundMoney(getEffectiveOrderTotal(order) * DEPOSIT_RATE) : 0;
}

function formatOrderValueForUpdate(key, value) {
  if (key === 'exchangeDate' || key === 'returnDate') return value || 'Not set';
  if (key === 'exchangeTime' || key === 'returnTime') return value || 'To Be Determined';
  if (key === 'deliveryFee' || key === 'total' || key === 'adjustedTotal') return currency(value || 0);
  if (key === 'items') return summarizeOrderItems(value || []);
  if (key === 'verbalConfirmation') return value ? 'Yes' : 'No';
  return value || 'Not set';
}

function collectOrderChanges(previous = {}, next = {}) {
  const fields = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['status', 'Status'],
    ['paymentStatus', 'Payment status'],
    ['fulfillmentType', 'Pickup / Delivery'],
    ['address', 'Address'],
    ['exchangeDate', 'Exchange date'],
    ['exchangeTime', 'Exchange time'],
    ['returnDate', 'Return date'],
    ['returnTime', 'Return time'],
    ['deliveryFee', 'Delivery fee'],
    ['adjustedTotal', 'Adjusted total'],
    ['verbalConfirmation', 'Verbal confirmation'],
    ['items', 'Equipment']
  ];
  const changes = [];
  fields.forEach(([key, label]) => {
    const before = key === 'items' ? JSON.stringify(previous?.[key] || []) : String(previous?.[key] ?? '');
    const after = key === 'items' ? JSON.stringify(next?.[key] || []) : String(next?.[key] ?? '');
    if (before === after) return;
    if (key === 'verbalConfirmation') {
      changes.push(next?.[key] ? 'Verbal confirmation was marked received.' : 'Verbal confirmation was unchecked.');
      return;
    }
    changes.push(`${label} changed from ${formatOrderValueForUpdate(key, previous?.[key])} to ${formatOrderValueForUpdate(key, next?.[key])}.`);
  });
  const beforeTotal = getEffectiveOrderTotal(previous);
  const afterTotal = getEffectiveOrderTotal(next);
  if (Math.abs(beforeTotal - afterTotal) > 0.004) {
    changes.push(`Order total changed from ${currency(beforeTotal)} to ${currency(afterTotal)}.`);
  }
  return changes;
}

function appendOrderUpdate(order, changes = []) {
  if (!Array.isArray(changes) || !changes.length) return order;
  const history = Array.isArray(order.updateHistory) ? order.updateHistory.slice() : [];
  history.push({
    timestamp: new Date().toISOString(),
    changes
  });
  order.updateHistory = history;
  return order;
}

function formatUpdateTimestamp(value) {
  const stamp = new Date(value || '');
  if (Number.isNaN(stamp.getTime())) return 'Update';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(stamp);
}

function buildOrderUpdateMessage(order) {
  const updates = Array.isArray(order?.updateHistory) ? order.updateHistory : [];
  if (!updates.length) return 'Hello! There has been an update to your order!\n\nNo updates have been logged yet.';
  const body = updates.map((entry) => `${formatUpdateTimestamp(entry.timestamp)}\n${(entry.changes || []).map((change) => `• ${change}`).join('\n')}`).join('\n\n');
  return `Hello! There has been an update to your order!\n\n${body}`;
}

function getPendingReminderChecklist(order) {
  const missing = [];
  if (!order.verbalConfirmation) missing.push('Verbally confirm your order with us!');
  if (orderRequiresDeposit(order) && !['Deposit', 'Paid', 'Free'].includes(order.paymentStatus)) {
    missing.push(`Pay deposit of ${currency(getOrderDepositAmount(order))}.`);
  }
  return missing;
}

function getItemEffectiveUnitPrice(item) {
  if (item?.chargedUnitPrice !== '' && item?.chargedUnitPrice != null && !Number.isNaN(Number(item.chargedUnitPrice))) return Number(item.chargedUnitPrice);
  return Number(item?.unitPrice || 0);
}

function calculateAdjustedItemsSubtotal(items = []) {
  return (items || []).reduce((sum, item) => sum + (Number(item.quantity || 0) * getItemEffectiveUnitPrice(item)), 0);
}

function getOrderPricingAdjustmentLabel(order) {
  return (order.items || []).some((item) => Number(getItemEffectiveUnitPrice(item)) !== Number(item.unitPrice || 0))
    ? 'Marked Down'
    : 'Small Discount Just To Say Thanks';
}

function getOrderMarkedDownItems(order = {}) {
  return (order.items || []).filter((item) => Number(getItemEffectiveUnitPrice(item)) < Number(item.unitPrice || 0));
}

function buildReminderDiscountDetails(order = {}) {
  const markedDownItems = getOrderMarkedDownItems(order);
  if (!markedDownItems.length) return '';
  return markedDownItems.map((item) => {
    const original = Number(item.unitPrice || 0);
    const reduced = Number(getItemEffectiveUnitPrice(item));
    const quantity = Number(item.quantity || 0);
    const name = item.name || 'Item';
    const qtyText = quantity > 1 ? ` (x${quantity})` : '';
    return `• ${name}${qtyText}: marked down from ${currency(original)} each to ${currency(reduced)} each`;
  }).join('\n');
}

function syncOrderTotalsPreview() {
  if (!els.orderForm) return;
  const inventoryIds = [...els.orderItemsBox.querySelectorAll('[name="item_inventoryId"]')].map((el) => el.value);
  const quantities = [...els.orderItemsBox.querySelectorAll('[name="item_quantity"]')].map((el) => Number(el.value || 0));
  const customUnitPrices = [...els.orderItemsBox.querySelectorAll('[name="item_customUnitPrice"]')].map((el) => el.value);
  const itemsSubtotal = inventoryIds.reduce((sum, inventoryId, index) => {
    const inv = state.inventory.find((entry) => entry.id === inventoryId);
    if (!inv) return sum;
    const quantity = Number(quantities[index] || 0);
    const customRaw = customUnitPrices[index];
    const unitPrice = customRaw !== '' && customRaw != null ? Number(customRaw || 0) : Number(inv.price || 0);
    return sum + (quantity > 0 ? quantity * unitPrice : 0);
  }, 0);
  const deliveryFee = Number(els.orderForm.elements.deliveryFee?.value || 0);
  const baseTotal = itemsSubtotal + deliveryFee;
  if (els.orderForm.elements.total) {
    els.orderForm.elements.total.value = baseTotal.toFixed(2);
  }
  const adjustedRaw = els.orderForm.elements.adjustedTotal?.value;
  const adjustedHasValue = adjustedRaw !== '' && adjustedRaw != null;
  const adjustedTotal = adjustedHasValue ? Number(adjustedRaw || 0) : baseTotal;
  const discount = Math.max(0, baseTotal - adjustedTotal);
  if (els.orderDiscountPreview) {
    const markdownActive = [...els.orderItemsBox.querySelectorAll('[name="item_customUnitPrice"]')].some((el) => el.value !== '');
    const label = markdownActive ? 'Marked Down' : 'Small Discount Just To Say Thanks';
    els.orderDiscountPreview.textContent = discount > 0
      ? `${label}: -${currency(discount)}`
      : '';
  }
}

function setExchangeAndReturnFromEventDate(force = false) {
  const eventDate = els.orderForm?.elements?.eventDate?.value;
  const exchangeDateField = els.orderForm?.elements?.exchangeDate;
  const returnDateField = els.orderForm?.elements?.returnDate;
  if (!eventDate || !exchangeDateField || !returnDateField) return;
  if (force || exchangeDateField.dataset.userEdited !== 'true') exchangeDateField.value = addDays(eventDate, -1);
  if (force || returnDateField.dataset.userEdited !== 'true') returnDateField.value = addDays(eventDate, 1);
}

function setReturnDateFromExchange(force = false) {
  const exchangeDate = els.orderForm?.elements?.exchangeDate?.value;
  const returnDateField = els.orderForm?.elements?.returnDate;
  if (!exchangeDate || !returnDateField) return;
  if (!force && returnDateField.dataset.userEdited === 'true') return;
  returnDateField.value = addDays(exchangeDate, 1);
}

function applyOrderColumnCollapseState() {
  const columns = {
    pending: els.pendingColumn,
    completed: els.completedColumn
  };
  const rail = els.collapsedColumnsRail;
  const ordersColumns = document.getElementById('ordersColumns');
  if (!ordersColumns) return;

  const confirmedColumn = els.confirmedColumn;
  const insertionMap = {
    pending: () => ordersColumns.insertBefore(columns.pending, confirmedColumn),
    completed: () => ordersColumns.appendChild(columns.completed)
  };

  ['pending', 'completed'].forEach((key) => {
    const column = columns[key];
    if (!column) return;
    const collapsed = Boolean(state.collapsedColumns[key]);
    column.classList.toggle('collapsed', collapsed);
    const btn = column.querySelector('[data-toggle-column]');
    if (btn) btn.textContent = collapsed ? 'Expand' : 'Collapse';
    if (collapsed && rail) {
      rail.appendChild(column);
    } else {
      insertionMap[key]?.();
    }
  });

  if (rail) {
    rail.classList.toggle('has-collapsed-columns', rail.children.length > 0);
  }

  const hasLeftColumn = !state.collapsedColumns.pending;
  const hasRightColumn = !state.collapsedColumns.completed;
  ordersColumns.classList.toggle('has-left-column', hasLeftColumn);
  ordersColumns.classList.toggle('has-right-column', hasRightColumn);
}

function renderOrders() {
  const pending = state.orders.filter((o) => getOrderColumn(o.status) === 'pending').sort(compareExchangeAsc);
  const confirmed = state.orders.filter((o) => getOrderColumn(o.status) === 'confirmed').sort(compareExchangeAsc);
  const completed = state.orders.filter((o) => getOrderColumn(o.status) === 'completed').sort(compareCompletedDesc);

  fillList(els.pendingList, renderOrderGroups(pending, 'pending'), 'No pending orders yet.');
  fillList(els.confirmedList, renderOrderGroups(confirmed, 'confirmed'), 'No confirmed orders yet.');
  fillList(els.completedList, renderOrderGroups(completed, 'completed'), 'No completed orders yet.');

  if (els.pendingTotal) els.pendingTotal.textContent = `Total: ${currency(sumOrderTotals(pending))}`;
  if (els.confirmedTotal) els.confirmedTotal.textContent = `Total: ${currency(sumOrderTotals(confirmed))}`;
  if (els.completedTotal) els.completedTotal.textContent = `Total: ${currency(sumOrderTotals(completed))}`;

  applyOrderColumnCollapseState();
  bindOrderCardActions();
}

function fillList(el, html, emptyText) {
  el.innerHTML = html || `<div class="empty-state">${emptyText}</div>`;
}

function sumOrderTotals(orders = []) {
  return orders.reduce((sum, order) => sum + getEffectiveOrderTotal(order), 0);
}

function renderOrderGroups(orders, mode) {
  if (!orders.length) return '';
  const groups = new Map();
  orders.forEach((order) => {
    const key = mode === 'completed' ? (order.completedAt || 'Completed') : (order.exchangeDate || 'No exchange date');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  });
  return [...groups.entries()].map(([date, groupOrders]) => `
    <div class="order-date-group">
      <div class="order-date-heading">${safeText(formatGroupHeading(date, mode))}</div>
      ${groupOrders.map((order) => renderOrderAccordion(order, mode)).join('')}
    </div>
  `).join('');
}

function formatGroupHeading(date, mode) {
  if (mode === 'completed') {
    const stamp = new Date(date);
    if (Number.isNaN(stamp.getTime())) return 'Completed orders';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).format(stamp);
  }
  const stamp = parseDateTime(date, '12:00');
  if (!stamp || Number.isNaN(stamp.getTime())) return date;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(stamp);
}

function renderOrderAccordion(order, mode) {
  const isOpen = state.expandedOrderId === order.id;
  const itemSummary = summarizeOrderItems(order.items || []);
  const displayName = `${safeText(order.firstName || '')} ${safeText(order.lastName || '')}`.trim() || 'Unnamed order';
  const effectiveTotal = getEffectiveOrderTotal(order);
  const headerTitle = mode === 'completed'
    ? `${displayName} · ${currency(effectiveTotal)}`
    : safeText(itemSummary);
  const headerSub = mode === 'completed'
    ? `${formatDateTime(order.exchangeDate, order.exchangeTime)}${order.completedAt ? ` · completed ${new Date(order.completedAt).toLocaleString()}` : ''}`
    : `${displayName} · ${formatDateTime(order.exchangeDate, order.exchangeTime)}`;
  const itemLines = (order.items || []).map((item) => { const originalSubtotal = Number(item.unitPrice || 0) * Number(item.quantity || 0); const chargedSubtotal = Number(item.subtotal || 0); const markedDown = chargedSubtotal < originalSubtotal; return `<div>${safeText(item.name)} × ${item.quantity} ${markedDown ? `<span class="muted"><s>${currency(originalSubtotal)}</s> → ${currency(chargedSubtotal)}</span>` : `<span class="muted">(${currency(chargedSubtotal)})</span>`}</div>`; }).join('');
  const deliveryLine = Number(order.deliveryFee || 0) > 0 ? `<div><strong>Delivery fee</strong> <span class="muted">(${currency(order.deliveryFee)})</span></div>` : '';
  const discountAmount = getOrderDiscountAmount(order);
  const discountLabel = getOrderPricingAdjustmentLabel(order);
  const discountLine = discountAmount > 0 ? `<div><strong>${safeText(discountLabel)}</strong> <span class="muted">(-${currency(discountAmount)})</span></div>` : '';
  return `
    <div class="order-card order-accordion ${order.status === 'In-Progress' ? 'in-progress' : ''} ${isOpen ? 'open' : ''}">
      <button type="button" class="order-accordion-summary" data-expand-order="${order.id}">
        <div class="order-summary-main">
          <div class="order-summary-title">${headerTitle}</div>
          <div class="order-summary-sub">${headerSub}</div>
          <div>${order.newInquiry ? '<span class="badge badge-blue">New Inquiry</span>' : ''} <span class="badge badge-${order.status === 'Completed' ? 'green' : order.status === 'Pending' ? 'yellow' : 'blue'}">${safeText(order.status)}</span></div>
        </div>
        <div class="order-summary-arrow">⌄</div>
      </button>
      <div class="order-accordion-body">
        <div class="order-meta small" style="padding-top:14px;">
          <div><strong>Total:</strong> ${currency(effectiveTotal)}</div>
          ${orderRequiresDeposit(order) ? `<div><strong>Deposit Required:</strong> ${currency(getOrderDepositAmount(order))}</div>` : ''}
          <div><strong>Verbal Confirmation:</strong> ${order.verbalConfirmation ? 'Yes' : 'No'}</div>
          <div><strong>Payment:</strong> ${safeText(order.paymentStatus)} · <strong>${safeText(order.fulfillmentType || 'To Be Determined')}</strong></div>
          <div><strong>Exchange:</strong> ${formatDateTime(order.exchangeDate, order.exchangeTime || 'To Be Determined')}</div>
          <div><strong>Return:</strong> ${formatDateTime(order.returnDate, order.returnTime || 'To Be Determined')}</div>
          ${order.completedAt ? `<div><strong>Completed:</strong> ${new Date(order.completedAt).toLocaleString()}</div>` : ''}
          ${order.address ? `<div><strong>Address:</strong> ${safeText(order.address)}</div>` : ''}
          <div><strong>Contact:</strong> ${safeText(contactSummary(order.contactMethods))}</div>
        </div>
        <div class="order-items">${itemLines || '<div class="muted">No items</div>'}${deliveryLine}${discountLine}</div>
        <div class="hr"></div>
        <div class="form-row two">
          <div>
            <label>Status</label>
            <select data-status-select="${order.id}">${ORDER_STATUSES.map((status) => `<option ${status === order.status ? 'selected' : ''}>${status}</option>`).join('')}</select>
          </div>
          <div>
            <label>Payment</label>
            <select data-payment-select="${order.id}">${PAYMENT_STATUSES.map((status) => `<option ${status === order.paymentStatus ? 'selected' : ''}>${status}</option>`).join('')}</select>
          </div>
        </div>
        <div class="hr"></div>
        <div class="order-action-row">
          <button class="btn btn-primary btn-small" type="button" data-copy-reminder="${order.id}">Copy reminder</button>
          <button class="btn btn-secondary btn-small" type="button" data-text-reminder="${order.id}">Text reminder</button>
          <button class="btn btn-ghost btn-small" type="button" data-copy-update="${order.id}">Copy update</button>
          ${order.fulfillmentType === 'Delivery' && order.address ? `<button class="btn btn-ghost btn-small" type="button" data-copy-delivery-address="${order.id}">Copy delivery address</button><a class="btn btn-ghost btn-small" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(order.address)}">Open in Google Maps</a>` : ''}
        </div>
        <div class="dot-menu" style="display:flex; justify-content:flex-end;">
          <button class="dot-toggle" type="button" data-menu-toggle="${order.id}" aria-label="Order actions">⋯</button>
          <div class="dot-dropdown hidden" id="menu_${order.id}">
            <button type="button" data-edit-order="${order.id}">Edit</button>
            <button type="button" data-delete-order="${order.id}">Delete</button>
          </div>
        </div>
      </div>
    </div>`;
}

function summarizeOrderItems(items = []) {
  const parts = items.map((item) => `${item.quantity} ${item.name}`);
  return parts.join(', ') || 'No equipment selected';
}

function bindOrderCardActions() {
  if (!state.orderActionDelegatesBound) {
    state.orderActionDelegatesBound = true;
    document.addEventListener('click', (event) => {
      const expandBtn = event.target.closest('[data-expand-order]');
      if (expandBtn) {
        state.expandedOrderId = state.expandedOrderId === expandBtn.dataset.expandOrder ? null : expandBtn.dataset.expandOrder;
        renderOrders();
        return;
      }

      const menuBtn = event.target.closest('[data-menu-toggle]');
      if (menuBtn) {
        event.preventDefault();
        event.stopPropagation();
        const menu = document.getElementById(`menu_${menuBtn.dataset.menuToggle}`);
        document.querySelectorAll('.dot-dropdown').forEach((el) => { if (el !== menu) el.classList.add('hidden'); });
        menu?.classList.toggle('hidden');
        return;
      }

      const editBtn = event.target.closest('[data-edit-order]');
      if (editBtn) {
        event.preventDefault();
        event.stopPropagation();
        openOrderModal(editBtn.dataset.editOrder);
        return;
      }

      const deleteBtn = event.target.closest('[data-delete-order]');
      if (deleteBtn) {
        event.preventDefault();
        event.stopPropagation();
        deleteOrder(deleteBtn.dataset.deleteOrder);
        return;
      }

      const copyReminderBtn = event.target.closest('[data-copy-reminder]');
      if (copyReminderBtn) {
        event.preventDefault();
        copyReminderMessage(copyReminderBtn.dataset.copyReminder);
        return;
      }

      const textReminderBtn = event.target.closest('[data-text-reminder]');
      if (textReminderBtn) {
        event.preventDefault();
        openTextReminder(textReminderBtn.dataset.textReminder);
        return;
      }

      const copyUpdateBtn = event.target.closest('[data-copy-update]');
      if (copyUpdateBtn) {
        event.preventDefault();
        copyUpdateMessage(copyUpdateBtn.dataset.copyUpdate);
        return;
      }

      const copyDeliveryBtn = event.target.closest('[data-copy-delivery-address]');
      if (copyDeliveryBtn) {
        event.preventDefault();
        copyDeliveryAddress(copyDeliveryBtn.dataset.copyDeliveryAddress);
        return;
      }

      if (!event.target.closest('.dot-menu')) {
        document.querySelectorAll('.dot-dropdown').forEach((el) => el.classList.add('hidden'));
      }
    });
  }

  document.querySelectorAll('[data-status-select]').forEach((select) => {
    select.onchange = () => updateOrderStatus(select.dataset.statusSelect, select.value);
  });
  document.querySelectorAll('[data-payment-select]').forEach((select) => {
    select.onchange = () => updateOrderPayment(select.dataset.paymentSelect, select.value);
  });
}


function getOrderById(id) {
  return state.orders.find((item) => item.id === id) || null;
}

function getReminderEquipmentText(order) {
  const items = (order.items || []).map((item) => `${item.name}${Number(item.quantity || 0) > 1 ? ` (x${item.quantity})` : ''}`);
  return items.join(', ') || 'Rental equipment';
}

function getReminderTimingText(order) {
  const target = parseDateTime(order.exchangeDate, order.exchangeTime);
  if (!target || Number.isNaN(target.getTime())) return 'soon';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eventDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const dayDiff = Math.round((eventDay - today) / 86400000);
  if (dayDiff === 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  if (dayDiff > 1) return `in ${dayDiff} days`;
  if (dayDiff === -1) return 'yesterday';
  return `on ${new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(target)}`;
}

function getReminderLocationText(order) {
  if (order.fulfillmentType === 'Delivery') {
    return `delivered to ${order.address || order.addressSnapshot || 'the provided delivery address'}`;
  }
  return `picked up at ${state.settings?.pickupAddress || 'the pickup location on file'}`;
}

function getTextPhoneNumber(order) {
  const raw = order?.contactMethods?.text || '';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  if (digits.length === 10) return `1${digits}`;
  return '';
}

function buildReminderMessage(order) {
  const whenText = getReminderTimingText(order);
  const equipmentText = getReminderEquipmentText(order);
  const eventDate = formatDateTime(order.exchangeDate, order.exchangeTime);
  const locationText = getReminderLocationText(order);
  const discountAmount = getOrderDiscountAmount(order);
  const discountLabel = getOrderPricingAdjustmentLabel(order);
  const discountDetails = buildReminderDiscountDetails(order);
  const baseTotal = getBaseOrderTotal(order);
  const finalTotal = getEffectiveOrderTotal(order);
  const totalLines = discountAmount > 0
    ? `• Total: ${currency(baseTotal)}
• Discount: ${discountLabel} -${currency(discountAmount)}${discountDetails ? `
${discountDetails}` : ''}
• Actual Total: ${currency(finalTotal)}`
    : `• Total: ${currency(finalTotal)}`;
  const depositLine = orderRequiresDeposit(order) ? `\n• Deposit Required: ${currency(getOrderDepositAmount(order))}` : '';

  if (order.status === 'Pending') {
    const missing = getPendingReminderChecklist(order);
    const checklist = missing.length
      ? missing.map((item) => `• ${item}`).join('\n')
      : '• Final review from our team.';
    return `Hello! This is a friendly reminder of your upcoming rental ${whenText} (${eventDate}).\n\nOrder Details:\n• Equipment: ${equipmentText}\n• Method: ${order.fulfillmentType || 'Pickup'}\n• Location: ${locationText.replace(/^(picked up at|delivered to)\s+/i, '')}\n\n${totalLines}${depositLine}\n• Payment Status: ${order.paymentStatus || 'Un-Paid'}\n\nThis order is still pending and equipment is not guaranteed until the following items are addressed:\n${checklist}`;
  }

  return `Hello! This is a friendly reminder of your upcoming rental ${whenText} (${eventDate}).\n\nOrder Details:\n• Equipment: ${equipmentText}\n• Method: ${order.fulfillmentType || 'Pickup'}\n• Location: ${locationText.replace(/^(picked up at|delivered to)\s+/i, '')}\n\n${totalLines}${depositLine}\n• Payment Status: ${order.paymentStatus || 'Un-Paid'}\n\nIf anything has changed or you need to make adjustments, please let us know. Otherwise, we look forward to taking care of your order ${whenText}!`;
}

function buildPickupAddressMessage() {
  const pickupAddress = state.settings?.pickupAddress || 'the pickup address on file';
  return `Here is the pickup address! ${pickupAddress}. You can use this to help you make a decision between pickup or delivery.`;
}

async function copyReminderMessage(id) {
  const order = getOrderById(id);
  if (!order) return;
  const message = buildReminderMessage(order);
  try {
    await navigator.clipboard.writeText(message);
    alert('Reminder copied to clipboard.');
  } catch (error) {
    window.prompt('Copy your reminder message below:', message);
  }
}

async function copyUpdateMessage(id) {
  const order = getOrderById(id);
  if (!order) return;
  const message = buildOrderUpdateMessage(order);
  try {
    await navigator.clipboard.writeText(message);
    alert('Update copied to clipboard.');
  } catch (error) {
    window.prompt('Copy your update message below:', message);
  }
}

async function copyDeliveryAddress(id) {
  const order = getOrderById(id);
  if (!order?.address) return;
  try {
    await navigator.clipboard.writeText(order.address);
    alert('Delivery address copied to clipboard.');
  } catch (error) {
    window.prompt('Copy the delivery address below:', order.address);
  }
}

async function copyPickupAddressMessage() {
  const message = buildPickupAddressMessage();
  try {
    await navigator.clipboard.writeText(message);
    alert('Pickup address copied to clipboard.');
  } catch (error) {
    window.prompt('Copy the pickup address message below:', message);
  }
}

function openTextReminder(id) {
  const order = getOrderById(id);
  if (!order) return;
  const phone = getTextPhoneNumber(order);
  if (!phone) {
    alert('This order does not have a text phone number saved yet.');
    return;
  }
  const message = buildReminderMessage(order);
  const url = `sms:${phone}?&body=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

async function updateOrderStatus(id, status) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return;
  const before = JSON.parse(JSON.stringify(order));
  order.status = status;
  order.newInquiry = false;
  order.updatedAt = new Date().toISOString();
  if (status === 'Completed' && !order.completedAt) order.completedAt = new Date().toISOString();
  if (status !== 'Completed') order.completedAt = '';
  appendOrderUpdate(order, collectOrderChanges(before, order));
  await saveAndRefresh('admin-status');
}

async function updateOrderPayment(id, paymentStatus) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return;
  const before = JSON.parse(JSON.stringify(order));
  order.paymentStatus = paymentStatus;
  order.updatedAt = new Date().toISOString();
  appendOrderUpdate(order, collectOrderChanges(before, order));
  await saveAndRefresh('admin-status');
}

async function deleteOrder(id) {
  const order = state.orders.find((item) => item.id === id);
  if (!order) return;
  if (!window.confirm(`Delete order for ${`${order.firstName || ''} ${order.lastName || ''}`.trim() || 'this order'}?`)) return;
  state.orders = state.orders.filter((item) => item.id !== id);
  if (state.expandedOrderId === id) state.expandedOrderId = null;
  await saveAndRefresh('admin-status');
}

function renderInventory() {
  const html = state.inventory.map((item) => {
    const stats = inventoryAvailabilityStats(item.id);
    return `
      <div class="inventory-card">
        <div class="inventory-head">
          <div class="item-qty-row">
            <img class="inventory-image" src="${getInventoryImageSrc(item)}" alt="${safeText(item.name)}" />
            <div class="stack-sm">
              <strong>${safeText(item.name)}</strong>
              <span class="muted small">${safeText(item.category)}</span>
              <span class="small">${safeText(item.description || '')}</span>
            </div>
            <div class="stack-sm">
              <button class="btn btn-ghost btn-small" data-edit-inventory="${item.id}">Edit</button>
              <button class="btn btn-ghost btn-small" data-delete-inventory="${item.id}">Delete</button>
            </div>
          </div>
        </div>
        <div class="hr"></div>
        <div class="small kv">
          <div class="kv-row"><span>Price</span><strong>${currency(item.price)}</strong></div>
          <div class="kv-row"><span>Accessories</span><strong>${normalizeAccessories(item.accessories).length || 0}</strong></div>
          <div class="kv-row"><span>Total in stock</span><strong>${item.stock}</strong></div>
          <div class="kv-row"><span>Out right now</span><strong>${stats.outNow}</strong></div>
          <div class="kv-row"><span>Available right now</span><strong>${stats.availableNow}</strong></div>
          <div class="kv-row"><span>Pending today</span><strong>${stats.pendingToday}</strong></div>
        </div>
      </div>`;
  }).join('');
  els.inventoryList.innerHTML = html || '<div class="empty-state">No inventory added yet.</div>';
  const categories = getCategories();
  els.inventoryStats.innerHTML = `<span class="badge badge-blue">${state.inventory.length} items</span> <span class="badge badge-green">${categories.length} categories</span>`;
  document.querySelectorAll('[data-edit-inventory]').forEach((btn) => btn.addEventListener('click', () => openInventoryModal(btn.dataset.editInventory)));
  document.querySelectorAll('[data-delete-inventory]').forEach((btn) => btn.addEventListener('click', () => deleteInventory(btn.dataset.deleteInventory)));
}

function inventoryAvailabilityStats(inventoryId) {
  const now = new Date();
  let outNow = 0;
  let pendingToday = 0;
  for (const order of state.orders) {
    const start = parseDateTime(order.exchangeDate, order.exchangeTime);
    const end = parseDateTime(order.returnDate, order.returnTime);
    const qty = order.items.filter((item) => item.inventoryId === inventoryId).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    if (!qty) continue;
    if ((order.status === 'Confirmed' || order.status === 'In-Progress') && overlaps(start, end, now, new Date(now.getTime() + 1))) outNow += qty;
    if (order.status === 'Pending' && order.exchangeDate <= addDays(new Date().toISOString().slice(0, 10), 0) && order.returnDate >= new Date().toISOString().slice(0, 10)) pendingToday += qty;
  }
  const item = state.inventory.find((entry) => entry.id === inventoryId);
  return {
    outNow,
    availableNow: Math.max(0, Number(item?.stock || 0) - outNow),
    pendingToday
  };
}

async function deleteInventory(id) {
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item) return;
  if (!window.confirm(`Delete inventory item ${item.name}?`)) return;
  state.inventory = state.inventory.filter((entry) => entry.id !== id);
  await saveAndRefresh('admin-status');
}

function renderSettings() {
  const settings = state.settings;
  ['businessName', 'pickupName', 'pickupAddress', 'deliveryRatePerMile', 'notificationEmail', 'notificationFromName', 'emailjsPublicKey', 'emailjsServiceId', 'emailjsTemplateId', 'googleMapsApiKey'].forEach((field) => {
    const input = els.settingsForm.elements[field];
    if (input) input.value = settings[field] ?? '';
  });
  const emailToggle = els.settingsForm.elements.emailNotificationsEnabled;
  if (emailToggle) emailToggle.checked = Boolean(settings.emailNotificationsEnabled);
  if (els.pickupLookupStatus) {
    const coords = settings.pickupCoords;
    els.pickupLookupStatus.textContent = coords?.lat != null && coords?.lon != null
      ? `Saved pickup coordinates: ${Number(coords.lat).toFixed(5)}, ${Number(coords.lon).toFixed(5)}`
      : 'Save a valid pickup address to store coordinates for delivery quotes.';
  }
}

async function handleSettingsSave(event) {
  event.preventDefault();
  const form = new FormData(els.settingsForm);
  const pickupAddress = (form.get('pickupAddress') || '').trim();
  const nextSettings = {
    businessName: (form.get('businessName') || '').trim(),
    pickupName: (form.get('pickupName') || '').trim(),
    pickupAddress,
    deliveryRatePerMile: Number(form.get('deliveryRatePerMile') || 0),
    notificationEmail: (form.get('notificationEmail') || '').trim(),
    notificationFromName: (form.get('notificationFromName') || '').trim(),
    emailNotificationsEnabled: Boolean(form.get('emailNotificationsEnabled')),
    emailjsPublicKey: (form.get('emailjsPublicKey') || '').trim(),
    emailjsServiceId: (form.get('emailjsServiceId') || '').trim(),
    emailjsTemplateId: (form.get('emailjsTemplateId') || '').trim(),
    googleMapsApiKey: (form.get('googleMapsApiKey') || '').trim(),
    pickupCoords: null,
    pickupGeocodedAddress: '',
    pickupGeocodeUpdatedAt: ''
  };

  if (pickupAddress) {
    try {
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = 'Geocoding pickup address…';
      const geocoded = await geocodeAddress(pickupAddress, { origin: state.settings?.pickupCoords || null, context: nextSettings });
      if (geocoded) {
        nextSettings.pickupCoords = { lat: geocoded.lat, lon: geocoded.lon };
        nextSettings.pickupGeocodedAddress = geocoded.label;
        nextSettings.pickupGeocodeUpdatedAt = new Date().toISOString();
      }
    } catch (error) {
      if (els.pickupLookupStatus) els.pickupLookupStatus.textContent = 'Could not geocode the pickup address. Saving the typed address only.';
    }
  }

  state.settings = nextSettings;
  await saveSettings(state.settings);
  renderSettings();
  els.settingsSaved.textContent = state.settings.pickupCoords ? 'Settings saved.' : 'Settings saved (without pickup coordinates).';
  setTimeout(() => { els.settingsSaved.textContent = ''; }, 1800);
}

function openOrderModal(orderId = null) {
  state.editingOrderId = orderId;
  els.orderModalTitle.textContent = orderId ? 'Edit Order' : 'Add Order';
  const order = state.orders.find((item) => item.id === orderId);
  resetOrderForm(order);
  els.orderModalWrap.classList.add('open');
}

function resetOrderForm(order) {
  els.orderForm.reset();
  ['exchangeDate','returnDate'].forEach((name) => { if (els.orderForm.elements[name]) els.orderForm.elements[name].dataset.userEdited = ''; });
  const now = new Date();
  const defaultDate = now.toISOString().slice(0, 10);
  const values = order || {
    firstName: '', lastName: '', status: 'Pending', paymentStatus: 'Un-Paid', fulfillmentType: 'Pickup', verbalConfirmation: false,
    exchangeDate: defaultDate, exchangeTime: '10:00', returnDate: addDays(defaultDate, 1), returnTime: '17:00',
    total: 0, adjustedTotal: '', eventDate: '', eventTime: '', eventName: '', address: '', deliveryMiles: 0, deliveryFee: 0, notes: ''
  };
  Object.keys(values).forEach((key) => {
    const field = els.orderForm.elements[key];
    if (field) field.value = values[key] ?? '';
  });
  if (els.orderForm.elements.adjustedTotal) {
    els.orderForm.elements.adjustedTotal.value = order?.adjustedTotal ?? '';
  }
  if (els.orderForm.elements.eventDate) els.orderForm.elements.eventDate.value = order?.eventDate || '';
  if (els.orderForm.elements.eventTime) els.orderForm.elements.eventTime.value = order?.eventTime || '';
  if (els.orderForm.elements.eventName) els.orderForm.elements.eventName.value = order?.eventName || '';
  if (els.orderForm.elements.returnDate) {
    els.orderForm.elements.returnDate.dataset.userEdited = order ? 'true' : 'false';
  }
  setReturnDateFromExchange(!order);
  const selectedMethods = order ? Object.keys(order.contactMethods || {}) : ['text'];
  renderContactMethodInputs(selectedMethods, order?.contactMethods || {});
  renderOrderItemInputs(order?.items || []);
  if (!order) setExchangeAndReturnFromEventDate(true);
  syncOrderTotalsPreview();
}

function renderContactMethodInputs(selectedMethods = [], values = {}) {
  const pickWrap = document.getElementById('contactMethodChecks');
  const inputWrap = document.getElementById('contactMethodInputs');
  pickWrap.innerHTML = CONTACT_METHODS.map((method) => `
    <label class="check-pill"><input type="checkbox" data-contact-check value="${method.key}" ${selectedMethods.includes(method.key) ? 'checked' : ''}/> ${method.label}</label>
  `).join('');
  function paintInputs() {
    const active = [...pickWrap.querySelectorAll('[data-contact-check]:checked')].map((input) => input.value);
    inputWrap.innerHTML = active.map((key) => {
      const method = CONTACT_METHODS.find((entry) => entry.key === key);
      return `<div class="form-row"><label>${method.label}</label><input name="contact_${key}" placeholder="${method.placeholder}" value="${safeText(values[key] || '')}" /></div>`;
    }).join('');
  }
  pickWrap.querySelectorAll('[data-contact-check]').forEach((input) => input.addEventListener('change', paintInputs));
  paintInputs();
}

function renderOrderItemInputs(items = []) {
  const options = state.inventory.map((item) => `<option value="${item.id}">${safeText(item.name)} (${safeText(item.category)}) - ${currency(item.price)}</option>`).join('');
  const rows = items.length ? items : [{ inventoryId: state.inventory[0]?.id || '', quantity: 1, customUnitPrice: '' }];
  els.orderItemsBox.innerHTML = rows.map((item) => renderOrderItemRow(item, options)).join('');
  bindOrderItemRowEvents();
}

function renderOrderItemRow(item, options) {
  return `
    <div class="card" style="padding:12px; margin-bottom:10px;">
      <div class="form-row three">
        <div><label>Inventory item</label><select name="item_inventoryId">${options.replace(`value="${item.inventoryId}"`, `value="${item.inventoryId}" selected`)}</select></div>
        <div><label>Quantity</label><input type="number" min="1" name="item_quantity" value="${item.quantity || 1}" /></div>
        <div><label>Charge Per Unit</label><input type="number" step="0.01" min="0" name="item_customUnitPrice" value="${item.customUnitPrice ?? ''}" placeholder="Default" /></div>
      </div>
      <div style="margin-top:10px;"><button type="button" class="btn btn-ghost btn-small" data-remove-item-row>Remove Item</button></div>
    </div>`;
}

function bindOrderItemRowEvents() {
  document.getElementById('addOrderItemRow').onclick = () => {
    const options = state.inventory.map((item) => `<option value="${item.id}">${safeText(item.name)} (${safeText(item.category)}) - ${currency(item.price)}</option>`).join('');
    els.orderItemsBox.insertAdjacentHTML('beforeend', renderOrderItemRow({ inventoryId: state.inventory[0]?.id || '', quantity: 1, customUnitPrice: '' }, options));
    bindOrderItemRowEvents();
    syncOrderTotalsPreview();
  };
  els.orderItemsBox.querySelectorAll('[data-remove-item-row]').forEach((btn) => btn.onclick = () => {
    btn.closest('.card').remove();
    syncOrderTotalsPreview();
  });
  els.orderItemsBox.querySelectorAll('[name="item_inventoryId"], [name="item_quantity"], [name="item_customUnitPrice"]').forEach((input) => {
    input.oninput = syncOrderTotalsPreview;
    input.onchange = syncOrderTotalsPreview;
  });
}

async function handleOrderSave(event) {
  event.preventDefault();
  const form = new FormData(els.orderForm);
  const contactChecks = [...document.querySelectorAll('[data-contact-check]:checked')].map((input) => input.value);
  const contactValues = Object.fromEntries(contactChecks.map((key) => [key, form.get(`contact_${key}`) || '']));
  const inventoryIds = [...els.orderItemsBox.querySelectorAll('[name="item_inventoryId"]')].map((el) => el.value);
  const quantities = [...els.orderItemsBox.querySelectorAll('[name="item_quantity"]')].map((el) => Number(el.value || 0));
  const customUnitPrices = [...els.orderItemsBox.querySelectorAll('[name="item_customUnitPrice"]')].map((el) => el.value);
  const items = inventoryIds.map((inventoryId, index) => {
    const inv = state.inventory.find((entry) => entry.id === inventoryId);
    if (!inv) return null;
    const quantity = Number(quantities[index] || 0);
    const customRaw = customUnitPrices[index];
    const chargedUnitPrice = customRaw !== '' && customRaw != null ? Number(customRaw || 0) : '';
    const effectiveUnitPrice = chargedUnitPrice === '' ? Number(inv.price || 0) : chargedUnitPrice;
    return {
      inventoryId,
      name: inv.name,
      category: inv.category,
      imageUrl: inv.imageUrl,
      imageData: inv.imageData || '',
      unitPrice: Number(inv.price || 0),
      chargedUnitPrice,
      quantity,
      subtotal: quantity * effectiveUnitPrice
    };
  }).filter(Boolean).filter((item) => item.quantity > 0);
  const deliveryFee = Number(form.get('deliveryFee') || 0);
  const itemsSubtotal = calculateOrderItemsSubtotal(items);
  const baseTotal = itemsSubtotal + deliveryFee;
  const adjustedRaw = form.get('adjustedTotal');
  const adjustedTotal = adjustedRaw !== '' && adjustedRaw != null ? Number(adjustedRaw || 0) : '';
  const finalTotal = adjustedTotal === '' ? baseTotal : adjustedTotal;
  const existingOrder = state.orders.find((entry) => entry.id === state.editingOrderId) || null;
  const order = {
    id: state.editingOrderId || uid('ord'),
    firstName: String(form.get('firstName') || '').trim(),
    lastName: String(form.get('lastName') || '').trim(),
    eventDate: form.get('eventDate') || '',
    eventTime: form.get('eventTime') || '',
    eventName: String(form.get('eventName') || '').trim(),
    status: form.get('status'),
    paymentStatus: form.get('paymentStatus'),
    fulfillmentType: form.get('fulfillmentType'),
    verbalConfirmation: Boolean(form.get('verbalConfirmation')),
    address: form.get('address').trim(),
    exchangeDate: form.get('exchangeDate'),
    exchangeTime: form.get('exchangeTime'),
    returnDate: form.get('returnDate'),
    returnTime: form.get('returnTime'),
    deliveryMiles: Number(form.get('deliveryMiles') || 0),
    deliveryFee,
    baseTotal,
    adjustedTotal,
    total: finalTotal,
    requiresDeposit: finalTotal > DEPOSIT_THRESHOLD,
    depositAmount: finalTotal > DEPOSIT_THRESHOLD ? roundMoney(finalTotal * DEPOSIT_RATE) : 0,
    items,
    contactMethods: buildContactMap(contactChecks, contactValues),
    updatedAt: new Date().toISOString(),
    createdAt: existingOrder?.createdAt || new Date().toISOString(),
    completedAt: form.get('status') === 'Completed' ? (existingOrder?.completedAt || new Date().toISOString()) : '',
    newInquiry: false,
    source: existingOrder?.source || 'admin',
    updateHistory: Array.isArray(existingOrder?.updateHistory) ? existingOrder.updateHistory.slice() : []
  };
  if (existingOrder) {
    appendOrderUpdate(order, collectOrderChanges(existingOrder, order));
    state.orders = state.orders.map((entry) => entry.id === state.editingOrderId ? order : entry);
  } else {
    state.orders.unshift(order);
  }
  await saveOrders(state.orders, { actor: 'admin-edit' });
  closeModals();
  await loadData();
  renderOrders();
}

function openInventoryModal(id = null) {
  state.editingInventoryId = id;
  els.inventoryModalTitle.textContent = id ? 'Edit Inventory Item' : 'Add Inventory Item';
  const item = state.inventory.find((entry) => entry.id === id);
  els.inventoryForm.reset();
  els.categorySuggestions.innerHTML = getCategories().map((category) => `<option value="${safeText(category)}"></option>`).join('');
  if (item) {
    ['category', 'name', 'description', 'price', 'stock'].forEach((key) => {
      const field = els.inventoryForm.elements[key];
      if (field) field.value = item[key] ?? '';
    });
    if (els.imageData) els.imageData.value = item.imageData || '';
    document.getElementById('inventoryPreview').src = item.imageData || item.imageUrl || '';
    renderAccessoryRows(item.accessories || []);
  } else {
    if (els.imageData) els.imageData.value = '';
    document.getElementById('inventoryPreview').src = '';
    renderAccessoryRows([]);
  }
  document.getElementById('inventoryPreview').hidden = !document.getElementById('inventoryPreview').src;
  els.inventoryModalWrap.classList.add('open');
}

async function handleInventorySave(event) {
  event.preventDefault();
  const form = new FormData(els.inventoryForm);
  const existing = state.inventory.find((entry) => entry.id === state.editingInventoryId);
  const uploadedImageData = (form.get('imageData') || '').toString().trim();
  let imageUrl = existing?.imageUrl || '';
  const item = {
    id: state.editingInventoryId || uid('inv'),
    category: normalizeCategory(form.get('category')),
    name: form.get('name').trim(),
    description: form.get('description').trim(),
    imageUrl,
    imageData: uploadedImageData || existing?.imageData || '',
    accessories: collectAccessoriesFromForm(),
    price: Number(form.get('price') || 0),
    stock: Number(form.get('stock') || 0),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (state.editingInventoryId) {
    state.inventory = state.inventory.map((entry) => entry.id === item.id ? item : entry);
  } else {
    state.inventory.unshift(item);
  }
  await saveInventory(state.inventory);
  closeModals();
  await loadData();
  renderInventory();
}


async function handleBackupExport() {
  const payload = await exportOrdersBackup();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `rent-some-orders-backup-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setBackupStatus('Backup downloaded.');
}

async function handleCreateSnapshot() {
  await createOrderSnapshot('Admin manual snapshot');
  setBackupStatus('Snapshot saved.');
}

async function handleBackupImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!window.confirm('Import this backup? This will replace current orders, inventory, and settings.')) {
    event.target.value = '';
    return;
  }
  const payload = JSON.parse(await file.text());
  await importOrdersBackup(payload);
  await loadData();
  renderAll();
  setBackupStatus('Backup imported.');
  event.target.value = '';
}

function setBackupStatus(message) {
  if (!els.backupStatus) return;
  els.backupStatus.textContent = message;
  setTimeout(() => { if (els.backupStatus.textContent === message) els.backupStatus.textContent = ''; }, 2200);
}

function handleFatalError(error) {
  console.error(error);
  const target = document.getElementById('loginError') || document.body;
  if (target) target.textContent = error?.message || 'Something went wrong.';
}

function closeModals() {
  els.orderModalWrap.classList.remove('open');
  els.inventoryModalWrap.classList.remove('open');
  if (els.inventoryForm) els.inventoryForm.reset();
  if (els.imageData) els.imageData.value = '';
  const preview = document.getElementById('inventoryPreview');
  if (preview) {
    preview.src = '';
    preview.hidden = true;
  }
  renderAccessoryRows([]);
}
