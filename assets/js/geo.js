const PHOTON_BASE = 'https://photon.komoot.io';
const OSRM_BASE = 'https://router.project-osrm.org';

const STREET_SUFFIXES = new Set([
  'st','street','rd','road','dr','drive','ln','lane','ave','avenue','blvd','boulevard','ct','court',
  'cir','circle','trl','trail','pkwy','parkway','pl','place','way','ter','terrace','hwy','highway',
  'nw','ne','sw','se','north','south','east','west','northeast','northwest','southeast','southwest'
]);

const ADDRESSISH_TYPES = new Set(['house','street','road','residential','address']);
const VAGUE_TYPES = new Set(['county','state','country','city','district','locality']);

function compactParts(parts) {
  return parts.filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function stripStreetSuffixes(tokens = []) {
  return tokens.filter((token) => !STREET_SUFFIXES.has(token));
}

function cityLine(props = {}) {
  return compactParts([
    props.city,
    props.county,
    props.state,
    props.postcode
  ]).join(', ');
}

function streetLine(props = {}) {
  return compactParts([
    props.housenumber,
    props.street,
    props.name && !props.street ? props.name : ''
  ]).join(' ');
}

function mapPhotonFeature(feature, index, origin = null) {
  const props = feature?.properties || {};
  const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  const primaryLine = streetLine(props) || props.name || props.street || '';
  const secondaryLine = cityLine(props) || compactParts([props.country]).join(', ');
  const label = compactParts([primaryLine, secondaryLine]).join(', ') || props.name || '';
  const distanceFromOriginMiles = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)
    ? haversineMiles(origin, { lat, lon })
    : null;

  return {
    label,
    primaryLine,
    secondaryLine,
    lat,
    lon,
    placeId: props.osm_id || `${lat}|${lon}|${label}`,
    distanceFromOriginMiles,
    raw: feature,
    rankIndex: index,
    normPrimary: normalizeText(primaryLine),
    normSecondary: normalizeText(secondaryLine),
    normRoad: normalizeText(props.street || props.name || ''),
    houseNumber: normalizeText(props.housenumber || ''),
    cityName: normalizeText(props.city || ''),
    countyName: normalizeText(props.county || ''),
    stateName: normalizeText(props.state || ''),
    postcode: normalizeText(props.postcode || ''),
    countryName: normalizeText(props.country || ''),
    type: normalizeText(props.type || ''),
    osmType: normalizeText(props.osm_type || '')
  };
}

function distanceScore(miles, profile) {
  if (!Number.isFinite(miles)) return 0;
  if (miles <= 2) return 580;
  if (miles <= 5) return 500;
  if (miles <= 10) return 400;
  if (miles <= 20) return 300;
  if (miles <= 35) return 170;
  if (miles <= 50) return profile.stage === 'very-short' ? 20 : 90;
  if (miles <= 75) return profile.stage === 'very-short' ? -320 : -40;
  if (miles <= 100) return profile.stage === 'very-short' ? -900 : -260;
  return profile.stage === 'very-short' ? -4000 : -2200;
}

function getQueryParts(query) {
  const normalized = normalizeText(query);
  const tokens = tokenize(normalized);
  const houseToken = /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0] : '';
  const streetTokens = stripStreetSuffixes(houseToken ? tokens.slice(1) : tokens);
  return { normalized, tokens, houseToken, streetTokens };
}

function getQueryProfile(query) {
  const { normalized, tokens, houseToken, streetTokens } = getQueryParts(query);
  const joinedStreet = streetTokens.join(' ');
  const charCount = normalized.replace(/\s+/g, '').length;
  const streetCharCount = joinedStreet.replace(/\s+/g, '').length;

  let stage = 'broad';
  if (charCount <= 5 || (houseToken && streetCharCount <= 2)) stage = 'very-short';
  else if (streetCharCount <= 5) stage = 'short';
  else if (streetCharCount <= 8) stage = 'medium';

  return {
    normalized,
    tokens,
    houseToken,
    streetTokens,
    joinedStreet,
    charCount,
    streetCharCount,
    looksNearComplete: Boolean(houseToken && streetCharCount >= 8),
    stage
  };
}

