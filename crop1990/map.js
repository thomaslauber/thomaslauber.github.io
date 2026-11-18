// Crop and Grassland Maps — static web map reading Cloud Optimized GeoTIFFs.
// Band 1 = class_filtered (codes 1111–6500), band 3 = prob_filtered_pct (0–100),
// NoData = 65535. Files: {sensor}/crop1990_{sensor}_{year}.tif

// ---- Configuration ---------------------------------------------------
// Where the COGs live: the public Hugging Face dataset.
// For local testing with serve_local.py, use './data' instead.
const DATA_BASE_URL = 'https://huggingface.co/datasets/EOA-team/SwissCropGrasslandMaps/resolve/main';
const FIRST_YEAR = 1985, LAST_YEAR = 2025, SENTINEL2_FROM = 2018, DEFAULT_YEAR = 2025;
const NODATA = 65535;
const PLAY_DWELL_MS = 2000;   // while playing, show each fully drawn year this long
const PLAY_LOOKAHEAD = 2;      // years preloaded ahead while playing
const YEARS = [];
for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) YEARS.push(y);
const RED = '#DC0018';

const sensorFor = (y) => (y >= SENTINEL2_FROM ? 'sentinel2' : 'landsat');
const urlFor = (y) => `${DATA_BASE_URL}/${sensorFor(y)}/crop1990_${sensorFor(y)}_${y}.tif`;
const sensorText = (y) => (y >= SENTINEL2_FROM ? 'Sentinel-2 · 10 m' : 'Landsat · 30 m');

// ---- Projection (data are in UTM 32N) ---------------------------------
proj4.defs('EPSG:32632', '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs');
ol.proj.proj4.register(proj4);
const DATA_PROJ = ol.proj.get('EPSG:32632');

// ---- State (mirrored in the URL hash) -----------------------------------
const state = {year: DEFAULT_YEAR, mode: 0, base: 'cantons', opacity: 100,
               classes: new Set(), collapsed: new Set(), point: null};

// ---- Legend data -----------------------------------------------------
const NAMES = {}, COLOURS = {}, GROUP_OF = {}, CODES = [];
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
LEGEND_GROUPS.forEach((g, gi) => {
  for (const [code, name, colour] of g.classes) {
    NAMES[code] = name; COLOURS[code] = colour; GROUP_OF[code] = gi; CODES.push(code);
  }
});
// Colour a class is drawn in: its own, or its group's when the group is collapsed.
const colourOf = (code) => (state.collapsed.has(GROUP_OF[code]) ? LEGEND_GROUPS[GROUP_OF[code]].colour : COLOURS[code]);

// ---- Data layer style ----------------------------------------------------
// Bands read: [1, 3] -> ['band', 1] = class, ['band', 2] = confidence,
// ['band', 3] = alpha added by the source for NoData (0 = NoData).
// Style variables: c<code> (class shown by the legend filter), g<i> (group collapsed:
// use the group colour), mode (0 classes, 1 confidence), show (layer visible, see pool).
const classColour = ['match', ['band', 1]];
const classShown = ['match', ['band', 1]];
for (const code of CODES) {
  const gi = GROUP_OF[code];
  classColour.push(code, ['case', ['==', ['var', `g${gi}`], 1],
    [...hexToRgb(LEGEND_GROUPS[gi].colour), 1], [...hexToRgb(COLOURS[code]), 1]]);
  classShown.push(code, ['var', `c${code}`]);
}
classColour.push([0, 0, 0, 0]);
classShown.push(0);
const confRamp = ['interpolate', ['linear'], ['band', 2], 0, [0, 0, 0, 1], 100, [255, 255, 255, 1]];

const styleVariables = (show) => {
  const v = {mode: state.mode, show: show ? 1 : 0};
  for (const code of CODES) v[`c${code}`] = state.classes.size === 0 || state.classes.has(code) ? 1 : 0;
  LEGEND_GROUPS.forEach((_, gi) => { v[`g${gi}`] = state.collapsed.has(gi) ? 1 : 0; });
  return v;
};
const makeStyle = () => ({
  variables: styleVariables(false),
  color: ['case',
    ['==', ['var', 'show'], 0], [0, 0, 0, 0],
    ['==', ['band', 3], 0], [0, 0, 0, 0],
    ['==', ['band', 1], NODATA], [0, 0, 0, 0],
    ['==', classShown, 0], [0, 0, 0, 0],
    ['==', ['var', 'mode'], 0], classColour,
    confRamp],
});

const makeSource = (year) => new ol.source.GeoTIFF({
  sources: [{url: urlFor(year), bands: [1, 3], nodata: NODATA}],
  normalize: false, interpolate: false, projection: DATA_PROJ,
  transition: 0,   // no tile fade-in: a year appears at full strength at once
});

// ---- Backgrounds -------------------------------------------------------
const wmtsUrl = (layer, time) =>
  `https://wmts.geo.admin.ch/1.0.0/${layer}/default/${time}/3857/{z}/{x}/{y}.jpeg`;
const swisstopo = (layer, time) => new ol.layer.Tile({
  source: new ol.source.XYZ({url: wmtsUrl(layer, time), crossOrigin: 'anonymous', maxZoom: 19, transition: 0}),
  visible: false,
});
const vector = (features, style, opts = {}) => new ol.layer.Vector({
  source: new ol.source.Vector({features}), style, updateWhileAnimating: true, updateWhileInteracting: true, ...opts,
});
// "Cantons": plain white Switzerland with cantonal borders (drawn above the data).
// Colours of the drawn backgrounds per theme (bright / dark).
const MAP_THEMES = {
  light: {ch: '#ffffff', mask: '#eeede8', cantons: 'rgba(60,60,55,.55)', border: '#55554f'},
  dark: {ch: '#262624', mask: '#121211', cantons: 'rgba(225,224,215,.38)', border: '#b9b8b0'},
};
const chFill = vector([new ol.Feature(new ol.geom.MultiPolygon(CH_BOUNDARY))], null, {visible: false});
const baseLayers = {
  cantons: chFill,
  grey: swisstopo('ch.swisstopo.pixelkarte-grau', 'current'),
  aerial: swisstopo('ch.swisstopo.swissimage', 'current'),
  // SWISSIMAGE Zeitreise: per year, the latest aerial image flown up to that year.
  hist: swisstopo('ch.swisstopo.swissimage-product', DEFAULT_YEAR),
};
const cantonLayer = vector([new ol.Feature(new ol.geom.MultiLineString(CANTON_BORDERS))], null,
  {zIndex: 9, visible: false});

