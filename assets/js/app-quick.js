import { getCategories, getInventory, getOrders, getSettings, saveOrders } from './store.js';
import { CONTACT_METHODS, addDays, buildContactMap, currency, deliveryFeeFromMiles, overlaps, parseDateTime, safeText, uid, formatShortDate, formatDateTime } from './utils.js';
import { computeDeliveryEstimate, debounce, geocodeAddress, searchAddresses } from './geo.js';
import { sendInquiryNotification } from './email-notify.js';

const state = {
  inventory: [],
  orders: [],
  settings: {},
  selectedCategories: new Set(),
  receiveDate: '',
  receiveTime: '10:00',
  returnDate: '',
  returnTime: '17:00',
  selectedItems: {},
  selectedAccessories: {},
  fulfillmentType: '',
  deliveryAddress: '',
  deliveryCoords: null,
  estimatedMiles: 0,
  deliveryEstimateSource: '',
  deliveryLookupStatus: '',
  deliverySuggestions: [],
  deliveryLookupToken: 0,
  selectedContactMethods: [],
  contactValues: {},
  availabilityOffset: 0,
  step: 1,
  submitted: false,
  summaryVisible: false,
  reviewReady: false,
  notificationResult: null
};

const els = {};

function enforceAccordionState() {
  const sections = [1, 2, 3, 4, 5, 6]
    .map((step) => document.getElementById(`step${step}`))
    .filter(Boolean);
  sections.forEach((section, index) => {
    const stepNumber = index + 1;
    section.classList.toggle('open', stepNumber === 1);
    section.classList.toggle('collapsed', stepNumber !== 1);
  });
}

function formatDistanceTag(match) {
  return Number.isFinite(match?.distanceFromOriginMiles)
    ? `${match.distanceFromOriginMiles.toFixed(1)} mi from pickup`
    : '';
}

function hideDeliverySuggestions() {
  if (!els.deliveryAddressSuggestions) return;
  els.deliveryAddressSuggestions.classList.add('hidden');
}

function renderDeliverySuggestions(matches = []) {
  if (!els.deliveryAddressSuggestions) return;
  state.deliverySuggestions = Array.isArray(matches) ? matches : [];
  if (!state.deliverySuggestions.length) {
    els.deliveryAddressSuggestions.innerHTML = '';
    hideDeliverySuggestions();
    return;
  }
  els.deliveryAddressSuggestions.innerHTML = state.deliverySuggestions.map((match, index) => `
    <button type="button" class="address-suggestion${index === 0 ? ' active' : ''}" data-delivery-suggestion="${index}">
      <div class="address-suggestion-primary">${safeText(match.primaryLine || match.label)}</div>
      <div class="address-suggestion-secondary">${safeText(match.secondaryLine || match.label)}</div>
      ${formatDistanceTag(match) ? `<div class="address-suggestion-distance">${safeText(formatDistanceTag(match))}</div>` : ''}
    </button>
  `).join('');
  els.deliveryAddressSuggestions.classList.remove('hidden');
}

async function selectDeliverySuggestion(match) {
  if (!match) return;
  state.deliveryAddress = match.label;
  state.deliveryCoords = { lat: match.lat, lon: match.lon };
  els.deliveryAddress.value = match.label;
  hideDeliverySuggestions();
  await resolveDeliveryAddress(match.label, match);
}


