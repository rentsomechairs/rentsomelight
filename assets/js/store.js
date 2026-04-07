import { APP_CONFIG } from './config.js';
import { uid } from './utils.js';
import { deleteDocById, firebaseLogin, firebaseLogout, getCurrentFirebaseUser, isFirebaseEnabled, listCollection, upsertDoc, uploadFile, waitForAuthReady } from './firebase-service.js';

const STORAGE_KEYS = {
  session: 'rso_session_v2',
  inventory: 'rso_inventory_v2',
  orders: 'rso_orders_v2',
  settings: 'rso_settings_v2',
  audit: 'rso_order_audit_v2',
  snapshots: 'rso_order_snapshots_v2'
};

const COLLECTIONS = {
  inventory: 'inventory',
  orders: 'orders',
  settings: 'settings',
  audit: 'orderAuditLog',
  snapshots: 'orderSnapshots'
};

const defaultSettings = {
  businessName: 'Rent Some Chairs',
  pickupName: 'Rent Some Chairs Pickup',
  pickupAddress: '123 Example St, Garner, NC 27529',
  deliveryRatePerMile: 2,
  notificationEmail: 'you@example.com',
  emailNotificationsEnabled: false,
  emailjsPublicKey: '',
  emailjsServiceId: '',
  emailjsTemplateId: '',
  googleMapsApiKey: '',
  notificationFromName: 'Rent Some Orders',
  pickupCoords: null,
  pickupGeocodedAddress: '',
  pickupGeocodeUpdatedAt: ''
};

const placeholderSvg = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop stop-color="#dbeafe" />
      <stop offset="1" stop-color="#e2e8f0" />
    </linearGradient>
  </defs>
  <rect width="600" height="400" fill="url(#g)" />
  <circle cx="100" cy="80" r="44" fill="#bfdbfe" />
  <rect x="120" y="130" width="350" height="110" rx="18" fill="#ffffff" opacity="0.9" />
  <rect x="150" y="160" width="190" height="20" rx="10" fill="#93c5fd" />
  <rect x="150" y="196" width="130" height="18" rx="9" fill="#cbd5e1" />
  <rect x="390" y="140" width="110" height="90" rx="14" fill="#dbeafe" />
</svg>
`)}`;

