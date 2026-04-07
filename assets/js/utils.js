export const CONTACT_METHODS = [
  { key: 'text', label: 'Text', placeholder: 'Phone number' },
  { key: 'email', label: 'Email', placeholder: 'Email address' },
  { key: 'facebook', label: 'Facebook Marketplace Messenger', placeholder: 'Messenger name / link' },
  { key: 'other', label: 'Other', placeholder: 'How should we contact you?' }
];

export const ORDER_STATUSES = ['Pending', 'Confirmed', 'In-Progress', 'Completed'];
export const PAYMENT_STATUSES = ['Un-Paid', 'Deposit', 'Paid', 'Free'];
export const FULFILLMENT_TYPES = ['Pickup', 'Delivery'];

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function currency(value = 0) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Number(value || 0));
}

export function parseDateTime(date, time) {
  if (!date) return null;
  const safeTime = /^\d{2}:\d{2}$/.test(String(time || '').trim()) ? String(time).trim() : '00:00';
  return new Date(`${date}T${safeTime}:00`);
}

export function formatDateTime(date, time) {
  if (!date) return 'Not set';
  const d = parseDateTime(date, time);
  const dateText = d && !Number.isNaN(d.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d)
    : date;
  const rawTime = String(time || '').trim();
  if (!rawTime) return `${dateText} · To Be Determined`;
  if (!/^\d{2}:\d{2}$/.test(rawTime)) return `${dateText} · ${rawTime}`;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(d);
}

export function formatShortDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '--';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric'
  }).format(d);
}

export function addDays(dateStr, diff) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

export function overlaps(startA, endA, startB, endB) {
  if (!startA || !endA || !startB || !endB) return false;
  return startA < endB && endA > startB;
}

export function safeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function normalizeCategory(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

export function compareExchangeAsc(a, b) {
  const aTime = parseDateTime(a.exchangeDate, a.exchangeTime)?.getTime() || 0;
  const bTime = parseDateTime(b.exchangeDate, b.exchangeTime)?.getTime() || 0;
  return aTime - bTime;
}

export function compareCompletedDesc(a, b) {
  const aTime = new Date(a.completedAt || 0).getTime() || 0;
  const bTime = new Date(b.completedAt || 0).getTime() || 0;
  return bTime - aTime;
}

export function getOrderColumn(status) {
  if (status === 'Completed') return 'completed';
  if (status === 'Pending') return 'pending';
  return 'confirmed';
}

export function deliveryFeeFromMiles(miles, rate) {
  return Number(miles || 0) * Number(rate || 0);
}

export function buildContactMap(selectedMethods, values) {
  const out = {};
  selectedMethods.forEach((method) => {
    const value = values[method]?.trim();
    if (value) out[method] = value;
  });
  return out;
}

export function contactSummary(contactMethods = {}) {
  const entries = Object.entries(contactMethods);
  if (!entries.length) return 'No contact method provided';
  return entries.map(([k, v]) => `${k}: ${v}`).join(' • ');
}
