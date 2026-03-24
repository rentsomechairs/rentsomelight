import { getInventory, getSettings } from './store.js';
import { currency, safeText } from './utils.js';

const els = {
  filters: document.getElementById('galleryFilters'),
  content: document.getElementById('galleryContent')
};

const state = {
  inventory: [],
  settings: {},
  activeCategory: '__all__'
};

function byCategory(items = []) {
  const groups = new Map();
  items.forEach((item) => {
    const category = String(item.category || 'Other').trim() || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(item);
  });
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getCategories() {
  return byCategory(state.inventory).map(([category]) => category);
}

function filterItems() {
  if (state.activeCategory === '__all__') return state.inventory;
  return state.inventory.filter((item) => String(item.category || 'Other') === state.activeCategory);
}

function resolveGalleryImage(src = '') {
  const value = String(src || '').trim();
  if (!value) return '../images/library.json';
  if (/^(data:|blob:|https?:\/\/|\/)/i.test(value)) return value;
  if (value.startsWith('../') || value.startsWith('./')) return value;
  return `../${value.replace(/^\/+/, '')}`;
}

function itemImage(item) {
  return item?.imageData || resolveGalleryImage(item?.imageUrl || '');
}


function renderFilters() {
  const categories = getCategories();
  const buttons = ['__all__', ...categories].map((category) => {
    const active = category === state.activeCategory;
    const label = category === '__all__' ? 'All Items' : category;
    return `<button type="button" class="category-chip ${active ? 'active' : ''}" data-gallery-filter="${safeText(category)}">${safeText(label)}</button>`;
  }).join('');
  els.filters.innerHTML = buttons;
  els.filters.querySelectorAll('[data-gallery-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeCategory = button.dataset.galleryFilter;
      renderFilters();
      renderContent();
    });
  });
}

function renderCard(item) {
  const stock = Number(item.stock || 0);
  const stockLabel = stock === 1 ? '1 available unit' : `${stock} available units`;
  return `
    <article class="gallery-card">
      <div class="gallery-image-wrap">
        <img class="gallery-image" src="${safeText(itemImage(item))}" alt="${safeText(item.name)}" loading="lazy" />
      </div>
      <div class="gallery-card-body">
        <div class="gallery-card-top">
          <span class="gallery-price">${currency(item.price)}</span>
        </div>
        <h3>${safeText(item.name)}</h3>
        <div class="gallery-card-footer">
          <span class="gallery-stock">${safeText(stockLabel)}</span>
          <a class="btn btn-primary btn-small" href="../quick-picker/index.html">Request</a>
        </div>
      </div>
    </article>`;
}

function renderContent() {
  const filtered = filterItems();
  const groups = byCategory(filtered);
  if (!filtered.length) {
    els.content.innerHTML = '<div class="card empty-state">No gallery items to show yet.</div>';
    return;
  }

  els.content.innerHTML = groups.map(([category, items]) => `
    <section class="gallery-section" id="gallery-${safeText(category).toLowerCase().replace(/[^a-z0-9]+/g, '-')}">
      ${state.activeCategory === '__all__' ? `<div class="section-header gallery-section-head"><div><h2>${safeText(category)}</h2></div><div class="badge badge-green">${items.length} item${items.length === 1 ? '' : 's'}</div></div>` : ''}
      <div class="gallery-grid">
        ${items.map(renderCard).join('')}
      </div>
    </section>
  `).join('');
}

async function init() {
  try {
    const [inventory, settings] = await Promise.all([getInventory(), getSettings()]);
    state.inventory = inventory.sort((a, b) => {
      const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
      if (categoryCompare !== 0) return categoryCompare;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    state.settings = settings || {};
    renderFilters();
    renderContent();
  } catch (error) {
    console.error(error);
    els.content.innerHTML = '<div class="card empty-state">The gallery could not be loaded right now.</div>';
  }
}

init();
