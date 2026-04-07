
const PHOTON_BASE = 'https://photon.komoot.io';
const OSRM_BASE = 'https://router.project-osrm.org';

let googleMapsPromise = null;
let googleAutocompleteSession = { token: null, touchedAt: 0, key: '' };

function compactParts(parts) {
  return parts.filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toGoogleLatLng(value) {
  return { lat: Number(value.lat), lng: Number(value.lon ?? value.lng) };
}

function toBBox(origin, miles = 60) {
  if (!(origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon))) return null;
  const latDelta = miles / 69;
  const lonDelta = miles / (69 * Math.max(Math.cos((Number(origin.lat) * Math.PI) / 180), 0.2));
  return {
    north: Number(origin.lat) + latDelta,
    south: Number(origin.lat) - latDelta,
    east: Number(origin.lon) + lonDelta,
    west: Number(origin.lon) - lonDelta
  };
}

function splitLabel(label = '') {
  const parts = String(label).split(',').map((part) => part.trim()).filter(Boolean);
  return {
    primaryLine: parts[0] || String(label || '').trim(),
    secondaryLine: parts.slice(1).join(', ')
  };
}

function getGoogleMapsApiKey(context = null) {
  return String(context?.googleMapsApiKey || '').trim();
}

async function ensureGoogleMaps(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return null;
  if (window.google?.maps?.importLibrary) return window.google.maps;
  if (googleMapsPromise) return googleMapsPromise;

  googleMapsPromise = (async () => {
    // Install the official dynamic library import bootstrap loader.
    ((g) => {
      const p = 'The Google Maps JavaScript API';
      const c = 'google';
      const l = 'importLibrary';
      const q = '__ib__';
      const m = document;
      const b = window;
      b[c] = b[c] || {};
      const d = (b[c].maps = b[c].maps || {});
      const r = new Set();
      const e = new URLSearchParams();
      let h;

      const u = () => h || (h = new Promise((resolve, reject) => {
        const a = m.createElement('script');
        e.set('libraries', [...r].join(','));
        for (const k in g) {
          e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), g[k]);
        }
        e.set('callback', c + '.maps.' + q);
        a.src = 'https://maps.googleapis.com/maps/api/js?' + e.toString();
        a.async = true;
        a.defer = true;
        a.dataset.googleMapsLoader = 'true';
        a.onerror = () => reject(new Error(p + ' could not load.'));
        d[q] = resolve;
        const nonce = m.querySelector('script[nonce]');
        if (nonce) a.nonce = nonce.nonce || '';
        m.head.appendChild(a);
      }));

      if (d[l]) return;
      d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n));
    })({
      key,
      v: 'weekly'
    });

    const start = Date.now();
    while (!window.google?.maps?.importLibrary) {
      if (Date.now() - start > 8000) {
        throw new Error('google.maps.importLibrary did not become available.');
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }

    return window.google.maps;
  })().catch((error) => {
    googleMapsPromise = null;
    throw error;
  });

  return googleMapsPromise;
}

function getGoogleSessionToken(_placesLib, apiKey) {
  const now = Date.now();
  if (!googleAutocompleteSession.token || googleAutocompleteSession.key !== apiKey || now - googleAutocompleteSession.touchedAt > 180000) {
    googleAutocompleteSession = {
      token: window.google?.maps?.places?.AutocompleteSessionToken
        ? new window.google.maps.places.AutocompleteSessionToken()
        : null,
      touchedAt: now,
      key: apiKey
    };
  } else {
    googleAutocompleteSession.touchedAt = now;
  }
  return googleAutocompleteSession.token;
}