// Backgrounds only inside Switzerland: a mask in the map colour covers everything
// outside CH_BOUNDARY (incl. the Büsingen and Campione enclaves).
const outside = [[-1e7, -1e7], [1e7, -1e7], [1e7, 2e7], [-1e7, 2e7], [-1e7, -1e7]];
const maskFeatures = [new ol.Feature(new ol.geom.Polygon([outside, ...CH_BOUNDARY.map((p) => p[0])]))];
for (const poly of CH_BOUNDARY) {
  for (const hole of poly.slice(1)) maskFeatures.push(new ol.Feature(new ol.geom.Polygon([hole])));
}
const maskLayer = vector(maskFeatures, null);
const borderLayer = vector([new ol.Feature(new ol.geom.MultiPolygon(CH_BOUNDARY))], null, {zIndex: 10});

// ---- Bright / dark theme ------------------------------------------------------
// The page colours are CSS variables (index.html sets data-theme before first paint);
// here only the map's own vector backgrounds change. swisstopo maps stay as they are.
const themeBtns = document.querySelectorAll('.themeBtn');
function applyTheme(theme) {
  const t = MAP_THEMES[theme] ? theme : 'light';
  document.documentElement.setAttribute('data-theme', t);
  const c = MAP_THEMES[t];
  chFill.setStyle(new ol.style.Style({fill: new ol.style.Fill({color: c.ch})}));
  maskLayer.setStyle(new ol.style.Style({fill: new ol.style.Fill({color: c.mask})}));
  cantonLayer.setStyle(new ol.style.Style({stroke: new ol.style.Stroke({color: c.cantons, width: 1})}));
  borderLayer.setStyle(new ol.style.Style({stroke: new ol.style.Stroke({color: c.border, width: 1.2})}));
  themeBtns.forEach((b) => b.setAttribute('aria-label', t === 'dark' ? 'Switch to bright mode' : 'Switch to dark mode'));
}
applyTheme(document.documentElement.getAttribute('data-theme'));
themeBtns.forEach((b) => b.addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cropmap.theme', t); } catch (e) { /* not critical */ }
  applyTheme(t);
  drawAreaChart();
}));
// Follow the system setting as long as the user has not chosen one.
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('cropmap.theme'); } catch (err) { /* not critical */ }
    if (!saved) applyTheme(e.matches ? 'dark' : 'light');
  });
} catch (e) { /* old browsers */ }
// Marker for the inspected pixel: the outline of the pixel itself (once it is at
// least 6 screen px wide) and four crosshair arms that point at it from outside,
// leaving the pixel's colour visible at any zoom.
const HALO = new ol.style.Stroke({color: '#fff', width: 4});
const MARK = new ol.style.Stroke({color: RED, width: 2});
function markerStyle(feature, res) {
  const [cx, cy] = feature.get('centre');
  const halfPx = feature.get('half') / res;
  const gap = (Math.max(halfPx, 2) + 4) * res, arm = gap + 12 * res;
  const arms = new ol.geom.MultiLineString([
    [[cx - arm, cy], [cx - gap, cy]], [[cx + gap, cy], [cx + arm, cy]],
    [[cx, cy - arm], [cx, cy - gap]], [[cx, cy + gap], [cx, cy + arm]]]);
  const styles = [new ol.style.Style({geometry: arms, stroke: HALO}),
                  new ol.style.Style({geometry: arms, stroke: MARK})];
  if (halfPx >= 3) {
    styles.push(new ol.style.Style({stroke: new ol.style.Stroke({color: 'rgba(255,255,255,.9)', width: 3.5})}),
                new ol.style.Style({stroke: new ol.style.Stroke({color: RED, width: 1.5})}));
  }
  return styles;
}
const markerLayer = vector([], markerStyle, {zIndex: 11});

// ---- Map -------------------------------------------------------------
let dataLayer = null;   // the year currently shown (set once its first year has loaded)
const map = new ol.Map({
  target: 'map',
  controls: [new ol.control.Zoom()],
  layers: [baseLayers.cantons, baseLayers.grey, baseLayers.aerial, baseLayers.hist, maskLayer,
           cantonLayer, borderLayer, markerLayer],
  view: new ol.View({
    projection: DATA_PROJ,
    center: ol.proj.fromLonLat([8.23, 46.80], DATA_PROJ),
    zoom: 8.6,
    extent: [150000, 4950000, 750000, 5420000],
  }),
});

// ---- Switching years without flicker -------------------------------------------
// A fixed pool of WebGL layers stays in the map the whole time (never moved or
// removed: that makes the browser re-arrange the GPU canvases and the map blinks).
// Each pool layer holds one year. Hidden years are drawn fully transparent but still
// load; showing a year only flips the style variable `show` on the new and the old
// layer in the same frame. The pool doubles as a cache of recently viewed years.
// Labels etc. switch only once the year is on screen.
const POOL_SIZE = 2 + PLAY_LOOKAHEAD;   // shown + incoming + look-ahead
const pool = [];                        // {layer, year, used}
let shown = null;                       // pool entry on screen
let incoming = null;                    // {year, entry} loading to be shown
let layerReady = Promise.resolve(true);
let targetYear = state.year;

