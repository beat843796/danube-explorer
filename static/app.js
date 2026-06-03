const map = L.map("map", {
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
const kmInputEl = document.getElementById("km-input");
const kmGoBtn = document.getElementById("km-go");

const KM_MIN = 0;
const KM_MAX = 2811;

function updateZoomDebug() {
  if (!zoomDebugEl) return;
  const z = map.getZoom();
  zoomDebugEl.textContent =
    typeof z === "number" ? `zoom ${z.toFixed(2)}` : "zoom —";
}
map.on("zoom zoomend move", updateZoomDebug);

function isValidKmInput(text) {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return false;
  const n = Number(t);
  return n >= KM_MIN && n <= KM_MAX;
}

function validateKmInput() {
  const ok = isValidKmInput(kmInputEl.value);
  kmInputEl.classList.toggle("invalid", !ok);
  kmGoBtn.disabled = !ok;
  return ok;
}

let setKm = () => {};

// ---------- Vessels (EuRIS REST, per-rectangle fetching) ----------

const FETCH_DEBOUNCE_MS = 500;
const POLL_MS = 30_000;
const FETCH_MIN_INTERVAL_MS = 5_000;
const VESSEL_CACHED_AFTER_MS = 35_000;  // older than this → rendered grey
const VESSEL_TTL_MS = 3 * 60_000;       // older than this → removed entirely
const PRUNE_INTERVAL_MS = 5_000;        // periodic re-evaluation of cached/TTL state

const vessels = new Map();    // trackId -> { ...track, marker }
const rectState = new Map();  // rectIdx -> { lastFetchedAt, lastClippedKey, inFlight }
let vesselFilter = "moving";  // "all" | "moving" | "stopped"
let rectangles = [];          // [{index, minLat, maxLat, minLng, maxLng}]
let fetchTimer = null;
let pollTimer = null;
let vesselsTabActive = false;
let vesselRkm = () => null;   // (v) -> river km (set in init once orderedPath is ready)
let vesselDirection = () => null; // (v) -> "upstream" | "downstream" | null
let refreshActiveLockEta = () => {};
let debugMode = false;
let rectDebugLayer = null;

function vesselLabel(v) {
  if (v.name && !/^Track \d+$/.test(v.name)) return v.name;
  if (v.callSign) return v.callSign;
  return `Track ${v.trackId}`;
}

function makeMovingIcon(courseGround, speedKmh, withSpeedLine, fillColor) {
  const fill = fillColor || "#e8590c";
  const w = 9;   // base width / beam (px)
  const h = 18;  // length (px)
  const speed = Math.max(0, typeof speedKmh === "number" ? speedKmh : 0);
  const lineLen = withSpeedLine ? Math.min(60, speed * 1.5) : 0;
  const vb = Math.ceil(Math.max(28, h + lineLen + 6));
  const halfW = w / 2;
  const halfH = h / 2;
  const bowTipY = -halfH;
  const lineEndY = bowTipY - lineLen;
  const points = [
    `0,${bowTipY}`,
    `${halfW},${halfH}`,
    `${-halfW},${halfH}`,
  ].join(" ");
  const html =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-vb / 2} ${-vb / 2} ${vb} ${vb}" width="${vb}" height="${vb}" style="transform: rotate(${courseGround}deg)">` +
    (lineLen > 0
      ? `<line x1="0" y1="${bowTipY}" x2="0" y2="${lineEndY}" stroke="${fill}" stroke-width="2" stroke-linecap="round" opacity="0.75"/>`
      : "") +
    `<polygon points="${points}" fill="${fill}" stroke="white" stroke-width="1.4" stroke-linejoin="round"/>` +
    `</svg>`;
  return L.divIcon({
    className: "vessel vessel-moving",
    html,
    iconSize: [vb, vb],
    iconAnchor: [vb / 2, vb / 2],
  });
}

function makeStoppedIcon(fillColor) {
  const fill = fillColor || "#1c4d80";
  return L.divIcon({
    className: "vessel vessel-stopped",
    html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-9 -9 18 18" width="16" height="16"><circle cx="0" cy="0" r="6" fill="${fill}" stroke="white" stroke-width="1.8"/></svg>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function buildPopup(v, dir) {
  const root = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = vesselLabel(v);
  root.appendChild(title);

  const lines = [];
  if (typeof v.speedGround === "number") {
    lines.push(`${v.speedGround.toFixed(1)} km/h`);
  }
  if (v.isMoving) {
    if (dir) lines.push(dir);
    if (typeof v.courseGround === "number") {
      lines.push(`${Math.round(v.courseGround)}°`);
    }
  }
  if (typeof v.length === "number" && v.length > 0) {
    const beam = typeof v.beam === "number" && v.beam > 0 ? v.beam.toFixed(0) : "?";
    lines.push(`${v.length.toFixed(0)} × ${beam} m`);
  }
  if (v.isrsPositionName) {
    lines.push(`@ ${v.isrsPositionName}`);
  }

  const meta = document.createElement("div");
  meta.style.fontSize = "12px";
  meta.style.color = "#555";
  meta.style.marginTop = "2px";
  meta.textContent = lines.join(" · ");
  root.appendChild(meta);
  return root;
}

function vesselTooltipText(v, dir) {
  const details = [];
  if (v.isMoving) {
    if (dir) details.push(dir);
  } else {
    details.push("stopped");
  }
  if (typeof v.speedGround === "number") {
    details.push(`${Math.round(v.speedGround)} km/h`);
  }
  return details.length
    ? `${vesselLabel(v)} · ${details.join(" · ")}`
    : vesselLabel(v);
}

function setMarkerVisibility(v) {
  if (!v.marker) return;
  const show = vesselMatchesFilter(v);
  if (show && !map.hasLayer(v.marker)) v.marker.addTo(map);
  else if (!show && map.hasLayer(v.marker)) map.removeLayer(v.marker);
}

function renderVessel(v) {
  if (typeof v.lat !== "number" || typeof v.lon !== "number") return;
  const dir = vesselDirection(v);
  const cached = v.isLive === false;
  // Re-render only when an input that drives the visual changes.
  const renderKey = `${v.lat}|${v.lon}|${v.courseGround}|${v.speedGround}|${v.isMoving ? 1 : 0}|${cached ? 1 : 0}|${dir ?? ""}|${debugMode ? 1 : 0}`;
  if (v._renderKey === renderKey && v.marker) {
    setMarkerVisibility(v);
    return;
  }
  v._renderKey = renderKey;
  const liveFill = dir === "downstream" ? "#2f9e44" : "#e8590c";
  const movingFill = cached ? "#7a7a7a" : liveFill;
  const stoppedFill = cached ? "#7a7a7a" : "#1c4d80";
  const icon = v.isMoving
    ? makeMovingIcon(
        v.courseGround ?? 0,
        v.speedGround ?? 0,
        debugMode,
        movingFill
      )
    : makeStoppedIcon(stoppedFill);
  if (!v.marker) {
    v.marker = L.marker([v.lat, v.lon], { icon });
    v.marker.bindTooltip(vesselTooltipText(v, dir), {
      direction: "top",
      offset: [0, -6],
    });
    v.marker.bindPopup(() => buildPopup(v, vesselDirection(v)));
  } else {
    v.marker.setLatLng([v.lat, v.lon]);
    v.marker.setIcon(icon);
    v.marker.setTooltipContent(vesselTooltipText(v, dir));
  }
  setMarkerVisibility(v);
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
    rectIndex: rect.index,
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
        // Render this rectangle's vessels as soon as it lands rather than
        // waiting for the slowest rectangle in the batch.
        const n = mergeAndRenderTracks(tracks);
        scheduleSidebarRefresh();
        return n;
      })
    );
  }

  if (tasks.length === 0) return;

  const results = await Promise.allSettled(tasks);
  const totalTracks = results.reduce(
    (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
    0
  );
  console.info(`EuRIS: ${totalTracks} tracks across ${tasks.length} rect(s)`);
}

