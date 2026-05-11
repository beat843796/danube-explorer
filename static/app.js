const map = L.map("map", {
  dragging: false,
  touchZoom: false,
  doubleClickZoom: false,
  scrollWheelZoom: true,
  boxZoom: false,
  keyboard: false,
  zoomControl: true,
  rotate: true, // enables map.setBearing() via leaflet-rotate plugin
  rotateControl: false,
});

L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> &middot; AIS via <a href="https://www.eurisportal.eu/">EuRIS</a>',
    subdomains: "abcd",
    maxZoom: 19,
    keepBuffer: 4,
  }
).addTo(map);

// ---------- Debug ----------

const zoomDebugEl = document.getElementById("zoom-debug");
const sliderEl = document.getElementById("river-km");
const sliderValueEl = document.getElementById("river-km-value");

function updateZoomDebug() {
  if (!zoomDebugEl) return;
  const z = map.getZoom();
  const zoomStr = typeof z === "number" ? `zoom ${z.toFixed(2)}` : "zoom —";
  const km = sliderEl ? sliderEl.value : "—";
  zoomDebugEl.textContent = `${zoomStr} · km ${km}`;
}
map.on("zoom zoomend move", updateZoomDebug);

// ---------- Vessels (EuRIS REST, per-rectangle fetching) ----------

const FETCH_DEBOUNCE_MS = 500;
const POLL_MS = 30_000;
const VESSEL_TTL_MS = 5 * 60_000;
const FETCH_MIN_INTERVAL_MS = 5_000;
const VESSEL_LIST_REFRESH_MS = 5_000;

const vessels = new Map();    // trackId -> { ...track, marker, lastSeen, isLive }
const rectState = new Map();  // rectIdx -> { lastFetchedAt, lastClippedKey, inFlight }
const vesselFilter = new Set(); // "underway" | "stopped"
let rectangles = [];          // [{index, minLat, maxLat, minLng, maxLng}]
let fetchTimer = null;
let pollTimer = null;
let vesselListTimer = null;
let vesselsTabActive = false;
let vesselRkm = () => null;   // (v) -> river km (set in init once orderedPath is ready)
let pollStats = { rounds: 0, lastTracks: 0 };

function vesselLabel(v) {
  if (v.name && !/^Track \d+$/.test(v.name)) return v.name;
  if (v.callSign) return v.callSign;
  return `Track ${v.trackId}`;
}

function arrowLengthPx(speedKmh) {
  const s = typeof speedKmh === "number" ? speedKmh : 0;
  return Math.min(60, 12 + Math.max(0, s) * 1.5);
}

function makeArrowIcon(courseGround, speedKmh, isLive) {
  const len = arrowLengthPx(speedKmh);
  const fill = isLive ? "#e8590c" : "#7a7a7a";
  const halfW = 7;
  const vb = Math.ceil(len + 14);
  const tipY = -len / 2;
  const wingY = tipY + 12;
  const tailY = len / 2;
  const html =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-vb / 2} ${-vb / 2} ${vb} ${vb}" width="${vb}" height="${vb}" style="transform: rotate(${courseGround}deg)">` +
    `<line x1="0" y1="${tailY}" x2="0" y2="${tipY + 6}" stroke="${fill}" stroke-width="3" stroke-linecap="round"/>` +
    `<polygon points="0,${tipY} ${halfW},${wingY} 0,${wingY - 4} ${-halfW},${wingY}" fill="${fill}" stroke="white" stroke-width="1.4" stroke-linejoin="round"/>` +
    `</svg>`;
  return L.divIcon({
    className: `vessel vessel-moving${isLive ? "" : " vessel-cached"}`,
    html,
    iconSize: [vb, vb],
    iconAnchor: [vb / 2, vb / 2],
  });
}