function buildPool(years) {
  const at = map.getLayers().getArray().indexOf(cantonLayer);
  for (let i = 0; i < POOL_SIZE; i++) {
    const year = years[i];
    const layer = new ol.layer.WebGLTile({source: makeSource(year), style: makeStyle(),
                                          opacity: state.opacity / 100, properties: {year}});
    pool.push({layer, year, used: 0});
    map.getLayers().insertAt(at + i, layer);
  }
}

// Pool entry for `year`; loads it into the least recently used entry whose year is
// not in `keep` if needed.
function entryFor(year, keep) {
  let e = pool.find((p) => p.year === year);
  if (!e) {
    const free = pool.filter((p) => p !== shown && !keep.has(p.year)).sort((a, b) => a.used - b.used);
    e = free[0] || pool.find((p) => p !== shown);
    e.layer.updateStyleVariables({show: 0});
    e.layer.setSource(makeSource(year));
    e.layer.set('year', year);
    e.year = year;
  }
  e.used = performance.now();
  return e;
}

function preloadYears(years) {
  const keep = new Set([state.year, targetYear, ...years]);
  for (const y of years) if (y >= FIRST_YEAR && y <= LAST_YEAR) entryFor(y, keep);
}

// Resolves once this layer's own tiles have loaded and been drawn. OpenLayers only
// queues tile requests after a frame is drawn, so "nothing loading" counts only after
// two frames in a row with no pending tiles (otherwise it would trigger too early).
function layerLoaded(layer) {
  return new Promise((resolve) => {
    const src = layer.getSource();
    let pending = 0, idleFrames = 0, finished = false;
    const onStart = () => { pending++; idleFrames = 0; };
    const onEnd = () => { pending = Math.max(0, pending - 1); };
    function check() {
      if (finished) return;
      if (layer.getSource() !== src) { finished = true; return resolve(); }   // entry reused
      idleFrames = pending || src.getState() !== 'ready' ? 0 : idleFrames + 1;
      if (idleFrames < 2) { layer.once('postrender', check); map.render(); return; }
      finished = true;
      src.un('tileloadstart', onStart);
      src.un(['tileloadend', 'tileloaderror'], onEnd);
      resolve();
    }
    src.on('tileloadstart', onStart);
    src.on(['tileloadend', 'tileloaderror'], onEnd);
    layer.once('postrender', check);
    map.render();
  });
}

// Load `year` (hidden), then show it. Resolves true when shown, false if superseded.
function swapDataLayer(year) {
  const entry = entryFor(year, new Set([state.year, year]));
  const me = incoming = {year, entry};
  layerReady = new Promise((resolve) => {
    let settled = false;
    const reveal = () => {
      if (settled) return;
      settled = true;
      if (incoming !== me || entry.year !== year) return resolve(false);
      incoming = null;
      entry.layer.setOpacity(state.opacity / 100);
      entry.layer.updateStyleVariables(styleVariables(true));
      if (shown && shown !== entry) shown.layer.updateStyleVariables({show: 0});
      shown = entry;
      dataLayer = entry.layer;
      resolve(true);
    };
    layerLoaded(entry.layer).then(reveal);
    setTimeout(reveal, 20000);                        // never block for good
  });
  return layerReady;
}

// ---- Timeline ------------------------------------------------------------
const track = document.getElementById('track');
const playBtn = document.getElementById('play');
const yearLabel = document.getElementById('yearLabel');
const sensorLabel = document.getElementById('sensorLabel');
const pct = (y) => ((y - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR)) * 100;

(function buildTicks() {
  const ticks = document.getElementById('ticks');
  for (const y of YEARS) {
    const major = y % 5 === 0;
    const t = document.createElement('div');
    t.className = 'tick' + (major ? ' major' : '');
    t.style.left = pct(y) + '%';
    ticks.appendChild(t);
    if (major || y === FIRST_YEAR) {
      const l = document.createElement('div');
      l.className = 'tlabel' + ([FIRST_YEAR, 2000, LAST_YEAR].includes(y) ? ' mobile' : '');
      l.style.left = pct(y) + '%';
      l.textContent = y;
      ticks.appendChild(l);
    }
  }
  const split = (pct(SENTINEL2_FROM - 1) + pct(SENTINEL2_FROM)) / 2;
  Object.assign(document.getElementById('bandL').style, {left: '0', width: split + '%'});
  Object.assign(document.getElementById('bandS').style, {left: split + '%', width: (100 - split) + '%'});
})();

function drawTrack() {
  document.getElementById('handle').style.left = pct(targetYear) + '%';
  document.getElementById('fill').style.width = pct(targetYear) + '%';
  track.setAttribute('aria-valuenow', targetYear);
}

function setYear(year) {
  year = Math.max(FIRST_YEAR, Math.min(LAST_YEAR, year));
  targetYear = year;
  drawTrack();
  if (year === state.year && dataLayer && !incoming) { sensorLabel.textContent = sensorText(year); return; }
  sensorLabel.textContent = `loading ${year}…`;
  swapDataLayer(year).then((ok) => { if (ok) showYear(year); });
}

// Called when `year` is actually on screen.
function showYear(year) {
  state.year = year;
  yearLabel.textContent = year;
  sensorLabel.textContent = sensorText(year);
  drawTrack();
  baseLayers.hist.getSource().setUrl(wmtsUrl('ch.swisstopo.swissimage-product', year));
  if (state.point) updateMarker();
  renderPixelCard();
  drawAreaChart();
  saveHash();
}