const seedInventory = [
  {
    id: uid('inv'),
    category: 'Chairs',
    name: 'White Folding Chair',
    description: 'Simple white folding chair for parties and events.',
    imageUrl: placeholderSvg,
    price: 2.5,
    stock: 120,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: uid('inv'),
    category: 'Tables',
    name: '6 Foot Banquet Table',
    description: 'Standard rectangular event table.',
    imageUrl: placeholderSvg,
    price: 10,
    stock: 12,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: uid('inv'),
    category: 'Linens',
    name: 'Black Fitted Table Cover',
    description: 'Stretch fitted black cover for 6 foot table.',
    imageUrl: placeholderSvg,
    price: 7,
    stock: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const seedOrders = [
  {
    id: uid('ord'),
    firstName: 'Sample',
    lastName: 'Customer',
    status: 'Confirmed',
    paymentStatus: 'Un-Paid',
    fulfillmentType: 'Pickup',
    exchangeDate: futureDate(1),
    exchangeTime: '10:00',
    returnDate: futureDate(2),
    returnTime: '17:00',
    total: 55,
    subtotal: 55,
    deliveryFee: 0,
    deliveryMiles: 0,
    address: '',
    contactMethods: { text: '(555) 111-2222' },
    items: [
      { inventoryId: seedInventory[0].id, name: 'White Folding Chair', category: 'Chairs', imageUrl: seedInventory[0].imageUrl, unitPrice: 2.5, quantity: 10, subtotal: 25 },
      { inventoryId: seedInventory[1].id, name: '6 Foot Banquet Table', category: 'Tables', imageUrl: seedInventory[1].imageUrl, unitPrice: 10, quantity: 3, subtotal: 30 }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    newInquiry: false,
    source: 'admin'
  }
];

let cacheInventory = [];
let cacheOrders = [];
let cacheSettings = { ...defaultSettings };
let cacheAudit = [];
let cacheSnapshots = [];
let localSeeded = false;

function futureDate(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function read(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function appendLocal(key, value) {
  const current = read(key, []);
  current.unshift(value);
  write(key, current);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hydrateCachesFromLocal() {
  ensureSeedData();
  cacheInventory = read(STORAGE_KEYS.inventory, []);
  cacheOrders = read(STORAGE_KEYS.orders, []);
  cacheSettings = read(STORAGE_KEYS.settings, defaultSettings);
  cacheAudit = read(STORAGE_KEYS.audit, []);
  cacheSnapshots = read(STORAGE_KEYS.snapshots, []);
}

export function ensureSeedData() {
  if (localSeeded) return;
  if (!read(STORAGE_KEYS.inventory, null)) write(STORAGE_KEYS.inventory, seedInventory);
  if (!read(STORAGE_KEYS.orders, null)) write(STORAGE_KEYS.orders, seedOrders);
  if (!read(STORAGE_KEYS.settings, null)) write(STORAGE_KEYS.settings, defaultSettings);
  if (!read(STORAGE_KEYS.audit, null)) write(STORAGE_KEYS.audit, []);
  if (!read(STORAGE_KEYS.snapshots, null)) write(STORAGE_KEYS.snapshots, []);
  localSeeded = true;
}

export async function getInventory() {
  if (!isFirebaseEnabled()) {
    hydrateCachesFromLocal();
    return clone(cacheInventory);
  }
  const items = await listCollection(COLLECTIONS.inventory);
  cacheInventory = items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return clone(cacheInventory);
}

export async function saveInventory(items) {
  cacheInventory = clone(items);
  if (!isFirebaseEnabled()) {
    write(STORAGE_KEYS.inventory, cacheInventory);
    return;
  }
  const current = await listCollection(COLLECTIONS.inventory);
  const currentIds = new Set(current.map((item) => item.id));
  const nextIds = new Set(cacheInventory.map((item) => item.id));
  for (const item of cacheInventory) await upsertDoc(COLLECTIONS.inventory, item.id, item);
  for (const id of currentIds) if (!nextIds.has(id)) await deleteDocById(COLLECTIONS.inventory, id);
}

export async function getOrders() {
  if (!isFirebaseEnabled()) {
    hydrateCachesFromLocal();
    return clone(cacheOrders);
  }
  const items = await listCollection(COLLECTIONS.orders);
  cacheOrders = items;
  return clone(cacheOrders);
}

function summarizeOrderForLog(order = {}) {
  return {
    status: order.status || '',
    total: Number(order.total || 0),
    fulfillmentType: order.fulfillmentType || '',
    firstName: order.firstName || '',
    lastName: order.lastName || ''
  };
}

async function appendAuditLog(entry) {
  const payload = {
    id: uid('audit'),
    timestamp: new Date().toISOString(),
    ...entry
  };
  cacheAudit.unshift(payload);
  if (!isFirebaseEnabled()) {
    appendLocal(STORAGE_KEYS.audit, payload);
    return;
  }
  await upsertDoc(COLLECTIONS.audit, payload.id, payload);
}

export async function saveOrders(orders, meta = { actor: 'app' }) {
  cacheOrders = clone(orders);
  if (!isFirebaseEnabled()) {
    const previous = read(STORAGE_KEYS.orders, []);
    write(STORAGE_KEYS.orders, cacheOrders);
    await auditDiff(previous, cacheOrders, meta);
    return;
  }
  const previous = await listCollection(COLLECTIONS.orders);
  const previousIds = new Set(previous.map((item) => item.id));
  const nextIds = new Set(cacheOrders.map((item) => item.id));
  for (const item of cacheOrders) await upsertDoc(COLLECTIONS.orders, item.id, item);
  for (const id of previousIds) if (!nextIds.has(id)) await deleteDocById(COLLECTIONS.orders, id);
  await auditDiff(previous, cacheOrders, meta);
}

async function auditDiff(previous, next, meta) {
  const previousMap = new Map(previous.map((item) => [item.id, item]));
  const nextMap = new Map(next.map((item) => [item.id, item]));

  for (const [id, order] of nextMap.entries()) {
    const old = previousMap.get(id);
    if (!old) {
      await appendAuditLog({ action: 'created', orderId: id, actor: meta.actor, summary: summarizeOrderForLog(order), orderSnapshot: order });
      continue;
    }
    if (JSON.stringify(old) !== JSON.stringify(order)) {
      await appendAuditLog({ action: 'updated', orderId: id, actor: meta.actor, summary: summarizeOrderForLog(order), orderSnapshot: order, previousSnapshot: old });
    }
  }

  for (const [id, order] of previousMap.entries()) {
    if (!nextMap.has(id)) {
      await appendAuditLog({ action: 'deleted', orderId: id, actor: meta.actor, summary: summarizeOrderForLog(order), previousSnapshot: order });
    }
  }
}

export async function getSettings() {
  if (!isFirebaseEnabled()) {
    hydrateCachesFromLocal();
    return clone(cacheSettings);
  }
  const docs = await listCollection(COLLECTIONS.settings);
  const appDoc = docs.find((item) => item.id === 'app');
  cacheSettings = { ...defaultSettings, ...(appDoc || {}) };
  return clone(cacheSettings);
}

export async function saveSettings(settings) {
  cacheSettings = { ...defaultSettings, ...clone(settings), id: 'app' };
  if (!isFirebaseEnabled()) {
    write(STORAGE_KEYS.settings, cacheSettings);
    return;
  }
  await upsertDoc(COLLECTIONS.settings, 'app', cacheSettings);
}

export function getCategories() {
  const set = new Set((cacheInventory || []).map((item) => item.category).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function loginAdmin(email, password) {
  if (isFirebaseEnabled()) {
    await firebaseLogin(email.trim(), password);
    return true;
  }
  const match = email.trim().toLowerCase() === APP_CONFIG.demoAdmin.email.toLowerCase()
    && password === APP_CONFIG.demoAdmin.password;
  if (!match) throw new Error('Invalid login.');
  write(STORAGE_KEYS.session, { email: APP_CONFIG.demoAdmin.email, loggedInAt: new Date().toISOString() });
  return true;
}

export async function logoutAdmin() {
  if (isFirebaseEnabled()) {
    await firebaseLogout();
    return;
  }
  localStorage.removeItem(STORAGE_KEYS.session);
}

export async function getSession() {
  if (isFirebaseEnabled()) {
    const user = await waitForAuthReady().then(() => getCurrentFirebaseUser());
    return user ? { email: user.email || '', uid: user.uid, firebase: true } : null;
  }
  return read(STORAGE_KEYS.session, null);
}

export async function uploadInventoryImage(file, itemId) {
  if (!file) return '';
  if (!isFirebaseEnabled()) return '';
  const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const path = `inventory/${itemId}-${Date.now()}.${ext || 'jpg'}`;
  return uploadFile(path, file);
}

export async function exportOrdersBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    appName: APP_CONFIG.appName,
    mode: isFirebaseEnabled() ? 'firebase' : 'local',
    settings: await getSettings(),
    inventory: await getInventory(),
    orders: await getOrders(),
    auditLog: isFirebaseEnabled() ? await listCollection(COLLECTIONS.audit) : read(STORAGE_KEYS.audit, []),
    snapshots: isFirebaseEnabled() ? await listCollection(COLLECTIONS.snapshots) : read(STORAGE_KEYS.snapshots, [])
  };
  return payload;
}

export async function createOrderSnapshot(label = 'Manual snapshot') {
  const payload = {
    id: uid('snapshot'),
    label,
    createdAt: new Date().toISOString(),
    orders: await getOrders()
  };
  cacheSnapshots.unshift(payload);
  if (!isFirebaseEnabled()) {
    appendLocal(STORAGE_KEYS.snapshots, payload);
  } else {
    await upsertDoc(COLLECTIONS.snapshots, payload.id, payload);
  }
  return payload;
}

export async function importOrdersBackup(payload) {
  if (!payload || !Array.isArray(payload.orders) || !Array.isArray(payload.inventory)) {
    throw new Error('Invalid backup file.');
  }
  await saveInventory(payload.inventory);
  await saveOrders(payload.orders, { actor: 'import' });
  if (payload.settings) await saveSettings(payload.settings);
  await appendAuditLog({ action: 'imported-backup', actor: 'import', summary: { orders: payload.orders.length, inventory: payload.inventory.length } });
}