function pruneAndRender() {
  const now = Date.now();
  for (const [id, v] of vessels) {
    const age = now - (v.lastSeen ?? 0);
    if (age > VESSEL_TTL_MS) {
      if (v.marker) map.removeLayer(v.marker);
      vessels.delete(id);
      continue;
    }
    v.isLive = age < VESSEL_CACHED_AFTER_MS;
    renderVessel(v);
  }
  if (vesselsTabActive) renderVesselList();
  refreshActiveLockEta();
}

// Merge a single rectangle's tracks into the vessel cache and render just
// those markers right away, for progressive rectangle-by-rectangle fill-in.
// TTL deletion and grey-out of stale vessels stay with the periodic
// pruneAndRender timer.
function mergeAndRenderTracks(tracks) {
  const fetchedAt = Date.now();
  let count = 0;
  for (const t of tracks) {
    if (!t.trackId) continue;
    count++;
    const v = vessels.get(t.trackId) ?? { trackId: t.trackId, marker: null };
    Object.assign(v, t, { lastSeen: fetchedAt });
    v.isLive = true; // just fetched
    vessels.set(t.trackId, v);
    renderVessel(v);
  }
  return count;
}

// Coalesce the sidebar list + lock-ETA refresh during a multi-rectangle load
// so they rebuild at most once per window instead of once per rectangle.
let sidebarRefreshTimer = null;
function scheduleSidebarRefresh() {
  if (sidebarRefreshTimer) return;
  sidebarRefreshTimer = setTimeout(() => {
    sidebarRefreshTimer = null;
    if (vesselsTabActive) renderVesselList();
    refreshActiveLockEta();
  }, 200);
}