async function searchAddressesGoogle(query, { limit = 5, origin = null, context = null, maxDistanceMiles = 100 } = {}) {
  const apiKey = getGoogleMapsApiKey(context);
  if (!apiKey) return [];
  await ensureGoogleMaps(apiKey);
  await google.maps.importLibrary('places');
  const text = String(query || '').trim();
  if (text.length < 3) return [];

  const service = new google.maps.places.AutocompleteService();
  const request = {
    input: text,
    componentRestrictions: { country: 'us' },
    sessionToken: getGoogleSessionToken(null, apiKey),
    types: ['address']
  };

  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    request.location = new google.maps.LatLng(Number(origin.lat), Number(origin.lon));
    request.radius = clamp((maxDistanceMiles || 100) * 1609.344, 10000, 160000);
  }

  const predictions = await new Promise((resolve, reject) => {
    service.getPlacePredictions(request, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK || status === 'OK') {
        resolve(Array.isArray(results) ? results : []);
        return;
      }
      if (status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS || status === 'ZERO_RESULTS') {
        resolve([]);
        return;
      }
      reject(new Error(`Autocomplete failed (${status})`));
    });
  });

  return predictions.slice(0, limit).map((prediction, index) => {
    const textValue = prediction?.description || '';
    const matched = Array.isArray(prediction?.structured_formatting?.main_text_matched_substrings)
      ? prediction.structured_formatting.main_text_matched_substrings
      : [];
    const distanceMiles = Number.isFinite(prediction?.distance_meters)
      ? Number(prediction.distance_meters) / 1609.344
      : null;
    const { primaryLine, secondaryLine } = splitLabel(textValue);
    return {
      label: textValue,
      primaryLine: prediction?.structured_formatting?.main_text || primaryLine,
      secondaryLine: prediction?.structured_formatting?.secondary_text || secondaryLine,
      lat: NaN,
      lon: NaN,
      placeId: prediction?.place_id || `${textValue}|${index}`,
      distanceFromOriginMiles: distanceMiles,
      matchedSubstrings: matched,
      raw: prediction,
      provider: 'google'
    };
  });
}

async function geocodeAddressGoogle(query, { origin = null, context = null } = {}) {
  const apiKey = getGoogleMapsApiKey(context);
  if (!apiKey) return null;
  await ensureGoogleMaps(apiKey);
  const text = String(query || '').trim();
  if (!text) return null;

  const boundsBox = toBBox(origin, 80);
  const geocoder = new google.maps.Geocoder();
  const request = { address: text, region: 'US' };
  if (boundsBox) {
    request.bounds = new google.maps.LatLngBounds(
      { lat: boundsBox.south, lng: boundsBox.west },
      { lat: boundsBox.north, lng: boundsBox.east }
    );
  }

  const result = await new Promise((resolve, reject) => {
    geocoder.geocode(request, (results, status) => {
      if (status !== 'OK' || !Array.isArray(results) || !results.length) {
        reject(new Error(`Geocode failed (${status})`));
        return;
      }
      resolve(results[0]);
    });
  });

  const location = result.geometry?.location;
  const formatted = result.formatted_address || text;
  const { primaryLine, secondaryLine } = splitLabel(formatted);
  return {
    label: formatted,
    primaryLine,
    secondaryLine,
    lat: Number(location?.lat?.()),
    lon: Number(location?.lng?.()),
    placeId: result.place_id || formatted,
    distanceFromOriginMiles: origin ? haversineMiles(origin, { lat: Number(location?.lat?.()), lon: Number(location?.lng?.()) }) : null,
    raw: result,
    provider: 'google'
  };
}

async function getRoadMilesGoogle(origin, destination, context = null) {
  const apiKey = getGoogleMapsApiKey(context);
  if (!apiKey) throw new Error('Google Maps API key missing');
  await ensureGoogleMaps(apiKey);
  const service = new google.maps.DistanceMatrixService();
  const response = await new Promise((resolve, reject) => {
    service.getDistanceMatrix({
      origins: [toGoogleLatLng(origin)],
      destinations: [toGoogleLatLng(destination)],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.IMPERIAL,
      avoidFerries: false,
      avoidHighways: false,
      avoidTolls: false
    }, (result, status) => {
      if (status !== 'OK') {
        reject(new Error(`Distance Matrix failed (${status})`));
        return;
      }
      resolve(result);
    });
  });

  const element = response?.rows?.[0]?.elements?.[0];
  const meters = Number(element?.distance?.value);
  if (!Number.isFinite(meters)) throw new Error('No route distance returned');
  return meters / 1609.344;
}