function getStageDistanceLimit(profile) {
  switch (profile.stage) {
    case 'very-short': return 25;
    case 'short': return 45;
    case 'medium': return 90;
    default: return 180;
  }
}

function getStageFallbackDistanceLimit(profile) {
  switch (profile.stage) {
    case 'very-short': return 80;
    case 'short': return 120;
    case 'medium': return 180;
    default: return 260;
  }
}

function tokenCoverageScore(streetTokens, roadTokens) {
  if (!streetTokens.length) return 0;
  let exact = 0;
  let prefix = 0;
  streetTokens.forEach((token, idx) => {
    const roadToken = roadTokens[idx] || '';
    if (roadToken === token) {
      exact += 1;
      return;
    }
    if (roadToken.startsWith(token) || token.startsWith(roadToken)) {
      prefix += 1;
      return;
    }
    if (roadTokens.includes(token)) prefix += 0.5;
  });
  return (exact * 1.2) + prefix;
}

function localityScore(entry, localHints = {}, profile) {
  const localCity = normalizeText(localHints.city || '');
  const localCounty = normalizeText(localHints.county || '');
  const localState = normalizeText(localHints.state || '');
  const localZip = normalizeText(localHints.postcode || '');
  let score = 0;

  if (localCity && entry.cityName === localCity) score += 130;
  if (localCounty && entry.countyName === localCounty) score += 70;
  if (localState && entry.stateName === localState) score += 55;
  if (localZip && entry.postcode === localZip) score += 50;

  if (localState && entry.stateName && entry.stateName !== localState) {
    score -= profile.stage === 'very-short' ? 1400 : profile.stage === 'short' ? 800 : 260;
  }

  if (entry.countryName && !['united states','usa','us'].includes(entry.countryName)) {
    score -= profile.stage === 'very-short' ? 2600 : profile.stage === 'short' ? 1600 : 500;
  }

  return score;
}

function qualityGatePenalty(entry, profile) {
  const roadTokens = stripStreetSuffixes(tokenize(entry.normRoad));
  const joinedRoad = roadTokens.join(' ');
  let penalty = 0;

  if ((profile.houseToken || profile.streetTokens.length) && !joinedRoad && !ADDRESSISH_TYPES.has(entry.type)) {
    penalty -= profile.stage === 'very-short' ? 1500 : 500;
  }

  if (VAGUE_TYPES.has(entry.type)) {
    penalty -= profile.stage === 'very-short' ? 1700 : 650;
  }

  if (profile.houseToken && entry.houseNumber && entry.houseNumber !== profile.houseToken) {
    penalty -= profile.stage === 'very-short' ? 520 : 260;
  }

  if (profile.streetTokens.length) {
    const coverage = tokenCoverageScore(profile.streetTokens, roadTokens);
    const lastToken = profile.streetTokens[profile.streetTokens.length - 1] || '';
    const lastTokenMatched = lastToken
      ? roadTokens.some((token) => token.startsWith(lastToken) || lastToken.startsWith(token))
      : false;

    if (profile.stage === 'very-short' && profile.streetCharCount >= 2 && !lastTokenMatched) penalty -= 900;
    if (profile.stage === 'short' && profile.streetCharCount >= 3 && coverage < 0.9 && !lastTokenMatched) penalty -= 520;
    if (profile.stage === 'medium' && coverage < 1.1 && !joinedRoad.includes(profile.joinedStreet)) penalty -= 250;
    if (profile.looksNearComplete && !joinedRoad.includes(profile.joinedStreet) && coverage < Math.max(1.4, profile.streetTokens.length * 0.75)) penalty -= 300;
  }

  return penalty;
}