const yearAt = (clientX) => {
  const r = track.getBoundingClientRect();
  return Math.round(FIRST_YEAR + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (LAST_YEAR - FIRST_YEAR));
};
track.addEventListener('pointerdown', (e) => {
  stopPlay(); track.setPointerCapture(e.pointerId); track.focus();
  setYear(yearAt(e.clientX));
  const move = (ev) => { const y = yearAt(ev.clientX); if (y !== targetYear) setYear(y); };
  const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); };
  track.addEventListener('pointermove', move);
  track.addEventListener('pointerup', up);
});
track.addEventListener('keydown', (e) => {
  const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5}[e.key];
  if (step) { e.preventDefault(); stopPlay(); setYear(targetYear + step); }
  if (e.key === 'Home') { e.preventDefault(); stopPlay(); setYear(FIRST_YEAR); }
  if (e.key === 'End') { e.preventDefault(); stopPlay(); setYear(LAST_YEAR); }
});

// Playback: each year is revealed once fully drawn and then shown for PLAY_DWELL_MS,
// while the next PLAY_LOOKAHEAD years load in the background.
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let playing = false, playRun = 0;

function stopPlay() {
  playing = false; playRun++;
  playBtn.innerHTML = ICON_PLAY; playBtn.setAttribute('aria-label', 'Play');
}
async function play() {
  const run = ++playRun;
  playing = true;
  playBtn.innerHTML = ICON_PAUSE; playBtn.setAttribute('aria-label', 'Pause');
  if (targetYear >= LAST_YEAR) setYear(FIRST_YEAR);
  while (playing && run === playRun) {
    preloadYears(Array.from({length: PLAY_LOOKAHEAD}, (_, i) => targetYear + 1 + i));
    await layerReady;
    await sleep(PLAY_DWELL_MS);
    if (!playing || run !== playRun) return;
    if (targetYear >= LAST_YEAR) return stopPlay();
    setYear(targetYear + 1);
  }
}
playBtn.addEventListener('click', () => (playing ? stopPlay() : play()));
stopPlay();

// ---- Layer controls ----------------------------------------------------
const markOn = (segId, attr, value) =>
  document.querySelectorAll(`#${segId} button`).forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(value)));

function setMode(mode) {
  state.mode = mode;
  for (const p of pool) p.layer.updateStyleVariables({mode});
  document.getElementById('confLegend').style.display = mode === 1 ? 'block' : 'none';
  markOn('modeSeg', 'mode', mode);
  saveHash();
}
function setBase(base) {
  state.base = base;
  for (const [k, l] of Object.entries(baseLayers)) l.setVisible(k === base);
  cantonLayer.setVisible(base === 'cantons');
  markOn('baseSeg', 'base', base);
  saveHash();
}
function setOpacity(p) {
  state.opacity = p;
  for (const e of pool) e.layer.setOpacity(p / 100);
  document.getElementById('opacity').value = p;
  saveHash();
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(+b.dataset.mode)));
document.querySelectorAll('#baseSeg button').forEach((b) => b.addEventListener('click', () => setBase(b.dataset.base)));
document.getElementById('opacity').addEventListener('input', (e) => setOpacity(+e.target.value));

// ---- Legend: groups, collapse, selection --------------------------------------
const legendEl = document.getElementById('legend');
const CHEVRON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 6 4 4 4-4"/></svg>';
LEGEND_GROUPS.forEach((g, gi) => {
  const group = document.createElement('div');
  group.className = 'group';
  group.dataset.g = gi;
  group.innerHTML =
    `<div class="ghead" title="Show only ${g.title.toLowerCase()}">` +
    `<button class="chev" type="button" aria-label="Collapse or expand ${g.title}">${CHEVRON}</button>` +
    `<span class="sw" style="background:${g.colour}"></span><span class="gname"></span>` +
    `<span class="gcount">${g.classes.length}</span></div><div class="gbody"></div>`;
  group.querySelector('.gname').textContent = g.title;
  group.querySelector('.chev').addEventListener('click', (e) => { e.stopPropagation(); toggleCollapse(gi); });
  group.querySelector('.ghead').addEventListener('click', () => toggleGroup(gi));
  const body = group.querySelector('.gbody');
  for (const [code, name, colour] of g.classes) {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.code = code;
    row.innerHTML = `<span class="sw" style="background:${colour}"></span><span></span>`;
    row.lastChild.textContent = name;
    row.addEventListener('click', () => toggleClass(code));
    body.appendChild(row);
  }
  legendEl.appendChild(group);
});

function refreshLegend() {
  for (const p of pool) p.layer.updateStyleVariables(styleVariables(p === shown));
  legendEl.classList.toggle('filtering', state.classes.size > 0);
  for (const row of legendEl.querySelectorAll('.item')) row.classList.toggle('on', state.classes.has(+row.dataset.code));
  for (const grp of legendEl.querySelectorAll('.group')) {
    const gi = +grp.dataset.g;
    grp.classList.toggle('collapsed', state.collapsed.has(gi));
    grp.classList.toggle('on', LEGEND_GROUPS[gi].classes.every(([c]) => state.classes.has(c)));
  }
  document.getElementById('showAll').style.display = state.classes.size ? 'inline' : 'none';
  document.getElementById('collapseAll').textContent =
    state.collapsed.size === LEGEND_GROUPS.length ? 'Expand all' : 'Collapse all';
  drawAreaChart();
  renderPixelCard();
  saveHash();
}
function toggleClass(code) {
  if (state.classes.has(code)) state.classes.delete(code); else state.classes.add(code);
  refreshLegend();
}
function toggleGroup(gi) {
  const codes = LEGEND_GROUPS[gi].classes.map(([c]) => c);
  const all = codes.every((c) => state.classes.has(c));
  for (const c of codes) if (all) state.classes.delete(c); else state.classes.add(c);
  refreshLegend();
}
function toggleCollapse(gi) {
  if (state.collapsed.has(gi)) state.collapsed.delete(gi); else state.collapsed.add(gi);
  refreshLegend();
}
document.getElementById('showAll').addEventListener('click', () => { state.classes.clear(); refreshLegend(); });
document.getElementById('collapseAll').addEventListener('click', () => {
  if (state.collapsed.size === LEGEND_GROUPS.length) state.collapsed.clear();
  else LEGEND_GROUPS.forEach((_, gi) => state.collapsed.add(gi));
  refreshLegend();
});