function addressComponent(place, type, short = false) {
  const comps = Array.isArray(place?.addressComponents)
    ? place.addressComponents
    : (Array.isArray(place?.address_components) ? place.address_components : []);
  const match = comps.find((c) => Array.isArray(c?.types) && c.types.includes(type));
  if (!match) return '';
  if ('longText' in match || 'shortText' in match) {
    return short ? (match.shortText || match.longText || '') : (match.longText || match.shortText || '');
  }
  return short ? (match.short_name || match.long_name || '') : (match.long_name || match.short_name || '');
}

export async function attachGooglePlaceAutocomplete(inputEl, { context = null, placeholder = '', onSelect = null } = {}) {
  const apiKey = getGoogleMapsApiKey(context);
  if (!apiKey) throw new Error('Google Maps API key missing. Add it in Admin Settings to use address autocomplete.');
  if (!inputEl) throw new Error('Address input not found.');
  await ensureGoogleMaps(apiKey);
  await google.maps.importLibrary('places');
  if (!google.maps.places?.Autocomplete) {
    throw new Error('Places library loaded, but Autocomplete is unavailable. Make sure the Places library is enabled.');
  }

  if (inputEl.dataset.googleLegacyAutocompleteReady === 'true') return inputEl;

  if (placeholder) inputEl.setAttribute('placeholder', placeholder);

  const autocomplete = new google.maps.places.Autocomplete(inputEl, {
    componentRestrictions: { country: 'us' },
    fields: ['formatted_address', 'address_components', 'geometry', 'place_id'],
    types: ['address']
  });

  const pickup = context?.pickupCoords;
  if (pickup && Number.isFinite(pickup.lat) && Number.isFinite(pickup.lon)) {
    const boundsBox = toBBox(pickup, 100);
    if (boundsBox) {
      const bounds = new google.maps.LatLngBounds(
        { lat: boundsBox.south, lng: boundsBox.west },
        { lat: boundsBox.north, lng: boundsBox.east }
      );
      autocomplete.setBounds(bounds);
      autocomplete.setOptions({ strictBounds: false });
    }
  }

  inputEl.dataset.googleLegacyAutocompleteReady = 'true';
  inputEl.__googleLegacyAutocomplete = autocomplete;

  autocomplete.addListener('place_changed', async () => {
    const place = autocomplete.getPlace();
    const formatted = place?.formatted_address || inputEl.value.trim() || '';
    const fallback = splitLabel(formatted);
    const streetLine = compactParts([
      addressComponent(place, 'street_number'),
      addressComponent(place, 'route')
    ]).join(' ');
    const secondaryLine = compactParts([
      addressComponent(place, 'locality') || addressComponent(place, 'postal_town'),
      addressComponent(place, 'administrative_area_level_1', true),
      addressComponent(place, 'postal_code')
    ]).join(', ');
    const location = place?.geometry?.location;
    const match = {
      label: formatted,
      primaryLine: streetLine || fallback.primaryLine,
      secondaryLine: secondaryLine || fallback.secondaryLine,
      lat: Number(location?.lat?.()),
      lon: Number(location?.lng?.()),
      placeId: place?.place_id || formatted,
      raw: place,
      provider: 'google'
    };
    inputEl.value = formatted;
    if (typeof onSelect === 'function') await onSelect(match, place);
  });

  return inputEl;
}

export function debounce(fn, delay = 250) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