function scheduleFetch() {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = setTimeout(() => fetchVisibleRectangles(), FETCH_DEBOUNCE_MS);
}

function panToVessel(v) {
  if (typeof v.lat !== "number" || typeof v.lon !== "number") return;
  const rkm = vesselRkm(v);
  if (typeof rkm === "number") setKm(rkm);
  map.setView([v.lat, v.lon], 13, { animate: false });
  if (v.marker) v.marker.openPopup();
}

function buildVesselListItem(v) {
  const li = document.createElement("li");
  li.className = "vessel-item";

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
  if (v.isMoving) {
    const dir = vesselDirection(v);
    if (dir) parts.push(dir);
    if (typeof v.courseGround === "number") {
      parts.push(`${Math.round(v.courseGround)}°`);
    }
  } else {
    parts.push("stopped");
  }
  if (parts.length > 0) {
    if (meta.childNodes.length > 0) meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(document.createTextNode(parts.join(" · ")));
  }

  li.appendChild(meta);

  li.addEventListener("click", () => panToVessel(v));
  return li;
}

function vesselMatchesFilter(v) {
  if (vesselFilter === "all") return true;
  if (vesselFilter === "moving") return !!v.isMoving;
  if (vesselFilter === "stopped") return !v.isMoving;
  return true;
}

function applyVesselMapFilter() {
  for (const v of vessels.values()) setMarkerVisibility(v);
}