function scoreResult(entry, query, localHints = {}) {
  const profile = getQueryProfile(query);
  const { normalized, tokens, houseToken, streetTokens } = profile;
  if (!normalized || !tokens.length) return 0;

  const primaryTokens = tokenize(entry.normPrimary);
  const roadTokens = stripStreetSuffixes(tokenize(entry.normRoad));
  const haystack = `${entry.normPrimary} ${entry.normSecondary}`.trim();
  const joinedStreet = streetTokens.join(' ');
  const joinedRoad = roadTokens.join(' ');

  let score = 0;
  if (entry.normPrimary.startsWith(normalized)) score += 340;
  else if (entry.normRoad.startsWith(normalized)) score += 320;
  else if (haystack.startsWith(normalized)) score += 180;
  else if (entry.normRoad.includes(normalized)) score += 140;
  else if (entry.normPrimary.includes(normalized)) score += 110;

  if (houseToken) {
    if (entry.houseNumber === houseToken) score += 330;
    else if (primaryTokens[0] === houseToken) score += 120;
    else score -= profile.stage === 'very-short' ? 500 : 260;
  }

  if (streetTokens.length) {
    const coverage = tokenCoverageScore(streetTokens, roadTokens);
    if (joinedRoad === joinedStreet) score += 650;
    else if (joinedRoad.startsWith(joinedStreet)) score += 520;
    else if (joinedRoad.includes(joinedStreet)) score += 300;
    else if (entry.normPrimary.includes(joinedStreet)) score += 180;
    else score -= profile.stage === 'very-short' ? 260 : 380;

    score += coverage * (profile.stage === 'very-short' ? 145 : 110);

    const lastToken = streetTokens[streetTokens.length - 1] || '';
    if (lastToken && roadTokens.length) {
      const roadJoined = roadTokens.join(' ');
      if (!roadJoined.includes(lastToken) && !roadTokens.some((token) => token.startsWith(lastToken) || lastToken.startsWith(token))) {
        score -= profile.stage === 'very-short' ? 340 : 180;
      }
    }

    if (coverage < Math.max(1, streetTokens.length * 0.6)) score -= 180;
  }

  score += localityScore(entry, localHints, profile);
  score += qualityGatePenalty(entry, profile);
  score += distanceScore(entry.distanceFromOriginMiles, profile);
  return score;
}

function rankResults(results, query, origin = null, localHints = {}) {
  return [...results].sort((a, b) => {
    const aScore = scoreResult(a, query, localHints);
    const bScore = scoreResult(b, query, localHints);
    if (aScore !== bScore) return bScore - aScore;

    if (origin) {
      const aDist = Number.isFinite(a.distanceFromOriginMiles) ? a.distanceFromOriginMiles : Number.POSITIVE_INFINITY;
      const bDist = Number.isFinite(b.distanceFromOriginMiles) ? b.distanceFromOriginMiles : Number.POSITIVE_INFINITY;
      if (Math.abs(aDist - bDist) > 0.05) return aDist - bDist;
    }
    return a.rankIndex - b.rankIndex;
  });
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
  if (!response.ok) {
    throw new Error(`Address lookup failed (${response.status})`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.features) ? payload.features : [];
}

function parsePickupContext(context = {}) {
  const source = String(context?.pickupGeocodedAddress || context?.pickupAddress || '').trim();
  if (!source) return { city: '', county: '', state: '', postcode: '' };

  const normalized = source.replace(/\s+/g, ' ').trim();
  const zipMatch = normalized.match(/\b\d{5}(?:-\d{4})?\b/);
  const parts = normalized.split(',').map((part) => part.trim()).filter(Boolean);

  let city = '';
  let county = '';
  let state = '';
  let postcode = zipMatch ? zipMatch[0] : '';

  if (parts.length >= 2) city = parts[parts.length - 3] || parts[parts.length - 2] || '';
  const countyPart = parts.find((part) => /county/i.test(part));
  if (countyPart) county = countyPart;
  for (const part of parts) {
    const token = part.split(/\s+/).find((t) => /^[A-Z]{2}$/.test(t));
    if (token) { state = token; break; }
  }

  return {
    city: normalizeText(city),
    county: normalizeText(county),
    state: normalizeText(state),
    postcode: normalizeText(postcode)
  };
}

function buildPhotonQueries(text, context = {}) {
  const clean = String(text || '').trim();
  const profile = getQueryProfile(clean);
  const local = parsePickupContext(context);
  const queries = [];

  if (local.city && local.state) queries.push(`${clean} ${local.city} ${local.state}`);
  if (local.city) queries.push(`${clean} ${local.city}`);
  if (local.postcode) queries.push(`${clean} ${local.postcode}`);
  if (local.state) queries.push(`${clean} ${local.state}`);
  queries.push(clean);

  if (profile.looksNearComplete && local.city && local.state) {
    queries.push(`${clean}, ${local.city}, ${local.state}`);
  }

  return { local, profile, queries: [...new Set(queries)].filter(Boolean) };
}

function isStronglyLocal(entry, local) {
  return Boolean(
    (local.city && entry.cityName === local.city) ||
    (local.county && entry.countyName === local.county) ||
    (local.state && entry.stateName === local.state)
  );
}

function filterPool(entries, profile, local, origin, explicitMaxDistanceMiles) {
  if (!(origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon))) return entries;

  const stageLimit = clamp(Math.min(explicitMaxDistanceMiles || 9999, getStageDistanceLimit(profile)), 5, 500);
  const stageFallback = clamp(Math.min(explicitMaxDistanceMiles || 9999, getStageFallbackDistanceLimit(profile)), stageLimit, 1000);

  let pool = entries.filter((entry) => {
    if (entry.countryName && !['united states','usa','us'].includes(entry.countryName)) {
      return profile.stage === 'broad' && profile.looksNearComplete;
    }
    if (local.state && entry.stateName && entry.stateName !== local.state && profile.stage !== 'broad') return false;
    if (Number.isFinite(entry.distanceFromOriginMiles) && entry.distanceFromOriginMiles > stageFallback) return false;
    if ((profile.houseToken || profile.streetTokens.length) && VAGUE_TYPES.has(entry.type)) return false;
    return true;
  });

  const stronglyLocal = pool.filter((entry) => isStronglyLocal(entry, local));
  const withinStage = pool.filter((entry) => !Number.isFinite(entry.distanceFromOriginMiles) || entry.distanceFromOriginMiles <= stageLimit);
  const localWithinStage = withinStage.filter((entry) => isStronglyLocal(entry, local));

  if (localWithinStage.length >= 3) return localWithinStage;
  if (withinStage.length >= 4) return withinStage;
  if (stronglyLocal.length >= 3) return stronglyLocal;
  return pool;
}