async function fetchPhoton(query, { limit = 10, origin = null } = {}) {
  const url = new URL('/api', PHOTON_BASE);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 25)));
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    url.searchParams.set('lat', String(origin.lat));
    url.searchParams.set('lon', String(origin.lon));
    url.searchParams.set('location_bias_scale', '0.2');
  }
  const response = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
    mode: 'cors',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Address lookup failed (${response.status})`);
  const payload = await response.json();
  return Array.isArray(payload?.features) ? payload.features : [];
}

function streetLine(props = {}) {
  return compactParts([
    props.housenumber,
    props.street,
    props.name && !props.street ? props.name : ''
  ]).join(' ');
}

function cityLine(props = {}) {
  return compactParts([
    props.city,
    props.county,
    props.state,
    props.postcode
  ]).join(', ');
}

function mapPhotonFeature(feature, index, origin = null) {
  const props = feature?.properties || {};
  const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  const primaryLine = streetLine(props) || props.name || props.street || '';
  const secondaryLine = cityLine(props) || compactParts([props.country]).join(', ');
  const label = compactParts([primaryLine, secondaryLine]).join(', ') || props.name || '';
  return {
    label,
    primaryLine,
    secondaryLine,
    lat,
    lon,
    placeId: props.osm_id || `${lat}|${lon}|${label}`,
    distanceFromOriginMiles: origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)
      ? haversineMiles(origin, { lat, lon })
      : null,
    raw: feature,
    provider: 'photon'
  };
}

async function searchAddressesPhoton(query, { limit = 5, origin = null } = {}) {
  const text = String(query || '').trim();
  if (text.length < 3) return [];
  const features = await fetchPhoton(text, { limit: Math.max(limit * 4, 12), origin });
  return features
    .map((feature, index) => mapPhotonFeature(feature, index, origin))
    .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon))
    .sort((a, b) => {
      const aDist = Number.isFinite(a.distanceFromOriginMiles) ? a.distanceFromOriginMiles : Number.POSITIVE_INFINITY;
      const bDist = Number.isFinite(b.distanceFromOriginMiles) ? b.distanceFromOriginMiles : Number.POSITIVE_INFINITY;
      return aDist - bDist;
    })
    .slice(0, limit);
}

export async function searchAddresses(query, options = {}) {
  const context = options?.context || null;
  if (getGoogleMapsApiKey(context)) {
    return searchAddressesGoogle(query, options);
  }
  return searchAddressesPhoton(query, options);
}

export async function geocodeAddress(query, options = {}) {
  const context = options?.context || null;
  if (!getGoogleMapsApiKey(context)) {
    throw new Error('Google Maps API key missing. Add it in Admin Settings to use address matching.');
  }
  return geocodeAddressGoogle(query, options);
}

export function haversineMiles(origin, destination) {
  if (!origin || !destination) return 0;
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const r = 3958.7613;
  const dLat = toRad((destination.lat ?? destination.lng) - origin.lat);
  const dLon = toRad((destination.lon ?? destination.lng) - origin.lon);
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(destination.lat ?? destination.lng ?? destination.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

async function getRoadMilesPhoton(origin, destination) {
  const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
  const url = new URL(`/route/v1/driving/${coords}`, OSRM_BASE);
  url.searchParams.set('overview', 'false');
  url.searchParams.set('alternatives', 'false');
  url.searchParams.set('steps', 'false');
  const response = await fetch(url.toString(), { headers: { 'Accept': 'application/json' }, mode: 'cors' });
  if (!response.ok) throw new Error(`Routing failed (${response.status})`);
  const payload = await response.json();
  const meters = payload?.routes?.[0]?.distance;
  if (!Number.isFinite(meters)) throw new Error('No route distance returned');
  return meters / 1609.344;
}

export async function computeDeliveryEstimate(origin, destination, context = null) {
  if (!getGoogleMapsApiKey(context)) {
    throw new Error('Google Maps API key missing. Add it in Admin Settings to calculate delivery distance.');
  }
  const oneWayMiles = await getRoadMilesGoogle(origin, destination, context);
  return {
    oneWayMiles,
    roundTripMiles: oneWayMiles * 2,
    source: 'road'
  };
}