function makeStoppedIcon(isLive) {
  const fill = isLive ? "#1c4d80" : "#7a7a7a";
  return L.divIcon({
    className: `vessel vessel-stopped${isLive ? "" : " vessel-cached"}`,
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -9 18 18" width="16" height="16"><circle cx="0" cy="0" r="6" fill="${fill}" stroke="white" stroke-width="1.8"/></svg>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function formatCacheAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m > 0) return `${m}m ${r}s ago`;
  return `${s}s ago`;
}

function buildPopup(v) {
  const root = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = vesselLabel(v);
  root.appendChild(title);

  const lines = [];
  if (typeof v.speedGround === "number") {
    lines.push(`${v.speedGround.toFixed(1)} km/h`);
  }
  if (v.isMoving && typeof v.courseGround === "number") {
    lines.push(`${Math.round(v.courseGround)}°`);
  }
  if (typeof v.length === "number" && v.length > 0) {
    const beam = typeof v.beam === "number" && v.beam > 0 ? v.beam.toFixed(0) : "?";
    lines.push(`${v.length.toFixed(0)} × ${beam} m`);
  }
  if (v.isrsPositionName) {
    lines.push(`@ ${v.isrsPositionName}`);
  }
  if (v.lastSeen && !v.isLive) {
    lines.push(`cached ${formatCacheAge(Date.now() - v.lastSeen)}`);
  }

  const meta = document.createElement("div");
  meta.style.fontSize = "12px";
  meta.style.color = "#555";
  meta.style.marginTop = "2px";
  meta.textContent = lines.join(" · ");
  root.appendChild(meta);
  return root;
}

function renderVessel(v) {
  if (typeof v.lat !== "number" || typeof v.lon !== "number") return;
  const live = !!v.isLive;
  const icon = v.isMoving
    ? makeArrowIcon(v.courseGround ?? 0, v.speedGround ?? 0, live)
    : makeStoppedIcon(live);
  if (v.marker) {
    v.marker.setLatLng([v.lat, v.lon]);
    v.marker.setIcon(icon);
  } else {
    v.marker = L.marker([v.lat, v.lon], { icon }).addTo(map);
  }
  v.marker.bindPopup(buildPopup(v));
}

function clipRectToBounds(rect, bounds) {
  const minLat = Math.max(rect.minLat, bounds.getSouth());
  const maxLat = Math.min(rect.maxLat, bounds.getNorth());
  const minLng = Math.max(rect.minLng, bounds.getWest());
  const maxLng = Math.min(rect.maxLng, bounds.getEast());
  if (minLat >= maxLat || minLng >= maxLng) return null;
  return { minLat, maxLat, minLng, maxLng };
}

function clippedKey(c) {
  const r = (n) => n.toFixed(4);
  return `${r(c.minLat)},${r(c.maxLat)},${r(c.minLng)},${r(c.maxLng)}`;
}

async function fetchRectangle(rect, clipped) {
  const prev = rectState.get(rect.index) ?? {};
  if (prev.inFlight) prev.inFlight.abort();
  const ctrl = new AbortController();
  rectState.set(rect.index, { ...prev, inFlight: ctrl });

  const params = new URLSearchParams({
    minLat: clipped.minLat,
    maxLat: clipped.maxLat,
    minLng: clipped.minLng,
    maxLng: clipped.maxLng,
  });
  try {
    const r = await fetch(`/api/tracks?${params}`, { signal: ctrl.signal });
    if (!r.ok) {
      console.warn(`EuRIS rect ${rect.index} -> ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (e) {
    if (e.name !== "AbortError") console.warn(`EuRIS rect ${rect.index} error:`, e);
    return [];
  }
}

async function fetchVisibleRectangles({ force = false } = {}) {
  if (rectangles.length === 0) return;
  const bounds = map.getBounds();
  const now = Date.now();
  const tasks = [];

  for (const rect of rectangles) {
    const clipped = clipRectToBounds(rect, bounds);
    if (!clipped) continue;
    const st = rectState.get(rect.index) ?? {};
    const key = clippedKey(clipped);
    const tooSoon =
      !force &&
      st.lastFetchedAt &&
      now - st.lastFetchedAt < FETCH_MIN_INTERVAL_MS &&
      st.lastClippedKey === key;
    if (tooSoon) continue;
    tasks.push(
      fetchRectangle(rect, clipped).then((tracks) => {
        const cur = rectState.get(rect.index) ?? {};
        rectState.set(rect.index, {
          ...cur,
          lastFetchedAt: Date.now(),
          lastClippedKey: key,
          inFlight: null,
        });
        return tracks;
      })
    );
  }

  if (tasks.length === 0) {
    pruneAndRender(null);
    return;
  }

  const results = await Promise.allSettled(tasks);
  const liveIds = new Set();
  let totalTracks = 0;
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const t of res.value) {
      if (!t.trackId) continue;
      liveIds.add(t.trackId);
      totalTracks++;
      const v = vessels.get(t.trackId) ?? { trackId: t.trackId, marker: null };
      Object.assign(v, t, { lastSeen: Date.now() });
      vessels.set(t.trackId, v);
    }
  }
  pollStats.rounds++;
  pollStats.lastTracks = totalTracks;
  console.info(
    `EuRIS: ${totalTracks} tracks across ${tasks.length} rect(s) (round #${pollStats.rounds})`
  );
  pruneAndRender(liveIds);
}

function pruneAndRender(liveIds) {
  const now = Date.now();
  for (const [id, v] of vessels) {
    if (now - (v.lastSeen ?? 0) > VESSEL_TTL_MS) {
      if (v.marker) map.removeLayer(v.marker);
      vessels.delete(id);
      continue;
    }
    if (liveIds) v.isLive = liveIds.has(id);
    renderVessel(v);
  }
  if (vesselsTabActive) renderVesselList();
}

function scheduleFetch() {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => fetchVisibleRectangles(), FETCH_DEBOUNCE_MS);
}

function panToVessel(v) {
  if (typeof v.lat !== "number" || typeof v.lon !== "number") return;
  map.setView([v.lat, v.lon], 13, { animate: false });
  if (v.marker) v.marker.openPopup();
}

function buildVesselListItem(v) {
  const li = document.createElement("li");
  li.className = "vessel-item" + (v.isLive ? "" : " cached");

  const header = document.createElement("div");
  header.className = "vessel-header";

  const title = document.createElement("h3");
  title.className = "vessel-title";
  title.textContent = vesselLabel(v);
  header.appendChild(title);

  if (typeof v.speedGround === "number") {
    const speed = document.createElement("span");
    speed.className = "vessel-speed";
    speed.textContent = `${v.speedGround.toFixed(1)} km/h`;
    header.appendChild(speed);
  }
  li.appendChild(header);

  const meta = document.createElement("p");
  meta.className = "vessel-meta";

  if (typeof v.rkm === "number") {
    const km = document.createElement("span");
    km.className = "vessel-km";
    km.textContent = `km ${Math.round(v.rkm)}`;
    meta.appendChild(km);
  }

  const parts = [];
  if (v.isMoving && typeof v.courseGround === "number") {
    parts.push(`${Math.round(v.courseGround)}°`);
  } else if (!v.isMoving) {
    parts.push("stopped");
  }
  if (v.lastSeen) {
    parts.push(new Date(v.lastSeen).toLocaleTimeString());
  }
  if (parts.length > 0) {
    if (meta.childNodes.length > 0) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(document.createTextNode(parts.join(" · ")));
  }

  if (!v.isLive && v.lastSeen) {
    const badge = document.createElement("span");
    badge.className = "cached-badge";
    badge.textContent = `cached ${formatCacheAge(Date.now() - v.lastSeen)}`;
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(badge);
  }

  li.appendChild(meta);

  li.addEventListener("click", () => panToVessel(v));
  return li;
}

function vesselMatchesFilter(v) {
  if (vesselFilter.size === 0) return true;
  if (v.isMoving && vesselFilter.has("underway")) return true;
  if (!v.isMoving && vesselFilter.has("stopped")) return true;
  return false;
}

function renderVesselList() {
  const ul = document.getElementById("vessel-list");
  if (!ul) return;

  let list = [...vessels.values()].filter(vesselMatchesFilter);
  for (const v of list) v.rkm = vesselRkm(v) ?? null;
  list.sort((a, b) => {
    const ar = typeof a.rkm === "number" ? a.rkm : Infinity;
    const br = typeof b.rkm === "number" ? b.rkm : Infinity;
    return ar - br;
  });

  if (list.length === 0) {
    const empty = document.createElement("li");
    empty.className = "list-empty";
    empty.textContent =
      vessels.size === 0
        ? "No vessels in cache yet."
        : "No vessels match this filter.";
    ul.replaceChildren(empty);
    return;
  }
  ul.replaceChildren(...list.map(buildVesselListItem));
}

function buildVesselFilterBar() {
  const container = document.getElementById("vessel-filters");
  if (!container || container.childNodes.length > 0) return;
  const states = [
    { key: "underway", label: "Underway" },
    { key: "stopped", label: "Stopped" },
  ];
  for (const s of states) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-pill";
    btn.textContent = s.label;
    btn.setAttribute("aria-pressed", "false");
    btn.addEventListener("click", () => {
      const wasActive = vesselFilter.has(s.key);
      if (wasActive) vesselFilter.delete(s.key);
      else vesselFilter.add(s.key);
      btn.classList.toggle("active", !wasActive);
      btn.setAttribute("aria-pressed", String(!wasActive));
      renderVesselList();
    });
    container.appendChild(btn);
  }
}

function setActiveTab(name) {
  vesselsTabActive = name === "vessels";
  document.getElementById("lock-list").hidden = vesselsTabActive;
  document.getElementById("lock-filters").hidden = vesselsTabActive;
  document.getElementById("vessel-list").hidden = !vesselsTabActive;
  document.getElementById("vessel-filters").hidden = !vesselsTabActive;
  const locksTab = document.getElementById("tab-locks");
  const vesselsTab = document.getElementById("tab-vessels");
  locksTab.classList.toggle("active", !vesselsTabActive);
  locksTab.setAttribute("aria-selected", String(!vesselsTabActive));
  vesselsTab.classList.toggle("active", vesselsTabActive);
  vesselsTab.setAttribute("aria-selected", String(vesselsTabActive));

  if (vesselListTimer) {
    clearInterval(vesselListTimer);
    vesselListTimer = null;
  }
  if (vesselsTabActive) {
    renderVesselList();
    vesselListTimer = setInterval(renderVesselList, VESSEL_LIST_REFRESH_MS);
  }
}

// ---------- River path (ordered source→mouth) ----------

const SOURCE_LNG_LAT = [8.5174, 47.95]; // Donaueschingen

function havKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function buildOrderedDanubePath(riverGeo, thresholdKm = 25) {
  const feature = riverGeo.features[0];
  const segs = feature.geometry.coordinates.map((s) => s.slice());

  // Find segment endpoint closest to the source. Reverse that seg so source side is at index 0.
  let bestIdx = -1;
  let bestEnd = "head";
  let bestDist = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const dHead = havKm(segs[i][0], SOURCE_LNG_LAT);
    const dTail = havKm(segs[i][segs[i].length - 1], SOURCE_LNG_LAT);
    if (dHead < bestDist) {
      bestDist = dHead;
      bestIdx = i;
      bestEnd = "head";
    }
    if (dTail < bestDist) {
      bestDist = dTail;
      bestIdx = i;
      bestEnd = "tail";
    }
  }
  if (bestIdx < 0) return { orderedPath: [], totalKm: 0 };

  const used = new Set([bestIdx]);
  let firstSeg = segs[bestIdx];
  if (bestEnd === "tail") firstSeg = firstSeg.slice().reverse();
  let pathLngLat = firstSeg.slice();

  // Greedy: at each step, find unused seg whose nearest endpoint is closest to current tail.
  while (used.size < segs.length) {
    const tail = pathLngLat[pathLngLat.length - 1];
    let nextIdx = -1;
    let nextDist = Infinity;
    let nextReverse = false;
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      const seg = segs[i];
      const dHead = havKm(seg[0], tail);
      const dTail = havKm(seg[seg.length - 1], tail);
      if (dHead < nextDist) {
        nextDist = dHead;
        nextIdx = i;
        nextReverse = false;
      }
      if (dTail < nextDist) {
        nextDist = dTail;
        nextIdx = i;
        nextReverse = true;
      }
    }
    if (nextIdx < 0 || nextDist > thresholdKm) break;
    used.add(nextIdx);
    let seg = segs[nextIdx];
    if (nextReverse) seg = seg.slice().reverse();
    // Skip duplicate joining vertex if essentially the same point (<5 m)
    if (havKm(tail, seg[0]) < 0.005) seg = seg.slice(1);
    pathLngLat = pathLngLat.concat(seg);
  }

  // Compute cumulative km, build {lat, lng, km} array.
  const orderedPath = new Array(pathLngLat.length);
  let cum = 0;
  orderedPath[0] = { lat: pathLngLat[0][1], lng: pathLngLat[0][0], km: 0 };
  for (let i = 1; i < pathLngLat.length; i++) {
    cum += havKm(pathLngLat[i - 1], pathLngLat[i]);
    orderedPath[i] = {
      lat: pathLngLat[i][1],
      lng: pathLngLat[i][0],
      km: cum,
    };
  }
  return { orderedPath, totalKm: cum };
}

// Initial-bearing from latLng A to latLng B in degrees clockwise from north.
function bearingDeg(a, b) {
  const phi1 = (a[0] * Math.PI) / 180;
  const phi2 = (b[0] * Math.PI) / 180;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Walk distanceKm from [lat,lng] along an initial bearing, return the new [lat,lng].
function offsetLatLng(lat, lng, distanceKm, bearingDegFromNorth) {
  const R = 6371;
  const brng = (bearingDegFromNorth * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const d = distanceKm / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) +
      Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI];
}

function coordAtKm(orderedPath, km) {
  if (orderedPath.length === 0) return [0, 0];
  const total = orderedPath[orderedPath.length - 1].km;
  const target = Math.max(0, Math.min(total, km));
  // Binary search for the first index whose km >= target.
  let lo = 0;
  let hi = orderedPath.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orderedPath[mid].km < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return [orderedPath[0].lat, orderedPath[0].lng];
  const a = orderedPath[lo - 1];
  const b = orderedPath[lo];
  const span = b.km - a.km;
  const t = span > 0 ? (target - a.km) / span : 0;
  return [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t];
}

// Calibrate kilometrierung markers against the orderedPath: for each marker, find
// its closest point on the path and remember that point's pathKm. The result is a
// sorted (rkm, pathKm) lookup table that lets us map the slider's official rkm to
// a precise position on the rendered river polyline.
function buildRkmAnchors(orderedPath, markers) {
  // Grid index on path points for O(1) nearest-point lookup.
  const CELL = 0.1; // degrees ≈ 11 km lat / ~7 km lng at 50°N
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 10000 + cy;
  for (let i = 0; i < orderedPath.length; i++) {
    const p = orderedPath[i];
    const k = cellKey(Math.floor(p.lng / CELL), Math.floor(p.lat / CELL));
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(i);
  }

  const anchors = [];
  for (const m of markers) {
    const cx = Math.floor(m.lon / CELL);
    const cy = Math.floor(m.lat / CELL);
    let best = Infinity;
    let bestKm = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const arr = grid.get(cellKey(cx + dx, cy + dy));
        if (!arr) continue;
        for (const i of arr) {
          const p = orderedPath[i];
          const d = havKm([m.lon, m.lat], [p.lng, p.lat]);
          if (d < best) {
            best = d;
            bestKm = p.km;
          }
        }
      }
    }
    anchors.push({ rkm: m.rkm, pathKm: bestKm });
  }
  anchors.sort((a, b) => a.rkm - b.rkm);
  // Drop anchors that violate monotonicity vs path direction. Path runs source→mouth
  // (pathKm 0 → totalKm). Rkm runs mouth→source (rkm 0 → 2811). So as rkm increases,
  // pathKm should decrease. Walk in rkm order and keep the longest non-increasing
  // pathKm subsequence (greedy: drop any anchor that breaks monotonicity).
  const cleaned = [];
  for (const a of anchors) {
    while (
      cleaned.length > 0 &&
      cleaned[cleaned.length - 1].pathKm < a.pathKm
    ) {
      cleaned.pop();
    }
    cleaned.push(a);
  }
  return cleaned;
}