// ---- Area chart (fixed size; never moves the legend) -----------------------------
// Very light colours get a darker line so they stay visible on white...
function lineColour(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (document.documentElement.getAttribute('data-theme') === 'dark') {
    // ...and very dark colours a lighter line on the dark background.
    const up = (v) => (v + (255 - v) * 0.45) | 0;
    return lum < 0.35 ? `rgb(${up(r)},${up(g)},${up(b)})` : hex;
  }
  return lum > 0.75 ? `rgb(${r * 0.6 | 0},${g * 0.6 | 0},${b * 0.6 | 0})` : hex;
}
const OVERVIEW_GROUPS = ['Cereals', 'Maize', 'Oilseeds', 'Root crops', 'Vegetables and special crops',
                         'Legumes', 'Ley and fallow'].map((t) => LEGEND_GROUPS.findIndex((g) => g.title === t));
const W = 268, H = 140, L = 38, R = 6, T = 8, B = 18;
let chartInfo = null;   // what the area chart shows, for the hover tooltip
const chartX = (y) => L + (y - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR) * (W - L - R);
const niceTop = (max) => {
  const step = Math.pow(10, Math.floor(Math.log10(max || 1)));
  return Math.ceil((max || 1) / step) * step;
};
// Grid, axis labels and the current-year line shared by both charts.
function chartFrame(top) {
  const y = (v) => H - B - v / top * (H - T - B);
  let s = '';
  for (const v of [0, top / 2, top]) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/>` +
         `<text x="${L - 4}" y="${y(v) + 3}" font-size="9" text-anchor="end" class="gt">${(+v.toPrecision(3)).toLocaleString('en')}</text>`;
  }
  for (const yr of [1985, 2000, 2018, 2025]) {
    const anchor = yr === LAST_YEAR ? 'end' : yr === FIRST_YEAR ? 'start' : 'middle';
    s += `<text x="${chartX(yr)}" y="${H - 5}" font-size="9" text-anchor="${anchor}" class="gt">${yr}</text>`;
  }
  return {y, s};
}
const currentYearLine = () =>
  `<line x1="${chartX(state.year)}" x2="${chartX(state.year)}" y1="${T}" y2="${H - B}" stroke="${RED}" stroke-width="1.2"/>`;

// Default (nothing selected): arable land stacked by crop group, Landsat up to 2017 and
// Sentinel-2 from 2018 (the same series as the map). Grassland and other land cover
// are left out: they are 10–20× larger and would flatten the crops.
function drawOverviewChart(svg) {
  const totals = YEARS.map((yr) => {
    const a = (CLASS_AREAS[sensorFor(yr)] || {})[yr] || {};
    return OVERVIEW_GROUPS.map((gi) => LEGEND_GROUPS[gi].classes.reduce((s, [c]) => s + (a[c] || 0), 0));
  });
  const top = niceTop(Math.max(...totals.map((t) => t.reduce((a, b) => a + b, 0))));
  const f = chartFrame(top);
  let s = f.s;
  const lower = YEARS.map(() => 0);
  OVERVIEW_GROUPS.forEach((gi, k) => {
    const upper = lower.map((v, i) => v + totals[i][k]);
    const pts = YEARS.map((yr, i) => `${chartX(yr).toFixed(1)},${f.y(upper[i]).toFixed(1)}`);
    const back = YEARS.map((yr, i) => `${chartX(yr).toFixed(1)},${f.y(lower[i]).toFixed(1)}`).reverse();
    const g = LEGEND_GROUPS[gi];
    s += `<polygon class="aband" points="${pts.concat(back).join(' ')}" fill="${g.colour}" stroke="rgba(0,0,0,.15)" stroke-width=".5"/>`;
    upper.forEach((v, i) => { lower[i] = v; });
  });
  // Sensor change Landsat → Sentinel-2.
  const xs = (chartX(SENTINEL2_FROM - 1) + chartX(SENTINEL2_FROM)) / 2;
  s += `<line x1="${xs}" x2="${xs}" y1="${T}" y2="${H - B}" class="gd" stroke-dasharray="2 2"/>`;
  svg.innerHTML = s + currentYearLine();
  chartInfo = {stacked: true, top, rows: OVERVIEW_GROUPS.map((gi, k) => ({
    name: LEGEND_GROUPS[gi].title, colour: LEGEND_GROUPS[gi].colour,
    value: (yr) => totals[YEARS.indexOf(yr)][k]}))};
}

function drawAreaChart() {
  const svg = document.getElementById('areaChart');
  if (!window.CLASS_AREAS) return;
  const overview = state.classes.size === 0;
  document.getElementById('areaTitle').textContent = overview ? 'Arable land by crop group (km²)' : 'Mapped area (km²)';
  document.getElementById('areaKey').textContent = overview
    ? 'Select classes in the legend to compare them.' : '── Landsat   ┄┄ Sentinel-2';
  if (overview) { drawOverviewChart(svg); return; }
  // One line per selected class, or per collapsed group (sum of its selected classes).
  const units = new Map();   // key -> {name, colour, codes}
  for (const code of state.classes) {
    const gi = GROUP_OF[code];
    const key = state.collapsed.has(gi) ? `g${gi}` : `c${code}`;
    if (!units.has(key)) {
      units.set(key, state.collapsed.has(gi)
        ? {name: LEGEND_GROUPS[gi].title, colour: LEGEND_GROUPS[gi].colour, codes: []}
        : {name: NAMES[code], colour: COLOURS[code], codes: []});
    }
    units.get(key).codes.push(code);
  }
  const x = chartX;
  const series = [];
  let max = 0;
  for (const u of units.values()) {
    for (const sensor of ['landsat', 'sentinel2']) {
      const pts = Object.entries(CLASS_AREAS[sensor] || {})
        .map(([yr, a]) => [+yr, u.codes.reduce((s, c) => s + (a[c] || 0), 0)]).sort((a, b) => a[0] - b[0]);
      pts.forEach((p) => { max = Math.max(max, p[1]); });
      series.push({u, sensor, pts});
    }
  }
  const f = chartFrame(niceTop(max));
  const y = f.y;
  let s = f.s + currentYearLine();
  for (const {u, sensor, pts} of series) {
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    s += `<path d="${d}" fill="none" stroke="${lineColour(u.colour)}" stroke-width="1.8"` +
         `${sensor === 'sentinel2' ? ' stroke-dasharray="4 2"' : ''}/>`;
  }
  svg.innerHTML = s;
  // Tooltip values: the sensor the map uses for that year.
  const top = niceTop(max);
  chartInfo = {stacked: false, top, rows: [...units.values()].map((u) => ({
    name: u.name, colour: u.colour,
    value: (yr) => {
      const a = (CLASS_AREAS[sensorFor(yr)] || {})[yr];
      return a ? u.codes.reduce((t, c) => t + (a[c] || 0), 0) : null;
    }}))};
}

// ---- Chart hover: year guide line + values of that year; click jumps to the year ----
const areaSvg = document.getElementById('areaChart');
const areaTip = document.getElementById('areaTip');
const fmtKm2 = (v) => (v == null ? '–' : v >= 100 ? Math.round(v).toLocaleString('en') : v.toFixed(1));
function chartPoint(e) {
  const r = areaSvg.getBoundingClientRect();
  const vx = (e.clientX - r.left) / r.width * W, vy = (e.clientY - r.top) / r.height * H;
  const yr = Math.round(FIRST_YEAR + (vx - L) / (W - L - R) * (LAST_YEAR - FIRST_YEAR));
  return {r, vy, yr: Math.max(FIRST_YEAR, Math.min(LAST_YEAR, yr))};
}
function hideChartTip() {
  areaTip.style.display = 'none';
  const g = document.getElementById('areaGuide');
  if (g) g.remove();
}
areaSvg.addEventListener('pointermove', (e) => {
  if (!chartInfo) return;
  const {r, vy, yr} = chartPoint(e);
  const vals = chartInfo.rows.map((row) => row.value(yr));
  // Which row is under the cursor: the stacked band, or the nearest line.
  const v = (H - B - vy) / (H - T - B) * chartInfo.top;
  let hi = -1;
  if (chartInfo.stacked) {
    let acc = 0;
    vals.forEach((x, i) => { if (hi < 0 && v >= acc && v <= acc + x) hi = i; acc += x; });
  } else {
    let best = Infinity;
    vals.forEach((x, i) => { if (x != null && Math.abs(x - v) < best) { best = Math.abs(x - v); hi = i; } });
  }
  let guide = document.getElementById('areaGuide');
  if (!guide) {
    guide = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    guide.id = 'areaGuide';
    guide.setAttribute('class', 'gd');
    guide.setAttribute('y1', T); guide.setAttribute('y2', H - B);
    areaSvg.appendChild(guide);
  }
  guide.setAttribute('x1', chartX(yr)); guide.setAttribute('x2', chartX(yr));
  // Stacked: top band first, as drawn. Lines: largest area first; at most MAX_ROWS rows
  // (always incl. the one under the cursor), the rest summed into one line.
  const MAX_ROWS = 12;
  let order = chartInfo.rows.map((_, i) => i);
  if (chartInfo.stacked) order.reverse();
  else order.sort((a, b) => (vals[b] ?? -1) - (vals[a] ?? -1));
  let shown = order;
  if (order.length > MAX_ROWS) {
    shown = order.slice(0, MAX_ROWS - 1);
    if (hi >= 0 && !shown.includes(hi)) shown[shown.length - 1] = hi;
  }
  const rest = order.filter((i) => !shown.includes(i));
  const restSum = rest.reduce((t, i) => t + (vals[i] || 0), 0);
  areaTip.innerHTML =
    `<div class="yr">${yr}<span>${yr >= SENTINEL2_FROM ? 'Sentinel-2' : 'Landsat'} · km²</span></div>` +
    shown.map((i) => `<div class="row${i === hi ? ' hi' : ''}"><span class="sw" style="background:${chartInfo.rows[i].colour}"></span>` +
      `<span class="n">${chartInfo.rows[i].name}</span><span class="v">${fmtKm2(vals[i])}</span></div>`).join('') +
    (rest.length ? `<div class="row tot"><span class="n">${rest.length} others</span><span class="v">${fmtKm2(restSum)}</span></div>` : '') +
    (chartInfo.stacked ? `<div class="row tot"><span class="n">Arable land</span><span class="v">${fmtKm2(vals.reduce((a, b) => a + b, 0))}</span></div>` : '');
  // Place the box beside the cursor, on the side with more room.
  const box = areaSvg.parentElement.getBoundingClientRect();
  const cx = e.clientX - box.left;
  areaTip.style.display = 'block';
  areaTip.style.left = `${cx > box.width / 2 ? cx - areaTip.offsetWidth - 12 : cx + 12}px`;
  areaTip.style.top = `${r.top - box.top + 4}px`;
});
areaSvg.addEventListener('pointerleave', hideChartTip);
areaSvg.addEventListener('click', (e) => { stopPlay(); setYear(chartPoint(e).yr); });

// ---- Pixel history (docked card) -------------------------------------------
// For a clicked point, read the exact full-resolution pixel from every year's COG
// (class + confidence). Results fill in progressively.
const card = document.getElementById('pixelCard');
const hint = document.getElementById('hint');
const tiffCache = {};
const openImage = (year) => {
  if (!tiffCache[year]) {
    tiffCache[year] = GeoTIFF.fromUrl(urlFor(year)).then((t) => t.getImage())
      .catch((e) => { delete tiffCache[year]; throw e; });
  }
  return tiffCache[year];
};
async function readPixel(year, coord) {
  const img = await openImage(year);
  const [x0, y0] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const px = Math.floor((coord[0] - x0) / rx);
  const py = Math.floor((coord[1] - y0) / ry);
  if (px < 0 || py < 0 || px >= img.getWidth() || py >= img.getHeight()) return null;
  const r = await img.readRasters({window: [px, py, px + 1, py + 1], samples: [0, 2]});
  return r[0][0] === NODATA ? null : {code: r[0][0], conf: r[1][0]};
}

let pixelHistory = {};  // year -> {code, conf} | null | undefined (loading)
let historyId = 0;

async function inspect(coord) {
  state.point = coord;
  const myId = ++historyId;
  pixelHistory = {};
  updateMarker();
  hint.style.opacity = 0;
  renderPixelCard();
  saveHash();
  const queue = [state.year, ...YEARS.filter((y) => y !== state.year)];   // current year first
  const worker = async () => {
    while (queue.length) {
      const year = queue.shift();
      let v;
      try { v = await readPixel(year, coord); } catch (e) { console.error(e); v = null; }
      if (myId !== historyId) return;
      pixelHistory[year] = v;
      renderPixelCard();
    }
  };
  await Promise.all(Array.from({length: 6}, worker));
}
// Outline of the clicked pixel in the grid of the shown year (30 m Landsat / 10 m Sentinel-2).
async function updateMarker() {
  const src = markerLayer.getSource();
  const point = state.point, year = state.year;
  if (!point) { src.clear(); return; }
  let extent = null;
  try {
    const img = await openImage(year);
    const [x0, y0] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const xa = x0 + Math.floor((point[0] - x0) / rx) * rx;
    const ya = y0 + Math.floor((point[1] - y0) / ry) * ry;
    extent = [Math.min(xa, xa + rx), Math.min(ya, ya + ry), Math.max(xa, xa + rx), Math.max(ya, ya + ry)];
  } catch (e) { /* fall back to the clicked point */ }
  if (state.point !== point || state.year !== year) return;   // changed meanwhile
  const f = new ol.Feature(extent ? ol.geom.Polygon.fromExtent(extent) : new ol.geom.Point(point));
  f.set('centre', extent ? ol.extent.getCenter(extent) : point);
  f.set('half', extent ? (extent[2] - extent[0]) / 2 : 0);
  src.clear();
  src.addFeature(f);
}
function closePixelCard() {
  historyId++; state.point = null; markerLayer.getSource().clear(); renderPixelCard(); saveHash();
}

function renderPixelCard() {
  if (!state.point) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const [lon, lat] = ol.proj.toLonLat(state.point, DATA_PROJ);
  const cur = pixelHistory[state.year];
  let head;
  if (cur === undefined) head = `<span class="muted">Loading…</span>`;
  else if (cur === null) head = `<span>No data here in ${state.year}</span>`;
  else head = `<span class="sw" style="background:${colourOf(cur.code)}"></span>` +
    `<div><b>${NAMES[cur.code] || 'Unknown'}</b> <span class="muted">${cur.code}</span><br>` +
    `<span class="muted">${state.year} · confidence ${cur.conf} %</span></div>`;

  const cells = YEARS.map((y) => {
    const v = pixelHistory[y];
    const bg = v ? colourOf(v.code) : (v === null ? 'transparent' : 'var(--hover2)');
    const tip = v ? `${y}: ${NAMES[v.code]} (${v.conf} %)` : `${y}: ${v === null ? 'no data' : 'loading'}`;
    return `<span class="${y === state.year ? 'cur' : ''}" data-year="${y}" title="${tip}" style="background:${bg}"></span>`;
  }).join('');

  // Confidence line (0–100 %) aligned with the cells.
  const n = YEARS.length;
  const pts = YEARS.map((y, i) => [i, pixelHistory[y]]).filter(([, v]) => v)
    .map(([i, v]) => `${((i + 0.5) / n * 300).toFixed(1)},${(33 - v.conf / 100 * 30).toFixed(1)}`);
  const sw = (SENTINEL2_FROM - FIRST_YEAR) / n * 300;
  const line = `<svg viewBox="0 0 300 36" preserveAspectRatio="none">` +
    `<line x1="0" x2="300" y1="3" y2="3" class="gl"/><line x1="0" x2="300" y1="33" y2="33" class="gl"/>` +
    `<line x1="${sw}" x2="${sw}" y1="0" y2="36" class="gd" stroke-dasharray="2 2"/>` +
    (pts.length ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${RED}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : '') +
    `</svg>`;

  card.innerHTML =
    `<div class="top"><span class="lbl">Pixel history</span>` +
    `<button class="close" type="button" aria-label="Close">×</button></div>` +
    `<div class="head">${head}</div>` +
    `<div class="strip">${cells}</div>` +
    `<div class="axis"><span>1985</span><span>Landsat │ Sentinel-2</span><span>2025</span></div>` +
    line +
    `<div class="axis"><span>Confidence 0–100 %</span><span>${lat.toFixed(5)} N, ${lon.toFixed(5)} E</span></div>`;
  card.querySelector('.close').addEventListener('click', closePixelCard);
  card.querySelectorAll('.strip span').forEach((el) =>
    el.addEventListener('click', () => { stopPlay(); setYear(+el.dataset.year); }));
}

map.on('singleclick', (e) => inspect(e.coordinate));
map.on('pointermove', (e) => { map.getTargetElement().style.cursor = e.dragging ? '' : 'crosshair'; });

// ---- Place search (geo.admin.ch) ------------------------------------------
const searchBox = document.getElementById('search');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchTimer = null, searchSeq = 0;
const plainText = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.style.display = 'none'; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer?type=locations&sr=4326&limit=8&searchText=' +
        encodeURIComponent(q);
      const res = await (await fetch(url)).json();
      if (seq !== searchSeq) return;
      searchResults.innerHTML = '';
      for (const r of res.results || []) {
        const a = r.attrs;
        const div = document.createElement('div');
        div.textContent = plainText(a.label);
        div.addEventListener('click', () => {
          searchResults.style.display = 'none';
          searchInput.value = div.textContent;
          map.getView().animate({center: ol.proj.fromLonLat([a.lon, a.lat], DATA_PROJ),
                                 zoom: Math.max(12, Math.min(15, (a.zoomlevel || 10) + 4)), duration: 600});
        });
        searchResults.appendChild(div);
      }
      searchResults.style.display = searchResults.children.length ? 'block' : 'none';
    } catch (e) { console.error(e); }
  }, 250);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && searchResults.firstChild) searchResults.firstChild.click();
  if (e.key === 'Escape') searchResults.style.display = 'none';
});
document.addEventListener('click', (e) => { if (!searchBox.contains(e.target)) searchResults.style.display = 'none'; });

// ---- Header, About, mobile legend ------------------------------------------
const about = document.getElementById('about');
const openAbout = () => about.classList.add('open');
const closeAbout = () => {
  about.classList.remove('open');
  try { localStorage.setItem('cropmap.aboutSeen', '1'); } catch (e) { /* not critical */ }
};
document.querySelectorAll('.aboutBtn').forEach((b) => b.addEventListener('click', openAbout));
about.querySelectorAll('.close, .go').forEach((b) => b.addEventListener('click', closeAbout));
about.addEventListener('click', (e) => { if (e.target === about) closeAbout(); });
document.getElementById('layersBtn').addEventListener('click', () =>
  document.getElementById('layerCtl').classList.toggle('open'));
document.getElementById('legendBtn').addEventListener('click', () =>
  document.getElementById('sidebar').classList.toggle('open'));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (about.classList.contains('open')) closeAbout(); else closePixelCard();
});

// ---- Shareable URL (#year=..&lon=..&lat=..&z=..) ---------------------------
let hashReady = false;
function saveHash() {
  if (!hashReady) return;
  const v = map.getView();
  const [lon, lat] = ol.proj.toLonLat(v.getCenter(), DATA_PROJ);
  const p = new URLSearchParams({year: state.year, lon: lon.toFixed(5), lat: lat.toFixed(5),
                                 z: v.getZoom().toFixed(2)});
  if (state.mode) p.set('layer', 'confidence');
  if (state.base !== 'cantons') p.set('base', state.base);
  if (state.opacity !== 100) p.set('opacity', state.opacity);
  if (state.classes.size) p.set('classes', [...state.classes].join(','));
  if (state.collapsed.size) p.set('collapsed', [...state.collapsed].join(','));
  if (state.point) {
    const [plon, plat] = ol.proj.toLonLat(state.point, DATA_PROJ);
    p.set('pixel', `${plon.toFixed(6)},${plat.toFixed(6)}`);
  }
  window.history.replaceState(null, '', '#' + p.toString());
}
map.on('moveend', saveHash);

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const year = +p.get('year');
  if (year >= FIRST_YEAR && year <= LAST_YEAR) state.year = year;
  if (p.get('lon') && p.get('lat')) map.getView().setCenter(ol.proj.fromLonLat([+p.get('lon'), +p.get('lat')], DATA_PROJ));
  if (p.get('z')) map.getView().setZoom(+p.get('z'));
  for (const c of (p.get('classes') || '').split(',')) if (NAMES[+c]) state.classes.add(+c);
  for (const g of (p.get('collapsed') || '').split(',')) if (g !== '' && LEGEND_GROUPS[+g]) state.collapsed.add(+g);
  setBase(['cantons', 'grey', 'aerial', 'hist'].includes(p.get('base')) ? p.get('base') : 'cantons');
  setMode(p.get('layer') === 'confidence' ? 1 : 0);
  if (p.get('opacity')) setOpacity(Math.max(0, Math.min(100, +p.get('opacity'))));
  return {pixel: p.get('pixel'), shared: location.hash.length > 1};
}

// ---- Start -------------------------------------------------------------
const start = loadHash();
targetYear = state.year;
// Start with the shown year and its nearest neighbours (next years first).
buildPool([0, 1, 2, -1, 3, -2, 4, -3, -4].map((d) => state.year + d)
  .filter((y) => y >= FIRST_YEAR && y <= LAST_YEAR));
refreshLegend();
yearLabel.textContent = state.year;
drawTrack();
sensorLabel.textContent = `loading ${state.year}…`;
swapDataLayer(state.year).then(() => showYear(state.year));
hashReady = true;
if (start.pixel) {
  const [lon, lat] = start.pixel.split(',').map(Number);
  if (isFinite(lon) && isFinite(lat)) inspect(ol.proj.fromLonLat([lon, lat], DATA_PROJ));
}
let aboutSeen = false;
try { aboutSeen = localStorage.getItem('cropmap.aboutSeen') === '1'; } catch (e) { /* not critical */ }
if (!aboutSeen && !start.shared) openAbout();
saveHash();

// expose for debugging / tests
window.cropmap = {map, get dataLayer() { return dataLayer; }, inspect, setYear, toggleClass, toggleCollapse, state};
