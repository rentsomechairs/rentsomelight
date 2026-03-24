import { getSettings } from './store.js';
import { currency, deliveryFeeFromMiles, safeText } from './utils.js';
import { computeDeliveryEstimate, debounce, geocodeAddress, searchAddresses } from './geo.js';

const state = {
  settings: null,
  suggestions: [],
  address: '',
  destination: null,
  lookupToken: 0
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error(error);
    if (els.resultNote) els.resultNote.textContent = 'Could not load the delivery checker right now.';
  });
});

async function init() {
  cacheEls();
  state.settings = await getSettings();
  bindEvents();
  renderPickupNote();
}

function cacheEls() {
  Object.assign(els, {
    checkerAddress: document.getElementById('checkerAddress'),
    checkerSuggestions: document.getElementById('checkerSuggestions'),
    checkerStatus: document.getElementById('checkerStatus'),
    checkerMiles: document.getElementById('checkerMiles'),
    checkerFee: document.getElementById('checkerFee'),
    checkerSource: document.getElementById('checkerSource'),
    resultNote: document.getElementById('checkerResultNote'),
    pickupNote: document.getElementById('checkerPickupNote')
  });
}

function bindEvents() {
  const debouncedLookup = debounce((query) => lookupSuggestions(query), 280);
  els.checkerAddress?.addEventListener('input', () => {
    state.address = els.checkerAddress.value.trim();
    state.destination = null;
    clearEstimate();
    els.checkerStatus.textContent = state.address ? 'Looking up nearby addresses…' : '';
    debouncedLookup(state.address);
  });
  els.checkerAddress?.addEventListener('focus', () => {
    if (state.suggestions.length) renderSuggestions(state.suggestions);
  });
  els.checkerAddress?.addEventListener('blur', () => {
    window.setTimeout(hideSuggestions, 150);
  });
  els.checkerAddress?.addEventListener('change', () => {
    const value = els.checkerAddress.value.trim();
    state.address = value;
    resolveAddress(value);
  });
  els.checkerSuggestions?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-checker-suggestion]');
    if (!button) return;
    const match = state.suggestions[Number(button.dataset.checkerSuggestion)];
    if (match) selectSuggestion(match);
  });
  document.addEventListener('click', (event) => {
    if (event.target === els.checkerAddress || els.checkerSuggestions?.contains(event.target)) return;
    hideSuggestions();
  });
}

function renderPickupNote() {
  const pickupAddress = state.settings?.pickupAddress || 'Pickup address not saved yet.';
  const rate = Number(state.settings?.deliveryRatePerMile || 0);
  if (els.pickupNote) {
    els.pickupNote.innerHTML = `Estimated from <strong>${safeText(pickupAddress)}</strong> at <strong>${currency(rate)}/mile</strong> round trip.`;
  }
}

function formatDistanceTag(match) {
  return Number.isFinite(match?.distanceFromOriginMiles)
    ? `${match.distanceFromOriginMiles.toFixed(1)} mi from pickup`
    : '';
}

function hideSuggestions() {
  els.checkerSuggestions?.classList.add('hidden');
}

function renderSuggestions(matches = []) {
  state.suggestions = Array.isArray(matches) ? matches : [];
  if (!els.checkerSuggestions) return;
  if (!state.suggestions.length) {
    els.checkerSuggestions.innerHTML = '';
    hideSuggestions();
    return;
  }
  els.checkerSuggestions.innerHTML = state.suggestions.map((match, index) => `
    <button type="button" class="address-suggestion${index === 0 ? ' active' : ''}" data-checker-suggestion="${index}">
      <div class="address-suggestion-primary">${safeText(match.primaryLine || match.label)}</div>
      <div class="address-suggestion-secondary">${safeText(match.secondaryLine || match.label)}</div>
      ${formatDistanceTag(match) ? `<div class="address-suggestion-distance">${safeText(formatDistanceTag(match))}</div>` : ''}
    </button>
  `).join('');
  els.checkerSuggestions.classList.remove('hidden');
}

async function lookupSuggestions(query) {
  const text = String(query || '').trim();
  const token = ++state.lookupToken;
  if (text.length < 3) {
    renderSuggestions([]);
    els.checkerStatus.textContent = text ? 'Keep typing for local address suggestions.' : '';
    return;
  }
  if (!state.settings?.pickupCoords?.lat || !state.settings?.pickupCoords?.lon) {
    els.checkerStatus.textContent = 'Pickup coordinates are not saved in admin settings yet.';
    return;
  }
  try {
    const matches = await searchAddresses(text, {
      limit: 6,
      origin: state.settings.pickupCoords,
      context: state.settings,
      maxDistanceMiles: 100
    });
    if (token !== state.lookupToken) return;
    renderSuggestions(matches);
    els.checkerStatus.textContent = matches.length
      ? 'Choose a suggestion below or finish typing the full address.'
      : 'No nearby match yet. Keep typing the street name.';
  } catch (error) {
    if (token !== state.lookupToken) return;
    renderSuggestions([]);
    els.checkerStatus.textContent = 'Autocomplete is unavailable right now.';
  }
}

async function selectSuggestion(match) {
  state.destination = { lat: match.lat, lon: match.lon };
  state.address = match.label;
  els.checkerAddress.value = match.label;
  hideSuggestions();
  await applyEstimate(match);
}

async function resolveAddress(query) {
  const text = String(query || '').trim();
  if (!text) return;
  if (!state.settings?.pickupCoords?.lat || !state.settings?.pickupCoords?.lon) {
    els.checkerStatus.textContent = 'Pickup coordinates are not saved in admin settings yet.';
    return;
  }
  try {
    els.checkerStatus.textContent = 'Calculating delivery estimate…';
    const match = await geocodeAddress(text, {
      origin: state.settings.pickupCoords,
      context: state.settings,
      maxDistanceMiles: 100
    });
    if (!match) {
      els.checkerStatus.textContent = 'No nearby match found yet. Keep typing the full address.';
      return;
    }
    await applyEstimate(match);
  } catch (error) {
    els.checkerStatus.textContent = 'Could not calculate the estimate right now.';
  }
}

async function applyEstimate(match) {
  const destination = { lat: match.lat, lon: match.lon };
  const estimate = await computeDeliveryEstimate(state.settings.pickupCoords, destination);
  const roundTripMiles = Number(estimate.roundTripMiles || 0);
  const fee = deliveryFeeFromMiles(roundTripMiles, state.settings?.deliveryRatePerMile || 0);

  state.destination = destination;
  state.address = match.label;
  els.checkerMiles.textContent = `${roundTripMiles.toFixed(1)} mi round trip`;
  els.checkerFee.textContent = currency(fee);
  els.checkerSource.textContent = estimate.source === 'road'
    ? `Road estimate • one way ${estimate.oneWayMiles.toFixed(1)} mi`
    : `Straight-line fallback • one way ${estimate.oneWayMiles.toFixed(1)} mi`;
  els.resultNote.textContent = match.label;
  els.checkerStatus.textContent = 'Estimate ready.';
}

function clearEstimate() {
  if (els.checkerMiles) els.checkerMiles.textContent = '--';
  if (els.checkerFee) els.checkerFee.textContent = '--';
  if (els.checkerSource) els.checkerSource.textContent = '';
  if (els.resultNote) els.resultNote.textContent = 'Type a local delivery address to test the quote.';
}