function rkmToPathKm(anchors, rkm) {
  if (anchors.length === 0) return 0;
  if (rkm <= anchors[0].rkm) return anchors[0].pathKm;
  if (rkm >= anchors[anchors.length - 1].rkm)
    return anchors[anchors.length - 1].pathKm;
  let lo = 0;
  let hi = anchors.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].rkm < rkm) lo = mid + 1;
    else hi = mid;
  }
  const a = anchors[lo - 1];
  const b = anchors[lo];
  const span = b.rkm - a.rkm;
  const t = span > 0 ? (rkm - a.rkm) / span : 0;
  return a.pathKm + (b.pathKm - a.pathKm) * t;
}

// ---------- Init ----------

function padBoundsKm(bounds, kmEachSide) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const latPad = kmEachSide / 111;
  const midLat = (south + north) / 2;
  const lngPad = kmEachSide / (111 * Math.cos((midLat * Math.PI) / 180));
  return L.latLngBounds(
    [south - latPad, west - lngPad],
    [north + latPad, east + lngPad]
  );
}

async function init() {
  const [riverGeo, locksDoc, kmDoc, rectanglesDoc] = await Promise.all([
    fetch("/data/danube.geojson").then((r) => r.json()),
    fetch("/data/danube_locks.json").then((r) => r.json()),
    fetch("/data/danube_kilometrierung.json").then((r) => r.json()),
    fetch("/data/danube_rectangles.json").then((r) => r.json()),
  ]);

  const riverLayer = L.geoJSON(riverGeo, {
    style: { color: "#1e6fb8", weight: 2.5, opacity: 0.9 },
  }).addTo(map);

  rectangles = rectanglesDoc.rectangles;
  const rectDebugLayer = L.featureGroup().addTo(map);
  for (const rect of rectangles) {
    L.rectangle(
      [
        [rect.minLat, rect.minLng],
        [rect.maxLat, rect.maxLng],
      ],
      {
        color: "#9333ea",
        weight: 1,
        opacity: 0.55,
        dashArray: "4 4",
        fill: false,
        interactive: false,
      }
    ).addTo(rectDebugLayer);
  }
  console.info(`Rectangles: ${rectangles.length} debug tiles rendered`);

  const paddedBounds = padBoundsKm(riverLayer.getBounds(), 50);
  map.setMaxBounds(paddedBounds);
  map.setMinZoom(map.getBoundsZoom(paddedBounds));
  map.fitBounds(paddedBounds, { animate: false });

  const HomeControl = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const container = L.DomUtil.create("div", "leaflet-bar leaflet-control");
      const btn = L.DomUtil.create("a", "leaflet-control-home", container);
      btn.href = "#";
      btn.title = "Fit to entire Danube";
      btn.setAttribute("role", "button");
      btn.setAttribute("aria-label", "Fit map to entire Danube");
      const icon = document.createElement("i");
      icon.className = "fa-solid fa-house";
      btn.appendChild(icon);
      L.DomEvent.on(btn, "click", (e) => {
        L.DomEvent.preventDefault(e);
        map.fitBounds(paddedBounds, { animate: false });
      });
      return container;
    },
  });
  new HomeControl().addTo(map);

  const { orderedPath, totalKm } = buildOrderedDanubePath(riverGeo);
  console.info(
    `Ordered Danube path: ${totalKm.toFixed(0)} km from ${orderedPath.length} points`
  );

  const rkmAnchors = buildRkmAnchors(orderedPath, kmDoc.markers);
  console.info(
    `Kilometrierung: ${kmDoc.markers.length} markers, ${rkmAnchors.length} usable anchors after monotonicity filter (rkm ${rkmAnchors[0].rkm} → ${rkmAnchors[rkmAnchors.length - 1].rkm})`
  );

  // Spatial grid over orderedPath for nearest-vertex lookup. Used by vesselRkm
  // to map any (lat, lng) to a river kilometer via the orderedPath + rkmAnchors.
  const PATH_CELL = 0.1;
  const pathCellKey = (cx, cy) => cx * 10000 + cy;
  const pathGrid = new Map();
  for (let i = 0; i < orderedPath.length; i++) {
    const p = orderedPath[i];
    const k = pathCellKey(
      Math.floor(p.lng / PATH_CELL),
      Math.floor(p.lat / PATH_CELL)
    );
    let arr = pathGrid.get(k);
    if (!arr) {
      arr = [];
      pathGrid.set(k, arr);
    }
    arr.push(i);
  }

  function findNearestPathKm(lat, lng) {
    const cx = Math.floor(lng / PATH_CELL);
    const cy = Math.floor(lat / PATH_CELL);
    let best = Infinity;
    let bestKm = null;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const arr = pathGrid.get(pathCellKey(cx + dx, cy + dy));
        if (!arr) continue;
        for (const i of arr) {
          const p = orderedPath[i];
          const d = havKm([lng, lat], [p.lng, p.lat]);
          if (d < best) {
            best = d;
            bestKm = p.km;
          }
        }
      }
    }
    return bestKm;
  }

  // Inverse of rkmToPathKm. Anchors are sorted ascending by rkm with
  // monotonically decreasing pathKm (path runs source→mouth, rkm runs mouth→source).
  function pathKmToRkm(pathKm) {
    if (rkmAnchors.length === 0) return null;
    if (pathKm >= rkmAnchors[0].pathKm) return rkmAnchors[0].rkm;
    const last = rkmAnchors[rkmAnchors.length - 1];
    if (pathKm <= last.pathKm) return last.rkm;
    let lo = 0;
    let hi = rkmAnchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rkmAnchors[mid].pathKm >= pathKm) lo = mid;
      else hi = mid - 1;
    }
    const a = rkmAnchors[lo];
    const b = rkmAnchors[lo + 1];
    if (!b) return a.rkm;
    const span = a.pathKm - b.pathKm;
    const t = span > 0 ? (a.pathKm - pathKm) / span : 0;
    return a.rkm + (b.rkm - a.rkm) * t;
  }

  vesselRkm = (v) => {
    if (typeof v.lat !== "number" || typeof v.lon !== "number") return null;
    const pathKm = findNearestPathKm(v.lat, v.lon);
    if (pathKm == null) return null;
    return pathKmToRkm(pathKm);
  };

  sliderEl.min = "0";
  sliderEl.max = String(Math.round(kmDoc.rkm_max));
  if (Number(sliderEl.value) > Number(sliderEl.max)) {
    sliderEl.value = String(Math.round(Number(sliderEl.max) / 2));
  }

  const initialKm = Number(sliderEl.value);
  const [lat0, lng0] = coordAtKm(orderedPath, rkmToPathKm(rkmAnchors, initialKm));
  const riverDot = L.circleMarker([lat0, lng0], {
    radius: 6,
    color: "#ffffff",
    weight: 2,
    fillColor: "#e53935",
    fillOpacity: 1,
    interactive: false,
  }).addTo(map);
  sliderValueEl.textContent = String(initialKm);

  // ---------- Map rotation toggle ----------

  const ROT_MODES = ["north", "downstream", "upstream"];
  let rotationMode = "north";
  const rotationToggleEl = document.getElementById("rotation-toggle");

  // Debug overlay: arrow showing the A→B vector used for the rotation calc.
  // A = orderedPath vertex closest to the current centered km.
  // B = the immediately adjacent vertex in the chosen direction (next downstream
  //     or previous upstream).
  const DEBUG_VECTOR_STYLE = {
    color: "#d500f9",
    weight: 3,
    opacity: 0.95,
    interactive: false,
  };
  let debugShaft = null;
  let debugHead = null;

  function nearestPathIndex(pathKm) {
    let lo = 0;
    let hi = orderedPath.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (orderedPath[mid].km < pathKm) lo = mid + 1;
      else hi = mid;
    }
    if (
      lo > 0 &&
      Math.abs(orderedPath[lo - 1].km - pathKm) <
        Math.abs(orderedPath[lo].km - pathKm)
    ) {
      return lo - 1;
    }
    return lo;
  }

  function getDebugVectorEnds(pathKm) {
    const i = nearestPathIndex(pathKm);
    let j;
    if (rotationMode === "upstream") {
      j = i > 0 ? i - 1 : Math.min(orderedPath.length - 1, i + 1);
    } else {
      // north and downstream both sample forward (next vertex).
      j =
        i < orderedPath.length - 1
          ? i + 1
          : Math.max(0, i - 1);
    }
    const A = [orderedPath[i].lat, orderedPath[i].lng];
    const B = [orderedPath[j].lat, orderedPath[j].lng];
    return { A, B, bearing: bearingDeg(A, B) };
  }

  function updateDebugVector() {
    const pathKm = rkmToPathKm(rkmAnchors, Number(sliderEl.value));
    const { A, B, bearing } = getDebugVectorEnds(pathKm);
    const shaftKm = havKm([A[1], A[0]], [B[1], B[0]]);
    const wingSize = Math.max(0.03, shaftKm * 0.4); // ≥30 m, scaled to shaft
    const wingLeft = offsetLatLng(
      B[0],
      B[1],
      wingSize,
      (bearing + 180 - 30 + 360) % 360
    );
    const wingRight = offsetLatLng(
      B[0],
      B[1],
      wingSize,
      (bearing + 180 + 30) % 360
    );
    if (!debugShaft) {
      debugShaft = L.polyline([A, B], DEBUG_VECTOR_STYLE).addTo(map);
      debugHead = L.polyline(
        [wingLeft, B, wingRight],
        DEBUG_VECTOR_STYLE
      ).addTo(map);
    } else {
      debugShaft.setLatLngs([A, B]);
      debugHead.setLatLngs([wingLeft, B, wingRight]);
    }
  }

  function applyRotation() {
    const pathKm = rkmToPathKm(rkmAnchors, Number(sliderEl.value));
    const { bearing } = getDebugVectorEnds(pathKm);
    let deg = 0;
    if (rotationMode === "downstream") {
      // leaflet-rotate's setBearing(R) rotates content visually CW by R, so
      // compass-direction C ends up at screen-bearing (C + R) mod 360.
      // Put downstream (compass `bearing`) at screen-right (90°): R = 90 - bearing.
      deg = (90 - bearing + 360) % 360;
    } else if (rotationMode === "upstream") {
      // bearing here is the upstream compass direction (sampled backward).
      // Put it at screen-left (270°): R = 270 - bearing.
      deg = (270 - bearing + 360) % 360;
    }
    map.setBearing(deg);
    rotationToggleEl.textContent = rotationMode;
    rotationToggleEl.dataset.mode = rotationMode;
    updateDebugVector();
  }

  rotationToggleEl.addEventListener("click", () => {
    const i = ROT_MODES.indexOf(rotationMode);
    rotationMode = ROT_MODES[(i + 1) % ROT_MODES.length];
    applyRotation();
  });

  function applySliderKm(sliderKm) {
    const [lat, lng] = coordAtKm(orderedPath, rkmToPathKm(rkmAnchors, sliderKm));
    map.panTo([lat, lng], { animate: false });
    riverDot.setLatLng([lat, lng]);
    sliderValueEl.textContent = String(sliderKm);
    applyRotation();
    updateZoomDebug();
  }

  sliderEl.addEventListener("input", (e) =>
    applySliderKm(Number(e.target.value))
  );

  applyRotation();

  updateZoomDebug();

  const lockList = document.getElementById("lock-list");
  const lockItems = []; // [{ li, countries: Set<string> }]
  let activeItem = null;

  for (const lock of locksDoc.locks) {
    const displayName = lock.name ?? lock.name_en;

    const popupEl = document.createElement("strong");
    popupEl.textContent = displayName;

    const marker = L.marker([lock.latitude, lock.longitude])
      .bindPopup(popupEl)
      .addTo(map);

    const li = document.createElement("li");
    li.className = "lock-item";

    const header = document.createElement("div");
    header.className = "lock-header";

    const title = document.createElement("h3");
    title.className = "lock-title";
    title.textContent = displayName;
    header.appendChild(title);

    const isos = lock.country_iso.split("/").map((c) => c.toLowerCase());
    const flags = document.createElement("span");
    flags.className = "lock-flags";
    for (const iso of isos) {
      const flag = document.createElement("span");
      flag.className = `fi fi-${iso}`;
      flag.title = iso.toUpperCase();
      flags.appendChild(flag);
    }
    header.appendChild(flags);
    li.appendChild(header);

    const meta = document.createElement("p");
    meta.className = "lock-meta";
    meta.textContent = `km ${Math.floor(lock.river_km)}`;
    li.appendChild(meta);

    li.addEventListener("click", () => {
      if (activeItem) activeItem.classList.remove("active");
      li.classList.add("active");
      activeItem = li;

      const rkm = Math.round(lock.river_km);
      sliderEl.value = String(rkm);
      sliderValueEl.textContent = String(rkm);
      const [dotLat, dotLng] = coordAtKm(
        orderedPath,
        rkmToPathKm(rkmAnchors, rkm)
      );
      riverDot.setLatLng([dotLat, dotLng]);

      map.setView([lock.latitude, lock.longitude], 13, { animate: false });
      marker.openPopup();
      applyRotation();
      updateZoomDebug();
    });
    lockList.appendChild(li);
    lockItems.push({ li, countries: new Set(isos) });
  }

  // Build country filter pills (multi-select; empty = show all).
  const lockFilter = new Set();
  const lockFilterBar = document.getElementById("lock-filters");
  let lockEmptyEl = null;

  function applyLockFilter() {
    let visible = 0;
    for (const item of lockItems) {
      let show = lockFilter.size === 0;
      if (!show) {
        for (const c of item.countries) {
          if (lockFilter.has(c)) {
            show = true;
            break;
          }
        }
      }
      item.li.hidden = !show;
      if (show) visible++;
    }
    if (lockEmptyEl) {
      lockEmptyEl.remove();
      lockEmptyEl = null;
    }
    if (visible === 0 && lockFilter.size > 0) {
      lockEmptyEl = document.createElement("li");
      lockEmptyEl.className = "list-empty";
      lockEmptyEl.textContent = "No locks match this filter.";
      lockList.appendChild(lockEmptyEl);
    }
  }

  const allCountries = new Set();
  for (const item of lockItems) for (const c of item.countries) allCountries.add(c);
  for (const iso of [...allCountries].sort()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-pill";
    btn.title = iso.toUpperCase();
    btn.setAttribute("aria-label", iso.toUpperCase());
    btn.setAttribute("aria-pressed", "false");
    const flag = document.createElement("span");
    flag.className = `fi fi-${iso}`;
    btn.appendChild(flag);
    btn.addEventListener("click", () => {
      const wasActive = lockFilter.has(iso);
      if (wasActive) lockFilter.delete(iso);
      else lockFilter.add(iso);
      btn.classList.toggle("active", !wasActive);
      btn.setAttribute("aria-pressed", String(!wasActive));
      applyLockFilter();
    });
    lockFilterBar.appendChild(btn);
  }

  buildVesselFilterBar();

  document.getElementById("tab-locks").addEventListener("click", () =>
    setActiveTab("locks")
  );
  document.getElementById("tab-vessels").addEventListener("click", () =>
    setActiveTab("vessels")
  );

  map.on("moveend", scheduleFetch);
  scheduleFetch();
  pollTimer = setInterval(
    () => fetchVisibleRectangles({ force: true }),
    POLL_MS
  );
}

init().catch((err) => {
  console.error("Failed to initialize map:", err);
});