function renderVesselList() {
  const ul = document.getElementById("vessel-list");
  const countEl = document.getElementById("vessel-count");
  if (!ul) return;

  let list = [...vessels.values()].filter(vesselMatchesFilter);
  for (const v of list) v.rkm = vesselRkm(v) ?? null;
  list.sort((a, b) => {
    const ar = typeof a.rkm === "number" ? a.rkm : Infinity;
    const br = typeof b.rkm === "number" ? b.rkm : Infinity;
    return ar - br;
  });

  if (countEl) {
    const n = list.length;
    countEl.textContent = `${n} vessel${n === 1 ? "" : "s"}`;
  }

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
  if (!container) return;
  const countEl = container.querySelector("#vessel-count");
  if (container.querySelector(".filter-pill")) return;
  const states = [
    { key: "all", label: "All" },
    { key: "moving", label: "Moving" },
    { key: "stopped", label: "Stopped" },
  ];
  const btns = [];
  for (const s of states) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "filter-pill";
    btn.textContent = s.label;
    btn.dataset.filter = s.key;
    const isActive = vesselFilter === s.key;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
    btn.addEventListener("click", () => {
      if (vesselFilter === s.key) return;
      vesselFilter = s.key;
      for (const b of btns) {
        const active = b.dataset.filter === vesselFilter;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      }
      applyVesselMapFilter();
      renderVesselList();
    });
    btns.push(btn);
    if (countEl) container.insertBefore(btn, countEl);
    else container.appendChild(btn);
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

  if (vesselsTabActive) renderVesselList();
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
  rectDebugLayer = L.featureGroup();
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
    L.marker([rect.maxLat, rect.minLng], {
      icon: L.divIcon({
        className: "rect-label",
        html: String(rect.index),
        iconSize: [26, 16],
        iconAnchor: [0, 0],
      }),
      interactive: false,
      keyboard: false,
    }).addTo(rectDebugLayer);
  }
  console.info(`Rectangles: ${rectangles.length} debug tiles rendered`);

  const riverBounds = riverLayer.getBounds();
  map.fitBounds(riverBounds, { animate: false });

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
        map.fitBounds(riverBounds, { animate: false });
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

  // Memoized {pathKm, rkm, dir} per vessel. Invalidated when lat/lon/course/
  // isMoving change. Replaces the previous pattern where renderVessel +
  // buildPopup + tooltip + list + selector each recomputed independently.
  function vesselGeo(v) {
    if (
      v._geoLat === v.lat &&
      v._geoLon === v.lon &&
      v._geoCourse === v.courseGround &&
      v._geoIsMoving === v.isMoving
    ) {
      return v._geo;
    }
    v._geoLat = v.lat;
    v._geoLon = v.lon;
    v._geoCourse = v.courseGround;
    v._geoIsMoving = v.isMoving;

    let pathKm = null;
    if (typeof v.lat === "number" && typeof v.lon === "number") {
      pathKm = findNearestPathKm(v.lat, v.lon);
    }
    const rkm =
      typeof v.riverKm === "number"
        ? v.riverKm
        : pathKm == null
        ? null
        : pathKmToRkm(pathKm);

    let dir = null;
    if (
      v.isMoving &&
      typeof v.courseGround === "number" &&
      pathKm != null
    ) {
      const i = nearestPathIndex(pathKm);
      const j =
        i < orderedPath.length - 1
          ? i + 1
          : i > 0
          ? i - 1
          : -1;
      if (j >= 0) {
        const A = [orderedPath[i].lat, orderedPath[i].lng];
        const B = [orderedPath[j].lat, orderedPath[j].lng];
        let downstreamBearing = bearingDeg(A, B);
        // Backward sample at path end — flip 180°.
        if (j < i) downstreamBearing = (downstreamBearing + 180) % 360;
        const diff = Math.abs(
          ((v.courseGround - downstreamBearing + 540) % 360) - 180
        );
        dir = diff < 90 ? "downstream" : "upstream";
      }
    }
    v._geo = { pathKm, rkm, dir };
    return v._geo;
  }

  vesselRkm = (v) => vesselGeo(v).rkm;
  vesselDirection = (v) => vesselGeo(v).dir;

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
    if (!debugMode) {
      if (debugShaft) {
        map.removeLayer(debugShaft);
        map.removeLayer(debugHead);
        debugShaft = null;
        debugHead = null;
      }
      return;
    }
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

  const debugToggleEl = document.getElementById("debug-toggle");
  debugToggleEl.addEventListener("click", () => {
    debugMode = !debugMode;
    debugToggleEl.classList.toggle("active", debugMode);
    debugToggleEl.setAttribute("aria-pressed", String(debugMode));
    if (debugMode) rectDebugLayer.addTo(map);
    else rectDebugLayer.remove();
    applyRotation();
    pruneAndRender();
    updateLockEtaPaths();
  });

  let lastSetKm = NaN;
  setKm = (km, opts = {}) => {
    const sliderMax = Number(sliderEl.max);
    const clamped = Math.max(0, Math.min(sliderMax, Math.round(km)));
    if (clamped === lastSetKm && !opts.pan) return;
    lastSetKm = clamped;
    sliderEl.value = String(clamped);
    sliderValueEl.textContent = String(clamped);
    if (document.activeElement !== kmInputEl) {
      kmInputEl.value = String(clamped);
      validateKmInput();
    }
    const [lat, lng] = coordAtKm(
      orderedPath,
      rkmToPathKm(rkmAnchors, clamped)
    );
    riverDot.setLatLng([lat, lng]);
    if (opts.pan) {
      map.panTo([lat, lng], { animate: false });
    }
    applyRotation();
    updateZoomDebug();
  };

  sliderEl.addEventListener("input", (e) =>
    setKm(Number(e.target.value), { pan: true })
  );

  document.getElementById("river-km-down").addEventListener("click", () => {
    setKm(Number(sliderEl.value) + 1, { pan: true });
  });
  document.getElementById("river-km-up").addEventListener("click", () => {
    setKm(Number(sliderEl.value) - 1, { pan: true });
  });

  kmInputEl.value = String(initialKm);
  validateKmInput();

  kmInputEl.addEventListener("input", validateKmInput);
  kmInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (isValidKmInput(kmInputEl.value)) {
        setKm(Number(kmInputEl.value), { pan: true });
        kmInputEl.blur();
      }
    }
  });
  kmInputEl.addEventListener("blur", () => {
    kmInputEl.value = String(sliderEl.value);
    validateKmInput();
  });
  // mousedown.preventDefault keeps focus on the input so the blur handler
  // doesn't reset kmInputEl.value before this click reads it.
  kmGoBtn.addEventListener("mousedown", (e) => e.preventDefault());
  kmGoBtn.addEventListener("click", () => {
    if (!isValidKmInput(kmInputEl.value)) return;
    setKm(Number(kmInputEl.value), { pan: true });
    kmInputEl.blur();
  });

  applyRotation();

  updateZoomDebug();

  const lockList = document.getElementById("lock-list");
  const lockItems = []; // [{ li, marker, countries: Set<string> }]

  function isAnyLockPopupOpen() {
    for (const it of lockItems) {
      if (it.marker.isPopupOpen()) return true;
    }
    return false;
  }

  function clearLockListSelection() {
    if (activeItem) {
      activeItem.classList.remove("active");
      activeItem = null;
    }
  }
  let activeItem = null;
  let activeLockMarker = null;
  const lockLayer = L.layerGroup();
  const lockEtaLayer = L.layerGroup().addTo(map);
  let lockEtaState = null;
  let activeLockEta = null;

  const sortedLocks = [...locksDoc.locks].sort(
    (a, b) => a.river_km - b.river_km
  );
  const lockOrderIdx = new Map();
  sortedLocks.forEach((l, i) => lockOrderIdx.set(l, i));

  function neighborLocks(lock) {
    const i = lockOrderIdx.get(lock);
    return {
      nextDown: i > 0 ? sortedLocks[i - 1] : null,
      nextUp: i < sortedLocks.length - 1 ? sortedLocks[i + 1] : null,
    };
  }

  function formatEta(hours) {
    const totalMin = Math.max(0, Math.round(hours * 60));
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  }

  function pathSegmentBetweenKm(startKm, endKm) {
    const min = Math.min(startKm, endKm);
    const max = Math.max(startKm, endKm);
    const loIdx = nearestPathIndex(min);
    const hiIdx = nearestPathIndex(max);
    const points = [coordAtKm(orderedPath, min)];
    for (let i = loIdx; i <= hiIdx; i++) {
      const p = orderedPath[i];
      if (p.km > min && p.km < max) points.push([p.lat, p.lng]);
    }
    points.push(coordAtKm(orderedPath, max));
    return points;
  }

  let upLockPolyline = null;
  let downLockPolyline = null;
  let lockEtaPathKey = "";
  const RED = "#d83a3a";
  const GREEN = "#2f9e44";

  function setEtaPolyline(slot, color, latlngs) {
    if (latlngs == null) {
      if (slot) lockEtaLayer.removeLayer(slot);
      return null;
    }
    if (slot) {
      slot.setLatLngs(latlngs);
      return slot;
    }
    return L.polyline(latlngs, {
      color,
      weight: 3,
      opacity: 0.85,
      interactive: false,
    }).addTo(lockEtaLayer);
  }

  function updateLockEtaPaths() {
    const active = debugMode && lockEtaState;
    const { lockRkm, upLockCandidate, downLockCandidate } = lockEtaState ?? {};
    const key = !active
      ? ""
      : `${lockRkm}|${upLockCandidate?.rkm ?? ""}|${downLockCandidate?.rkm ?? ""}`;
    if (key === lockEtaPathKey) return;
    lockEtaPathKey = key;

    if (!active) {
      upLockPolyline = setEtaPolyline(upLockPolyline, RED, null);
      downLockPolyline = setEtaPolyline(downLockPolyline, GREEN, null);
      return;
    }
    const lockPathKm = rkmToPathKm(rkmAnchors, lockRkm);
    upLockPolyline = setEtaPolyline(
      upLockPolyline,
      RED,
      upLockCandidate
        ? pathSegmentBetweenKm(
            rkmToPathKm(rkmAnchors, upLockCandidate.rkm),
            lockPathKm
          )
        : null
    );
    downLockPolyline = setEtaPolyline(
      downLockPolyline,
      GREEN,
      downLockCandidate
        ? pathSegmentBetweenKm(
            lockPathKm,
            rkmToPathKm(rkmAnchors, downLockCandidate.rkm)
          )
        : null
    );
  }

  function clearLockEta() {
    activeLockEta = null;
    lockEtaState = null;
    updateLockEtaPaths();
  }

  function updateLockEta(lock, upVal, downVal) {
    activeLockEta = { lock, upVal, downVal };
    const { nextUp, nextDown } = neighborLocks(lock);
    const lockRkm = lock.river_km;
    const upMax = nextUp ? nextUp.river_km : Infinity;
    const downMin = nextDown ? nextDown.river_km : -Infinity;

    const { upLockCandidate, downLockCandidate } =
      LockEta.selectLockEtaCandidates({
        vessels: vessels.values(),
        lockRkm,
        upMax,
        downMin,
        vesselRkm,
        vesselDirection,
      });

    // Bail when nothing changed since last invocation (e.g. periodic refresh
    // with an unchanged cache). Compares candidate identity + speed since the
    // displayed ETA depends only on those.
    const sig = `${lockRkm}|${upLockCandidate?.vessel.trackId ?? ""}:${upLockCandidate?.rkm ?? ""}:${upLockCandidate?.vessel.speedGround ?? ""}|${downLockCandidate?.vessel.trackId ?? ""}:${downLockCandidate?.rkm ?? ""}:${downLockCandidate?.vessel.speedGround ?? ""}`;
    if (activeLockEta._sig === sig) return;
    activeLockEta._sig = sig;

    upVal.textContent = upLockCandidate
      ? formatEta(upLockCandidate.distKm / upLockCandidate.vessel.speedGround)
      : "n.a.";
    downVal.textContent = downLockCandidate
      ? formatEta(downLockCandidate.distKm / downLockCandidate.vessel.speedGround)
      : "n.a.";

    lockEtaState = { lockRkm, upLockCandidate, downLockCandidate };
    updateLockEtaPaths();
  }

  refreshActiveLockEta = () => {
    if (!activeLockEta) return;
    updateLockEta(activeLockEta.lock, activeLockEta.upVal, activeLockEta.downVal);
  };

  for (const lock of locksDoc.locks) {
    const displayName = lock.name ?? lock.name_en;

    const popupEl = document.createElement("div");
    const popupTitle = document.createElement("strong");
    popupTitle.textContent = displayName;
    popupEl.appendChild(popupTitle);

    const popupMeta = document.createElement("div");
    popupMeta.style.fontSize = "12px";
    popupMeta.style.color = "#555";
    popupMeta.style.marginTop = "4px";

    const upRow = document.createElement("div");
    upRow.append("Next Upstream locking: ");
    const upVal = document.createElement("span");
    upVal.textContent = "n.a.";
    upRow.appendChild(upVal);
    popupMeta.appendChild(upRow);

    const downRow = document.createElement("div");
    downRow.append("Next Downstream Locking: ");
    const downVal = document.createElement("span");
    downVal.textContent = "n.a.";
    downRow.appendChild(downVal);
    popupMeta.appendChild(downRow);

    popupEl.appendChild(popupMeta);

    const marker = L.marker([lock.latitude, lock.longitude])
      .bindPopup(popupEl)
      .addTo(lockLayer);

    marker.on("popupopen", () => updateLockEta(lock, upVal, downVal));

    marker.on("popupclose", () => {
      if (!map.hasLayer(lockLayer)) {
        map.removeLayer(marker);
        if (activeLockMarker === marker) activeLockMarker = null;
      }
      // Defer past any popup that's opening this tick (e.g. clicking another lock).
      setTimeout(() => {
        if (!isAnyLockPopupOpen()) {
          clearLockListSelection();
          clearLockEta();
        }
      }, 0);
    });

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
      setKm(lock.river_km);
      map.setView([lock.latitude, lock.longitude], 13, { animate: false });
      // Ensure the selected pin is on the map even if the locks toggle is off.
      const locksLayerOn = map.hasLayer(lockLayer);
      if (!locksLayerOn) {
        if (activeLockMarker && activeLockMarker !== marker) {
          map.removeLayer(activeLockMarker);
        }
        if (!map.hasLayer(marker)) marker.addTo(map);
      }
      activeLockMarker = marker;
      marker.openPopup();
    });
    lockList.appendChild(li);
    lockItems.push({ li, marker, countries: new Set(isos) });
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

  const locksToggleEl = document.getElementById("locks-toggle");
  locksToggleEl.addEventListener("click", () => {
    const visible = !locksToggleEl.classList.contains("active");
    locksToggleEl.classList.toggle("active", visible);
    locksToggleEl.setAttribute("aria-pressed", String(visible));
    if (visible) {
      lockLayer.addTo(map);
    } else {
      lockLayer.remove();
      // Also clear any standalone pin that was added while the layer was off.
      if (activeLockMarker) {
        map.removeLayer(activeLockMarker);
        activeLockMarker = null;
      }
      clearLockListSelection();
      clearLockEta();
    }
  });

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
  setInterval(pruneAndRender, PRUNE_INTERVAL_MS);
}

init().catch((err) => {
  console.error("Failed to initialize map:", err);
});