export async function searchAddresses(query, { limit = 5, origin = null, context = null, maxDistanceMiles = 100 } = {}) {
  const text = String(query || '').trim();
  if (text.length < 3) return [];

  const { local, profile, queries } = buildPhotonQueries(text, context || {});
  const perQueryLimit = Math.max(limit * 5, 20);
  const featureBuckets = await Promise.all(
    queries.map((entry) => fetchPhoton(entry, { limit: perQueryLimit, origin }))
  );
  const featureList = featureBuckets.flat();

  const deduped = [];
  const seen = new Set();
  featureList.forEach((feature, index) => {
    const mapped = mapPhotonFeature(feature, index, origin);
    if (!Number.isFinite(mapped.lat) || !Number.isFinite(mapped.lon)) return;
    const key = `${mapped.houseNumber}|${mapped.normRoad}|${mapped.cityName}|${mapped.stateName}|${mapped.postcode}|${mapped.lat.toFixed(5)}|${mapped.lon.toFixed(5)}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(mapped);
  });

  const pool = filterPool(deduped, profile, local, origin, maxDistanceMiles);
  const ranked = rankResults(pool, text, origin, local);
  return ranked.slice(0, limit);
}

export async function geocodeAddress(query, { origin = null, context = null, maxDistanceMiles = 100 } = {}) {
  const results = await searchAddresses(query, { limit: 1, origin, context, maxDistanceMiles });
  return results[0] || null;
}

export function haversineMiles(origin, destination) {
  if (!origin || !destination) return 0;
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const r = 3958.7613;
  const dLat = toRad(destination.lat - origin.lat);
  const dLon = toRad(destination.lon - origin.lon);
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(destination.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

export async function getRoadMiles(origin, destination) {
  if (!origin || !destination) throw new Error('Missing coordinates');
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

export async function computeDeliveryEstimate(origin, destination) {
  try {
    const oneWayMiles = await getRoadMiles(origin, destination);
    return {
      oneWayMiles,
      roundTripMiles: oneWayMiles * 2,
      source: 'road'
    };
  } catch (error) {
    const fallbackOneWay = haversineMiles(origin, destination);
    return {
      oneWayMiles: fallbackOneWay,
      roundTripMiles: fallbackOneWay * 2,
      source: 'straight-line',
      fallbackReason: error?.message || 'Routing unavailable'
    };
  }
}