function getItemImageSrc(item) {
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

function getSelectedAccessoryIds(inventoryId) {
  return Array.isArray(state.selectedAccessories[inventoryId]) ? state.selectedAccessories[inventoryId] : [];
}

function getSelectedAccessoriesForItem(item) {
  const selectedIds = getSelectedAccessoryIds(item.id);
  return normalizeAccessories(item.accessories).filter((accessory) => selectedIds.includes(accessory.id));
}

function getDisplayImageForPickerItem(item) {
  const selected = getSelectedAccessoriesForItem(item);
  const accessoryWithImage = [...selected].reverse().find((entry) => entry.imageData);
  return accessoryWithImage?.imageData || getItemImageSrc(item);
}


function normalizeImageUrl(url) {
  if (!url) return '';
  if (/^(https?:)?\/\//.test(url)) return url;
  if (url.startsWith('/')) return url;
  url = url.replace(/^\.\.\//, '').replace(/^\.\//, '');
  if (url.startsWith('images/')) return `/${url}`;
  return `/${url}`;
}

let summaryObserver;

document.addEventListener('DOMContentLoaded', () => { init().catch(console.error); });

async function init() {
  cacheEls();
  await loadData();
  setDefaultDates();
  state.step = 1;
  state.reviewReady = false;
  bindEvents();
  enforceAccordionState();
  setupSummaryObserver();
  render();
  [0, 60, 180, 320].forEach((delay) => {
    window.setTimeout(() => {
      enforceAccordionState();
      renderSections();
      renderActionStates();
      renderSummary();
    }, delay);
  });
}


function cacheEls() {
  Object.assign(els, {
    pickerForm: document.getElementById('pickerForm'),
    pickerStepsWrap: document.getElementById('pickerStepsWrap'),
    summary: document.getElementById('summary'),
    summaryCard: document.getElementById('summaryCard'),
    responseMessage: document.getElementById('responseMessage'),
    mobileTotalBar: document.getElementById('mobileTotalBar'),
    mobileTotalAmount: document.getElementById('mobileTotalAmount'),
    mobileStepCount: document.getElementById('mobileStepCount'),
    mobileTotalWrap: document.getElementById('mobileTotalWrap'),
    step1: document.getElementById('step1'),
    step2: document.getElementById('step2'),
    step3: document.getElementById('step3'),
    step4: document.getElementById('step4'),
    step5: document.getElementById('step5'),
    step6: document.getElementById('step6'),
    nextStep1: document.getElementById('nextStep1'),
    nextStep2: document.getElementById('nextStep2'),
    nextStep3: document.getElementById('nextStep3'),
    nextStep4: document.getElementById('nextStep4'),
    nextStep5: document.getElementById('nextStep5'),
    categoryChips: document.getElementById('categoryChips'),
    receiveDate: document.getElementById('receiveDate'),
    receiveTime: document.getElementById('receiveTime'),
    returnDate: document.getElementById('returnDate'),
    returnTime: document.getElementById('returnTime'),
    availabilityBoard: document.getElementById('availabilityBoard'),
    availabilityPrev: document.getElementById('availabilityPrev'),
    availabilityNext: document.getElementById('availabilityNext'),
    availabilityDateLabel: document.getElementById('availabilityDateLabel'),
    itemChooser: document.getElementById('itemChooser'),
    contactChecks: document.getElementById('contactChecks'),
    contactInputs: document.getElementById('contactInputs'),
    fulfillmentPickup: document.getElementById('fulfillmentPickup'),
    fulfillmentDelivery: document.getElementById('fulfillmentDelivery'),
    deliveryFields: document.getElementById('deliveryFields'),
    pickupName: document.getElementById('pickupName'),
    pickupAddress: document.getElementById('pickupAddress'),
    deliveryAddress: document.getElementById('deliveryAddress'),
    deliveryAddressSuggestions: document.getElementById('deliveryAddressSuggestions'),
    deliveryLookupStatus: document.getElementById('deliveryLookupStatus'),
    estimatedMiles: document.getElementById('estimatedMiles'),
    deliveryEstimateInline: document.getElementById('deliveryEstimateInline'),
    deliveryFeeInline: document.getElementById('deliveryFeeInline'),
    deliveryReviewFlag: document.getElementById('deliveryReviewFlag'),
    firstName: document.getElementById('firstName'),
    lastName: document.getElementById('lastName'),
    reviewInquiry: document.getElementById('reviewInquiry'),
    backToContact: document.getElementById('backToContact'),
    reviewSection: document.getElementById('reviewSection'),
    reviewContent: document.getElementById('reviewContent'),
    submitInquiry: document.getElementById('submitInquiry')
  });
}

async function loadData() {
  state.inventory = await getInventory();
  state.orders = await getOrders();
  state.settings = await getSettings();
}

function setDefaultDates() {
  const today = new Date();
  today.setDate(today.getDate() + 1);
  state.receiveDate = today.toISOString().slice(0, 10);
  state.returnDate = addDays(state.receiveDate, 1);
}

function bindEvents() {
  els.receiveDate.value = state.receiveDate;
  els.receiveTime.value = state.receiveTime;
  els.returnDate.value = state.returnDate;
  els.returnTime.value = state.returnTime;

  els.receiveDate.addEventListener('input', onReceiveInput);
  els.receiveTime.addEventListener('input', onReceiveInput);
  els.returnDate.addEventListener('input', onReturnInput);
  els.returnTime.addEventListener('input', onReturnInput);

  const debouncedDeliveryLookup = debounce((query) => lookupDeliverySuggestions(query), 280);
  els.deliveryAddress.addEventListener('input', () => {
    state.deliveryAddress = els.deliveryAddress.value.trim();
    state.deliveryCoords = null;
    state.deliveryEstimateSource = '';
    state.deliveryLookupStatus = state.deliveryAddress ? 'Looking up suggestions…' : '';
    debouncedDeliveryLookup(state.deliveryAddress);
    renderFulfillment();
    renderSummary();
    renderActionStates();
  });
  els.deliveryAddress.addEventListener('focus', () => {
    if (state.deliverySuggestions.length) renderDeliverySuggestions(state.deliverySuggestions);
  });
  els.deliveryAddress.addEventListener('blur', () => {
    window.setTimeout(() => hideDeliverySuggestions(), 160);
  });
  els.deliveryAddress.addEventListener('change', () => {
    const typed = els.deliveryAddress.value.trim();
    state.deliveryAddress = typed;
    resolveDeliveryAddress(typed);
  });
  els.deliveryAddressSuggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delivery-suggestion]');
    if (!button) return;
    const match = state.deliverySuggestions[Number(button.dataset.deliverySuggestion)];
    selectDeliverySuggestion(match);
  });
  document.addEventListener('click', (event) => {
    if (event.target === els.deliveryAddress || els.deliveryAddressSuggestions?.contains(event.target)) return;
    hideDeliverySuggestions();
  });
  if (els.deliveryReviewFlag) els.deliveryReviewFlag.addEventListener('change', renderSummary);
  els.firstName.addEventListener('input', renderActionStates);
  els.lastName.addEventListener('input', renderActionStates);

  els.availabilityPrev.addEventListener('click', () => {
    state.availabilityOffset = Math.max(-3, state.availabilityOffset - 1);
    renderAvailabilityBoard(getVisibleInventory());
  });
  els.availabilityNext.addEventListener('click', () => {
    state.availabilityOffset = Math.min(3, state.availabilityOffset + 1);
    renderAvailabilityBoard(getVisibleInventory());
  });

  els.nextStep1.addEventListener('click', () => advanceTo(2));
  els.nextStep2.addEventListener('click', () => advanceTo(3));
  els.nextStep3.addEventListener('click', () => advanceTo(4));
  els.nextStep4.addEventListener('click', () => advanceTo(5));
  els.nextStep5.addEventListener('click', () => advanceTo(6));
  els.reviewInquiry.addEventListener('click', showReviewSection);
  els.backToContact?.addEventListener('click', () => {
    state.reviewReady = false;
    renderReviewSection();
    advanceTo(6);
  });
  document.querySelectorAll('[data-step-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const targetStep = Number(button.dataset.stepTarget || 1);
      state.step = Math.min(targetStep, getHighestAllowedStep());
      if (state.step < 6) state.reviewReady = false;
      renderSections();
      const target = document.getElementById(`step${state.step}`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  els.fulfillmentPickup.addEventListener('click', () => {
    state.fulfillmentType = 'Pickup';
    hideDeliverySuggestions();
    render();
  });
  els.fulfillmentDelivery.addEventListener('click', () => {
    state.fulfillmentType = 'Delivery';
    if (state.deliverySuggestions.length) renderDeliverySuggestions(state.deliverySuggestions);
    render();
  });

  els.pickerForm.addEventListener('submit', handleSubmit);
  window.addEventListener('scroll', updateFloatingTotalVisibility, { passive: true });
  window.addEventListener('resize', updateFloatingTotalVisibility);
}


async function lookupDeliverySuggestions(query) {
  if (!els.deliveryAddressSuggestions) return;
  const text = String(query || '').trim();
  const token = ++state.deliveryLookupToken;
  if (text.length < 3) {
    renderDeliverySuggestions([]);
    state.deliveryLookupStatus = text ? 'Keep typing for address suggestions.' : '';
    renderFulfillment();
    return;
  }
  try {
    const matches = await searchAddresses(text, { limit: 6, origin: state.settings?.pickupCoords || null, context: state.settings || null });
    if (token !== state.deliveryLookupToken) return;
    renderDeliverySuggestions(matches);
    state.deliveryLookupStatus = matches.length
      ? 'Choose a suggestion below. Nearby matches are pushed to the top.'
      : 'No suggestions found yet. You can still type manually and edit miles yourself.';
  } catch (error) {
    if (token !== state.deliveryLookupToken) return;
    renderDeliverySuggestions([]);
    state.deliveryLookupStatus = 'Autocomplete is unavailable right now. You can still enter the address manually and edit miles.';
  }
  renderFulfillment();
}

async function resolveDeliveryAddress(query, preselectedMatch = null) {
  const text = String(query || '').trim();
  if (!text || state.fulfillmentType !== 'Delivery') return;
  if (!state.settings?.pickupCoords?.lat && !state.settings?.pickupCoords?.lon) {
    state.deliveryLookupStatus = 'Pickup coordinates are not saved yet in admin settings. You can still enter miles manually.';
    renderFulfillment();
    return;
  }
  try {
    state.deliveryLookupStatus = 'Calculating delivery distance…';
    renderFulfillment();
    const destination = preselectedMatch || await geocodeAddress(text, { origin: state.settings?.pickupCoords || null, context: state.settings || null });
    if (!destination) {
      state.deliveryLookupStatus = 'Address not matched. You can keep the typed address and enter miles manually.';
      renderFulfillment();
      return;
    }
    state.deliveryAddress = destination.label;
    state.deliveryCoords = { lat: destination.lat, lon: destination.lon };
    els.deliveryAddress.value = destination.label;
    const estimate = await computeDeliveryEstimate(state.settings.pickupCoords, state.deliveryCoords);
    state.estimatedMiles = Number(estimate.roundTripMiles.toFixed(1));
    els.estimatedMiles.value = state.estimatedMiles;
    state.deliveryEstimateSource = estimate.source;
    state.deliveryLookupStatus = estimate.source === 'road'
      ? `Estimated from road distance. One-way: ${estimate.oneWayMiles.toFixed(1)} miles.`
      : `Routing unavailable, so this uses straight-line distance. One-way: ${estimate.oneWayMiles.toFixed(1)} miles.`;
  } catch (error) {
    state.deliveryLookupStatus = 'Could not calculate distance automatically. You can still enter miles manually.';
  }
  renderFulfillment();
  renderSummary();
  renderActionStates();
}

function onReceiveInput() {
  state.receiveDate = els.receiveDate.value;
  state.receiveTime = els.receiveTime.value;
  state.availabilityOffset = 0;
  syncRange();
  render();
}

function onReturnInput() {
  state.returnDate = els.returnDate.value;
  state.returnTime = els.returnTime.value;
  render();
}

function syncRange() {
  if (!state.returnDate || state.returnDate < state.receiveDate) {
    state.returnDate = addDays(state.receiveDate, 1);
    els.returnDate.value = state.returnDate;
  }
}

function advanceTo(nextStep) {
  state.step = Math.min(nextStep, getHighestAllowedStep());
  if (state.step < 6) state.reviewReady = false;
  renderSections();
  const target = document.getElementById(`step${state.step}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getHighestAllowedStep() {
  if (!hasReceiveSelection()) return 1;
  if (!hasValidReturnRange()) return 2;
  if (!hasSelectedCategories()) return 3;
  if (!hasSelectedEquipment()) return 4;
  if (!hasFulfillmentSelection()) return 5;
  return 6;
}

function render() {
  renderSubmittedState();
  if (state.submitted) return;
  renderCategories();
  renderAvailabilityAndChooser();
  renderContactMethods();
  renderFulfillment();
  renderSummary();
  renderSections();
  renderActionStates();
}

function renderSubmittedState() {
  els.pickerForm.classList.toggle('hidden', state.submitted);
  els.responseMessage.classList.toggle('hidden', !state.submitted);
els.mobileTotalBar.classList.toggle('hidden', state.submitted);

  if (state.submitted) {
    const emailNote = state.notificationResult?.status === 'sent'
      ? '<div class="small muted" style="margin-top:10px;">An email notification was also sent to the business inbox.</div>'
      : '';
    els.responseMessage.innerHTML = `
      <section class="card staged-card thanks-card">
        <div class="eyebrow">Inquiry Sent</div>
        <h1 class="step-title">Thank you for your inquiry!</h1>
        <div class="note-block">
          Please remember that this order is pending until confirmed. Someone from our team will reach out to you as soon as possible to confirm everything. Dates and times chosen are subject to negotiation based on availability!
        </div>
        ${emailNote}
        <div class="step-actions step-actions-left">
          <button type="button" id="placeAnotherOrder" class="btn btn-primary">Place another order!</button>
        </div>
      </section>`;
    document.getElementById('placeAnotherOrder')?.addEventListener('click', resetAfterSubmit);
  } else {
    els.responseMessage.innerHTML = '';
  }
}

function renderSections() {
  const highest = getHighestAllowedStep();
  const sections = [els.step1, els.step2, els.step3, els.step4, els.step5, els.step6].filter(Boolean);
  sections.forEach((section, index) => {
    const stepNumber = index + 1;
    section.classList.remove('hidden');
    section.classList.toggle('open', stepNumber === state.step);
    section.classList.toggle('collapsed', stepNumber !== state.step);
    section.classList.toggle('completed', stepNumber < state.step);
    section.classList.toggle('locked', stepNumber > highest);
    const toggle = section.querySelector('[data-step-target]');
    if (toggle) toggle.disabled = stepNumber > highest;
  });
  if (els.mobileStepCount) {
    const names = {
      1: 'Exchange Date and Time',
      2: 'Return Date and Time',
      3: 'Category Selection',
      4: 'Equipment Selection',
      5: 'Pick-Up or Delivery',
      6: 'Communication Preference'
    };
    els.mobileStepCount.textContent = `Step ${state.step}/6 • ${names[state.step] || ''}`;
  }
  updateFloatingTotalVisibility();
}

function renderActionStates() {
  const canStep1 = hasReceiveSelection();
  const canStep2 = hasValidReturnRange();
  const canStep3 = hasSelectedCategories();
  const canStep4 = hasSelectedEquipment();
  const canStep5 = hasFulfillmentSelection();
  els.nextStep1.disabled = !canStep1;
  els.nextStep2.disabled = !canStep2;
  els.nextStep3.disabled = !canStep3;
  els.nextStep4.disabled = !canStep4;
  els.nextStep5.disabled = !canStep5;
  els.nextStep1.dataset.enabled = String(canStep1);
  els.nextStep2.dataset.enabled = String(canStep2);
  els.nextStep3.dataset.enabled = String(canStep3);
  els.nextStep4.dataset.enabled = String(canStep4);
  els.nextStep5.dataset.enabled = String(canStep5);
  const contactValid = hasValidContactSection();
  els.reviewInquiry.disabled = !contactValid;
  els.submitInquiry.disabled = !contactValid || !state.reviewReady;
}


function renderCategories() {
  const categories = ['All Categories', ...getCategories()];
  els.categoryChips.innerHTML = categories.map((category, index) => {
    const key = index === 0 ? '__all__' : category;
    const active = state.selectedCategories.has(key);
    return `<button type="button" class="category-chip ${active ? 'active' : ''}" data-category="${safeText(key)}">${index === 0 ? 'All Categories' : safeText(category)} ${active ? '✓' : ''}</button>`;
  }).join('');

  els.categoryChips.querySelectorAll('[data-category]').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.category;
    if (key === '__all__') {
      state.selectedCategories = new Set(['__all__']);
    } else {
      state.selectedCategories.delete('__all__');
      state.selectedCategories.has(key) ? state.selectedCategories.delete(key) : state.selectedCategories.add(key);
      if (!state.selectedCategories.size) state.selectedCategories = new Set(['__all__']);
    }
    render();
    renderSections();
    renderActionStates();
  }));
}

function hasSelectedCategories() {
  return state.selectedCategories.size > 0;
}

function getVisibleInventory() {
  if (state.selectedCategories.has('__all__')) return state.inventory;
  return state.inventory.filter((item) => state.selectedCategories.has(item.category));
}

function hasReceiveSelection() {
  return Boolean(state.receiveDate && state.receiveTime);
}

function hasValidReturnRange() {
  const start = parseDateTime(state.receiveDate, state.receiveTime);
  const end = parseDateTime(state.returnDate, state.returnTime);
  return Boolean(start && end && end > start);
}

function renderAvailabilityAndChooser() {
  const visible = getVisibleInventory();
  renderAvailabilityBoard(visible);
  renderItemChooser(visible);
}

function renderAvailabilityBoard(visible) {
  if (!visible.length || !hasReceiveSelection()) {
    els.availabilityBoard.innerHTML = '<div class="empty-state">No matching equipment yet.</div>';
    els.availabilityDateLabel.textContent = 'Pick a receive date';
    syncAvailabilityNav();
    return;
  }
  const currentDate = addDays(state.receiveDate, state.availabilityOffset || 0);
  els.availabilityDateLabel.textContent = formatShortDate(currentDate);
  els.availabilityBoard.innerHTML = `
    <div class="date-column single-date-column">
      <div class="date-column-head">${safeText(formatShortDate(currentDate))}</div>
      <div class="date-item-list compact-date-list">
        ${visible.map((item) => {
          const availability = availabilityForSingleDay(item.id, currentDate);
          const pending = quantityBookedForRange(item.id, currentDate, state.receiveTime, currentDate, state.returnTime || '23:00', ['Pending']);
          return `<div class="date-item-row compact"><span>${safeText(item.name)}</span><strong>${availability} available${pending ? ` · ${pending} pending` : ''}</strong></div>`;
        }).join('')}
      </div>
    </div>`;
  syncAvailabilityNav();
}

function renderItemChooser(visible) {
  if (!visible.length) {
    els.itemChooser.innerHTML = '';
    return;
  }
  const groups = visible.reduce((acc, item) => {
    acc[item.category] ||= [];
    acc[item.category].push(item);
    return acc;
  }, {});

  els.itemChooser.innerHTML = Object.entries(groups).map(([category, items]) => `
    <div class="category-group">
      <div class="section-header" style="margin-bottom:10px;"><div><strong>${safeText(category)}</strong></div></div>
      <div class="compact-item-list">
        ${items.map((item) => renderChooserItem(item)).join('')}
      </div>
    </div>
  `).join('');

  els.itemChooser.querySelectorAll('[data-select-item]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.selectItem;
    const availability = selectedRangeAvailability(id).available;
    if (availability > 0) {
      state.selectedItems[id] = 1;
      state.selectedAccessories[id] ||= [];
    }
    renderItemChooser(visible);
    renderSummary();
    renderActionStates();
  }));

  els.itemChooser.querySelectorAll('[data-clear-item]').forEach((btn) => btn.addEventListener('click', () => {
    delete state.selectedItems[btn.dataset.clearItem];
    delete state.selectedAccessories[btn.dataset.clearItem];
    renderItemChooser(visible);
    renderSummary();
    renderActionStates();
  }));

  els.itemChooser.querySelectorAll('[data-accessory-toggle]').forEach((input) => {
    input.addEventListener('change', () => {
      const inventoryId = input.dataset.accessoryToggle;
      const selected = [...els.itemChooser.querySelectorAll(`[data-accessory-toggle="${inventoryId}"]:checked`)].map((entry) => entry.value);
      state.selectedAccessories[inventoryId] = selected;
      renderItemChooser(visible);
      renderSummary();
      renderActionStates();
    });
  });

  els.itemChooser.querySelectorAll('[data-qty-input]').forEach((input) => {
    input.addEventListener('input', () => {
      const raw = input.value;
      if (raw === '') return;
      const max = Number(input.max || 0);
      const value = Math.max(1, Math.min(max, Number(raw || 0)));
      if (!Number.isFinite(value)) return;
      state.selectedItems[input.dataset.qtyInput] = value;
      renderSummary();
      renderActionStates();
    });

    const commitQty = () => {
      const raw = input.value.trim();
      const max = Number(input.max || 0);
      if (!raw) {
        delete state.selectedItems[input.dataset.qtyInput];
      } else {
        const value = Math.max(1, Math.min(max, Number(raw || 0)));
        if (!Number.isFinite(value) || value <= 0) delete state.selectedItems[input.dataset.qtyInput];
        else state.selectedItems[input.dataset.qtyInput] = value;
      }
      renderItemChooser(visible);
      renderSummary();
      renderActionStates();
    };

    input.addEventListener('change', commitQty);
    input.addEventListener('blur', commitQty);
  });
}

function renderChooserItem(item) {
  const selectedQty = Number(state.selectedItems[item.id] || 0);
  const availabilityNow = selectedRangeAvailability(item.id);
  const isSelected = selectedQty > 0;
  const accessories = normalizeAccessories(item.accessories);
  const selectedAccessoryIds = getSelectedAccessoryIds(item.id);
  return `
    <div class="picker-card compact-picker-card ${isSelected ? 'selected' : ''}">
      <div class="compact-picker-main">
        <img class="picker-image compact" src="${getDisplayImageForPickerItem(item)}" alt="${safeText(item.name)}" />
        <div class="stack-sm picker-item-content">
          <strong>${safeText(item.name)}</strong>
          <span class="small">${safeText(item.description || '')}</span>
          <div class="small muted">${currency(item.price)} per unit</div>
          <div><span class="badge badge-green">Available: ${availabilityNow.available}</span> <span class="badge badge-yellow">Pending: ${availabilityNow.pending}</span></div>
          ${isSelected && accessories.length ? `
            <div class="accessory-picker-list">
              ${accessories.map((accessory) => `
                <label class="accessory-check ${selectedAccessoryIds.includes(accessory.id) ? 'selected' : ''}">
                  <input type="checkbox" data-accessory-toggle="${item.id}" value="${accessory.id}" ${selectedAccessoryIds.includes(accessory.id) ? 'checked' : ''} />
                  <span><strong>Add ${safeText(accessory.name)}</strong><small>${currency(accessory.price)} each</small></span>
                </label>
              `).join('')}
            </div>
          ` : ''}
        </div>
        <div class="compact-picker-actions">
          ${isSelected
            ? `<div class="qty-pop"><label class="small">Qty</label><input type="number" min="1" max="${Math.max(1, availabilityNow.available)}" step="1" data-qty-input="${item.id}" value="${selectedQty}" /></div><button type="button" class="btn btn-secondary btn-small" data-clear-item="${item.id}">Remove</button>`
            : `<button type="button" class="btn btn-primary btn-small" data-select-item="${item.id}">Choose</button>`}
        </div>
      </div>
    </div>`;
}

function syncAvailabilityNav() {
  els.availabilityPrev.disabled = state.availabilityOffset <= -3;
  els.availabilityNext.disabled = state.availabilityOffset >= 3;
}

function selectedRangeAvailability(inventoryId) {
  const inventory = state.inventory.find((item) => item.id === inventoryId);
  const confirmedRangeQty = quantityBookedForRange(inventoryId, state.receiveDate, state.receiveTime, state.returnDate, state.returnTime, ['Confirmed', 'In-Progress']);
  const pendingQty = quantityBookedForRange(inventoryId, state.receiveDate, state.receiveTime, state.returnDate, state.returnTime, ['Pending']);
  return {
    available: Math.max(0, Number(inventory?.stock || 0) - confirmedRangeQty),
    pending: pendingQty
  };
}

function quantityBookedForRange(inventoryId, startDate, startTime, endDate, endTime, statuses) {
  const start = parseDateTime(startDate, startTime);
  const end = parseDateTime(endDate, endTime);
  if (!start || !end || end <= start) return 0;
  return state.orders
    .filter((order) => statuses.includes(order.status))
    .reduce((sum, order) => {
      const orderStart = parseDateTime(order.exchangeDate, order.exchangeTime);
      const orderEnd = parseDateTime(order.returnDate, order.returnTime);
      if (!overlaps(start, end, orderStart, orderEnd)) return sum;
      const qty = order.items
        .filter((item) => item.inventoryId === inventoryId)
        .reduce((inner, item) => inner + Number(item.quantity || 0), 0);
      return sum + qty;
    }, 0);
}

function availabilityForSingleDay(inventoryId, date) {
  const inventory = state.inventory.find((item) => item.id === inventoryId);
  const booked = quantityBookedForRange(inventoryId, date, state.receiveTime, date, state.returnTime || '23:00', ['Confirmed', 'In-Progress']);
  return Math.max(0, Number(inventory?.stock || 0) - booked);
}

function hasSelectedEquipment() {
  return selectedOrderItems().length > 0;
}

function isValidPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function formatPhoneInput(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
}

function renderContactMethods() {
  els.contactChecks.innerHTML = CONTACT_METHODS.map((method) => `
    <label class="check-pill"><input type="checkbox" data-contact-method value="${method.key}" ${state.selectedContactMethods.includes(method.key) ? 'checked' : ''} /> ${method.label}</label>
  `).join('');
  els.contactChecks.querySelectorAll('[data-contact-method]').forEach((input) => input.addEventListener('change', () => {
    state.selectedContactMethods = [...els.contactChecks.querySelectorAll('[data-contact-method]:checked')].map((entry) => entry.value);
    paintContactInputs();
    renderActionStates();
  }));
  paintContactInputs();
}

function paintContactInputs() {
  const activeElement = document.activeElement;
  const activeName = activeElement?.name || '';
  const activePos = typeof activeElement?.selectionStart === 'number' ? activeElement.selectionStart : null;

  els.contactInputs.innerHTML = state.selectedContactMethods.map((key) => {
    const meta = CONTACT_METHODS.find((entry) => entry.key === key);
    if (key === 'facebook') {
      return `<div class="note-block small">This option is for customers who contacted us through Facebook Messenger. If you have not already established a conversation in Facebook Messenger, please choose another option.</div>`;
    }
    const type = key === 'email' ? 'email' : key === 'text' ? 'tel' : 'text';
    const inputMode = key === 'text' ? 'tel' : key === 'email' ? 'email' : 'text';
    const extra = key === 'text' ? 'maxlength="14"' : '';
    return `<div class="form-row"><label>${meta.label}${key === 'text' || key === 'email' ? ' <span class="required-mark">*</span>' : ''}</label><input type="${type}" inputmode="${inputMode}" name="contact_${key}" placeholder="${meta.placeholder}" value="${safeText(state.contactValues[key] || '')}" ${extra} /></div>`;
  }).join('');

  els.contactInputs.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.name.replace('contact_', '');
      let value = input.value;
      if (key === 'text') {
        value = formatPhoneInput(value);
        input.value = value;
      }
      state.contactValues[key] = value;
      renderActionStates();
    });
  });

  if (activeName) {
    const replacement = els.contactInputs.querySelector(`[name="${activeName}"]`);
    if (replacement) {
      replacement.focus();
      if (activePos !== null) replacement.setSelectionRange(activePos, activePos);
    }
  }
}

function hasFulfillmentSelection() {
  if (state.fulfillmentType === 'Pickup') return true;
  if (state.fulfillmentType === 'Delivery') return Boolean((els.deliveryAddress.value || '').trim());
  return false;
}

function hasValidContactSection() {
  const first = (els.firstName.value || '').trim();
  const last = (els.lastName.value || '').trim();
  if (!first || !last || !state.selectedContactMethods.length) return false;
  return state.selectedContactMethods.every((key) => {
    if (key === 'facebook') return true;
    const value = String(state.contactValues[key] || '').trim();
    if (!value) return false;
    if (key === 'text') return isValidPhone(value);
    if (key === 'email') return isValidEmail(value);
    return true;
  });
}

function renderFulfillment() {
  els.fulfillmentPickup.classList.toggle('active', state.fulfillmentType === 'Pickup');
  els.fulfillmentDelivery.classList.toggle('active', state.fulfillmentType === 'Delivery');
  els.deliveryFields.classList.toggle('hidden', state.fulfillmentType !== 'Delivery');
  els.pickupName.textContent = state.settings.pickupName || 'Pickup location';
  els.pickupAddress.textContent = state.settings.pickupAddress || 'Add pickup address in admin settings.';
  if (els.deliveryLookupStatus) els.deliveryLookupStatus.textContent = state.deliveryLookupStatus || '';
  if (els.deliveryEstimateInline) els.deliveryEstimateInline.textContent = state.deliveryLookupStatus || '';
  if (els.deliveryFeeInline) {
    const fee = state.fulfillmentType === 'Delivery' ? deliveryFeeFromMiles(state.estimatedMiles, state.settings.deliveryRatePerMile) : 0;
    els.deliveryFeeInline.textContent = state.fulfillmentType === 'Delivery' ? currency(fee) : 'Pickup selected';
  }
  if (state.fulfillmentType === 'Delivery' && !state.settings?.pickupCoords && !state.deliveryLookupStatus) {
    els.deliveryLookupStatus.textContent = 'Pickup coordinates are not saved yet in admin settings. We can review the delivery quote manually if needed.';
  }
}

function selectedOrderItems() {
  return state.inventory
    .filter((item) => Number(state.selectedItems[item.id] || 0) > 0)
    .map((item) => {
      const quantity = Number(state.selectedItems[item.id] || 0);
      const selectedAccessories = getSelectedAccessoriesForItem(item);
      const accessorySubtotal = selectedAccessories.reduce((sum, accessory) => sum + (Number(accessory.price || 0) * quantity), 0);
      return {
        inventoryId: item.id,
        name: item.name,
        quantity,
        price: Number(item.price || 0),
        accessories: selectedAccessories.map((accessory) => ({
          id: accessory.id,
          name: accessory.name,
          price: Number(accessory.price || 0),
          imageData: accessory.imageData || ''
        })),
        accessorySubtotal,
        subtotal: (Number(item.price || 0) * quantity) + accessorySubtotal
      };
    });
}

function computeTotals() {
  const items = selectedOrderItems();
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
  const deliveryFee = state.fulfillmentType === 'Delivery'
    ? deliveryFeeFromMiles(state.estimatedMiles, state.settings.deliveryRatePerMile)
    : 0;
  return {
    items,
    subtotal,
    deliveryFee,
    total: subtotal + deliveryFee
  };
}

function renderReviewSection() {
  const { items, subtotal, deliveryFee, total } = computeTotals();
  const canSubmit = hasValidContactSection();
  const contactLines = state.selectedContactMethods.map((key) => {
    if (key === 'facebook') return '<div class="kv-row"><span>Facebook Messenger</span><strong>Existing conversation</strong></div>';
    const meta = CONTACT_METHODS.find((entry) => entry.key === key);
    return `<div class="kv-row"><span>${safeText(meta?.label || key)}</span><strong>${safeText(state.contactValues[key] || '')}</strong></div>`;
  }).join('');
  const itemsHtml = items.map((item) => {
    const accessories = item.accessories?.length
      ? `<div class="small muted">Accessories: ${item.accessories.map((accessory) => `${safeText(accessory.name)} (${currency(accessory.price)} each)`).join(', ')}</div>`
      : '';
    return `<div class="kv-row-block"><div class="kv-row"><span>${safeText(item.name)} × ${item.quantity}</span><strong>${currency(item.subtotal)}</strong></div>${accessories}</div>`;
  }).join('') || '<div class="muted">No equipment selected yet.</div>';
  els.reviewContent.innerHTML = `
    <div class="kv">
      <div class="kv-row"><span>Name</span><strong>${safeText((els.firstName.value || '').trim())} ${safeText((els.lastName.value || '').trim())}</strong></div>
      <div class="kv-row"><span>Exchange</span><strong>${safeText(formatDateTime(state.receiveDate, state.receiveTime))}</strong></div>
      <div class="kv-row"><span>Return</span><strong>${safeText(formatDateTime(state.returnDate, state.returnTime))}</strong></div>
      <div class="kv-row"><span>Fulfillment</span><strong>${safeText(state.fulfillmentType || '--')}</strong></div>
      <div class="kv-row"><span>${state.fulfillmentType === 'Delivery' ? 'Delivery address' : 'Pickup address'}</span><strong>${safeText(state.fulfillmentType === 'Delivery' ? (els.deliveryAddress.value || state.deliveryAddress || '--') : (state.settings.pickupAddress || '--'))}</strong></div>
      ${contactLines}
      <div class="hr"></div>
      ${itemsHtml}
      <div class="hr"></div>
      <div class="kv-row"><span>Delivery fee</span><strong>${state.fulfillmentType === 'Delivery' ? currency(deliveryFee) : 'Pickup selected'}</strong></div>
      <div class="kv-row"><span>Order total</span><strong>${currency(total)}</strong></div>
      ${els.deliveryReviewFlag?.checked ? '<div class="note-block small">Delivery estimate was marked for review.</div>' : ''}
      <div class="review-submit-inline"><button type="submit" class="btn btn-primary review-submit-inline-btn" ${canSubmit && state.reviewReady ? '' : 'disabled'}>Submit</button></div>
    </div>`;
  els.reviewSection?.classList.toggle('hidden', !state.reviewReady);
  if (els.submitInquiry) {
    els.submitInquiry.disabled = !canSubmit || !state.reviewReady;
    els.submitInquiry.classList.add('hidden');
    els.submitInquiry.style.display = 'none';
  }
  if (state.reviewReady) els.reviewSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


function renderSummary() {
  const { items, subtotal, deliveryFee, total } = computeTotals();
  const itemsHtml = items.length
    ? items.map((item) => {
        const accessoryText = item.accessories?.length
          ? `<div class="small muted">+ ${item.accessories.map((accessory) => `${safeText(accessory.name)} (${currency(accessory.price)} each)`).join(', ')}</div>`
          : '';
        return `<div class="kv-row-block"><div class="kv-row"><span>${safeText(item.name)} × ${item.quantity}</span><strong>${currency(item.subtotal)}</strong></div>${accessoryText}</div>`;
      }).join('')
    : '<div class="muted">No equipment selected yet.</div>';

  if (els.summary) {
    els.summary.innerHTML = '';
  }

  els.mobileTotalAmount.textContent = currency(total);
  renderReviewSection();
  updateFloatingTotalVisibility();
}

function showReviewSection() {
  if (!hasValidContactSection()) return;
  state.reviewReady = true;
  renderReviewSection();
  renderSections();
  renderActionStates();
}


function setupSummaryObserver() {
  if (!('IntersectionObserver' in window)) return;
  summaryObserver = new IntersectionObserver((entries) => {
    state.summaryVisible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.2);
    updateFloatingTotalVisibility();
  }, { threshold: [0.2, 0.6] });
  if (els.summaryCard) summaryObserver.observe(els.summaryCard);
}

function updateFloatingTotalVisibility() {
  const shouldShowBar = !state.submitted;
  const shouldShowTotal = !state.submitted;
  els.mobileTotalBar.classList.toggle('hidden', !shouldShowBar);
  els.mobileTotalWrap?.classList.toggle('hidden', !shouldShowTotal);
  els.mobileTotalBar.classList.remove('faded');
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!hasValidContactSection() || !state.reviewReady) return;
  const form = new FormData(els.pickerForm);
  const { items, subtotal, deliveryFee, total } = computeTotals();
  const contactValues = Object.fromEntries(state.selectedContactMethods.map((key) => {
    if (key === 'facebook') return [key, 'Established via Facebook Messenger'];
    return [key, form.get(`contact_${key}`) || state.contactValues[key] || ''];
  }));
  const contactMap = buildContactMap(state.selectedContactMethods, contactValues);
  const order = {
    id: uid('ord'),
    firstName: (form.get('firstName') || '').trim(),
    lastName: (form.get('lastName') || '').trim(),
    status: 'Pending',
    paymentStatus: 'Un-Paid',
    fulfillmentType: state.fulfillmentType,
    address: state.fulfillmentType === 'Delivery' ? (form.get('deliveryAddress') || '').trim() : '',
    exchangeDate: state.receiveDate,
    exchangeTime: state.receiveTime,
    returnDate: state.returnDate,
    returnTime: state.returnTime,
    deliveryMiles: Number(form.get('estimatedMiles') || 0),
    deliveryFee,
    deliveryNeedsReview: Boolean(form.get('deliveryReviewFlag')),
    deliveryEstimateSource: state.fulfillmentType === 'Delivery' ? (state.deliveryEstimateSource || (Number(form.get('estimatedMiles') || 0) > 0 ? 'manual' : '')) : '',
    deliveryCoords: state.fulfillmentType === 'Delivery' ? state.deliveryCoords : null,
    pickupCoordsSnapshot: state.fulfillmentType === 'Delivery' ? (state.settings.pickupCoords || null) : null,
    addressSnapshot: state.fulfillmentType === 'Delivery' ? state.deliveryAddress : '',
    total,
    items,
    contactMethods: contactMap,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: '',
    newInquiry: true,
    source: 'quick-picker',
    subtotal
  };
  const orders = await getOrders();
  orders.unshift(order);
  await saveOrders(orders, { actor: 'quick-picker' });
  state.orders = orders;
  try {
    state.settings = await getSettings();
    const notificationResult = await sendInquiryNotification(state.settings, order);
    state.notificationResult = notificationResult;
    order.notificationEmailStatus = notificationResult.status;
    order.notificationEmailUpdatedAt = new Date().toISOString();
    if (notificationResult.reason) order.notificationEmailReason = notificationResult.reason;
  } catch (error) {
    state.notificationResult = { status: 'failed', reason: error?.message || 'Notification failed.' };
    order.notificationEmailStatus = 'failed';
    order.notificationEmailReason = error?.message || 'Notification failed.';
    order.notificationEmailUpdatedAt = new Date().toISOString();
    console.error('Inquiry email notification failed:', error);
  }
  await saveOrders(orders, { actor: 'quick-picker-notify' });
  state.submitted = true;
  renderSubmittedState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetAfterSubmit() {
  els.pickerForm.reset();
  state.selectedCategories = new Set();
  state.selectedItems = {};
  state.selectedAccessories = {};
  state.selectedContactMethods = [];
  state.contactValues = {};
  state.fulfillmentType = '';
  state.estimatedMiles = 0;
  state.deliveryAddress = '';
  state.deliverySuggestions = [];
  state.deliveryCoords = null;
  state.deliveryEstimateSource = '';
  state.deliveryLookupStatus = '';
  state.reviewReady = false;
  state.notificationResult = null;
  state.availabilityOffset = 0;
  state.step = 1;
  state.submitted = false;
  state.summaryVisible = false;
  if (els.deliveryReviewFlag) els.deliveryReviewFlag.checked = false;
  setDefaultDates();
  els.receiveDate.value = state.receiveDate;
  els.receiveTime.value = state.receiveTime;
  els.returnDate.value = state.returnDate;
  els.returnTime.value = state.returnTime;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
