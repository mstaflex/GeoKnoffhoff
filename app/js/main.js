/* GeoKnoffhoff: Bubbles auf Laenderumrisse ziehen, spaeter auswerten. */

import { MapView } from './mapview.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

const ui = {
  regions: $('regions'),
  panelTitle: $('panel-title'),
  bubbles: $('bubbles'),
  panelEmpty: $('panel-empty'),
  mapWrap: $('map-wrap'),
  hint: $('hint'),
  loading: $('loading'),
  ghost: $('ghost'),
  toast: $('toast'),
  review: $('review'),
  reviewText: $('review-text'),
  placed: $('progress-placed'),
  total: $('progress-total'),
  evaluate: $('btn-evaluate'),
  reset: $('btn-reset'),
  shuffle: $('btn-shuffle'),
  continue: $('btn-continue'),
  restart: $('btn-restart'),
};

/** @type {MapView|null} */
let map = null;
/** @type {Game|null} */
let game = null;
let regionIndex = [];
let shuffled = false;
let selectedId = null;
let drag = null;
let toastTimer = 0;

/* ----------------------------------------------------------------- Helfer */

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2400);
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------- Bubbleliste */

function renderBubbles() {
  const open = game.openCountries();
  const list = shuffled
    ? open.map((c) => [Math.random(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1])
    : [...open].sort((a, b) => a.name.localeCompare(b.name, 'de'));

  ui.bubbles.textContent = '';
  for (const country of list) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'bubble';
    node.dataset.id = country.id;
    node.textContent = country.name;
    if (country.id === selectedId) node.classList.add('is-selected');
    node.addEventListener('pointerdown', (ev) => startDrag(ev, { kind: 'bubble', countryId: country.id, node }));
    ui.bubbles.append(node);
  }
  ui.panelEmpty.hidden = list.length > 0;
  ui.bubbles.hidden = list.length === 0;
  updateProgress();
}

function bubbleNode(countryId) {
  return ui.bubbles.querySelector(`.bubble[data-id="${countryId}"]`);
}

function updateProgress() {
  ui.placed.textContent = String(game.placedCount);
  ui.total.textContent = `/ ${game.total} platziert`;
  ui.evaluate.disabled = game.placedCount === 0 || game.mode === 'review';
}

/* ------------------------------------------------------------- Platzieren */

function placeCountry(targetId, countryId) {
  const occupant = game.occupant(targetId);
  if (occupant && occupant !== countryId) {
    map.flashReject(targetId);
    toast(`Dort liegt schon „${game.name(occupant)}“.`);
    return false;
  }
  game.place(targetId, countryId);
  map.setState(targetId, 'is-placed');
  map.setLabel(targetId, { text: game.name(countryId) });
  ui.hint.hidden = true;
  return true;
}

/** Bubble wieder von der Karte nehmen. */
function liftCountry(targetId) {
  const countryId = game.lift(targetId);
  if (!countryId) return null;
  map.setState(targetId);
  map.removeLabel(targetId);
  return countryId;
}

function select(countryId) {
  selectedId = selectedId === countryId ? null : countryId;
  for (const node of ui.bubbles.children) {
    node.classList.toggle('is-selected', node.dataset.id === selectedId);
  }
  if (selectedId) toast(`„${game.name(selectedId)}“ ausgewählt – jetzt auf den Umriss tippen.`);
}

/* ------------------------------------------------------- Drag & Drop */

function startDrag(ev, source) {
  if (game.mode !== 'play') return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  if (drag) return;
  ev.preventDefault();
  drag = {
    pointerId: ev.pointerId,
    source,
    countryId: source.countryId,
    startX: ev.clientX,
    startY: ev.clientY,
    active: false,
    target: null,
  };
}

function activateDrag(ev) {
  const { source } = drag;
  if (source.kind === 'label') {
    // Schild von der Karte pflücken: Umriss wird sofort wieder frei
    const countryId = liftCountry(source.targetId);
    if (!countryId) { drag = null; return; }
    drag.countryId = countryId;
  } else {
    source.node.classList.add('is-source');
  }
  drag.active = true;
  document.body.classList.add('is-dragging');
  ui.ghost.textContent = game.name(drag.countryId);
  ui.ghost.hidden = false;
  moveGhost(ev.clientX, ev.clientY);
  selectedId = null;
  for (const node of ui.bubbles.children) node.classList.remove('is-selected');
}

function moveGhost(x, y) {
  ui.ghost.style.left = `${x}px`;
  ui.ghost.style.top = `${y}px`;
}

function onPointerMove(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 5) return;
    activateDrag(ev);
    if (!drag) return;
  }
  moveGhost(ev.clientX, ev.clientY);
  const hit = map.countryAt(ev.clientX, ev.clientY);
  drag.target = hit ? hit.id : null;
  map.setHover(drag.target);
  ui.ghost.classList.toggle('is-over', !!drag.target);
}

function onPointerUp(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { source, active, countryId, target } = drag;

  if (!active) {
    // Kein Ziehen, sondern ein Klick
    drag = null;
    if (source.kind === 'bubble') {
      select(source.countryId);
    } else {
      const lifted = liftCountry(source.targetId);
      if (lifted) {
        renderBubbles();
        toast(`„${game.name(lifted)}“ liegt wieder in der Liste.`);
      }
    }
    return;
  }

  drag = null;
  document.body.classList.remove('is-dragging');
  ui.ghost.hidden = true;
  ui.ghost.classList.remove('is-over');
  map.setHover(null);

  let placed = false;
  if (target) placed = placeCountry(target, countryId);

  if (!placed && source.kind === 'label') {
    // Zurück auf den alten Umriss legen
    placeCountry(source.targetId, countryId);
  }
  if (source.kind === 'bubble') source.node.classList.remove('is-source');
  renderBubbles();
}

function onPointerCancel(ev) {
  if (!drag || ev.pointerId !== drag.pointerId) return;
  const { source, active, countryId } = drag;
  drag = null;
  document.body.classList.remove('is-dragging');
  ui.ghost.hidden = true;
  map.setHover(null);
  if (active && source.kind === 'label') placeCountry(source.targetId, countryId);
  if (source.kind === 'bubble') source.node.classList.remove('is-source');
  renderBubbles();
}

/* ------------------------------------------------------------- Auswertung */

function showReview() {
  const result = game.evaluate();
  game.mode = 'review';

  for (const { targetId, countryId } of result.correct) {
    map.setState(targetId, 'is-correct');
    map.setLabel(targetId, { text: game.name(countryId), variant: 'is-correct is-review' });
  }
  for (const { targetId, countryId } of result.wrong) {
    map.setState(targetId, 'is-wrong');
    map.setLabel(targetId, {
      text: game.name(countryId),
      truth: game.name(targetId),
      variant: 'is-wrong is-review',
    });
  }
  for (const targetId of result.open) {
    map.setState(targetId, 'is-missing');
    map.setLabel(targetId, { text: game.name(targetId), variant: 'is-missing is-review' });
  }

  $('score-correct').textContent = String(result.correct.length);
  $('score-wrong').textContent = String(result.wrong.length);
  $('score-open').textContent = String(result.open.length);
  const quote = result.total ? Math.round((result.correct.length / result.total) * 100) : 0;
  ui.reviewText.textContent =
    `${result.correct.length} von ${result.total} richtig – ${quote} %.` +
    (result.open.length ? ' Graue Namen zeigen, was noch fehlt.' : '');
  ui.review.hidden = false;
  ui.hint.hidden = true;
  updateProgress();
}

function leaveReview() {
  game.mode = 'play';
  ui.review.hidden = true;
  map.clearStates();
  map.clearLabels();
  for (const [targetId, countryId] of game.placements) {
    map.setState(targetId, 'is-placed');
    map.setLabel(targetId, { text: game.name(countryId) });
  }
  updateProgress();
}

/* ------------------------------------------------------------ Regionswahl */

function renderTabs(activeId) {
  ui.regions.textContent = '';
  let group = null;
  for (const region of regionIndex) {
    if (group !== null && region.group !== group) {
      const sep = document.createElement('span');
      sep.className = 'regions__sep';
      sep.setAttribute('aria-hidden', 'true');
      ui.regions.append(sep);
    }
    group = region.group;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'region-tab';
    tab.textContent = region.name;
    if (region.id === activeId) tab.setAttribute('aria-current', 'true');
    tab.addEventListener('click', () => {
      if (region.id !== activeId) location.hash = region.id;
    });
    ui.regions.append(tab);
  }
}

async function openRegion(id) {
  ui.loading.hidden = false;
  ui.loading.textContent = 'Karte wird geladen …';
  try {
    const data = await loadJSON(`data/${id}.json`);
    map?.destroy();
    map = new MapView(ui.mapWrap, data);
    map.onLabelPointerDown = (ev, targetId) => {
      if (game.mode !== 'play') return;
      ev.stopPropagation();
      startDrag(ev, { kind: 'label', targetId });
    };
    game = new Game(data);
    selectedId = null;

    map.svg.addEventListener('click', onMapClick);
    map.svg.addEventListener('mousemove', onMapHover);
    map.svg.addEventListener('mouseleave', () => { if (!drag) map.setHover(null); });

    for (const [targetId, countryId] of game.placements) {
      map.setState(targetId, 'is-placed');
      map.setLabel(targetId, { text: game.name(countryId) });
    }
    renderTabs(id);
    ui.panelTitle.textContent = data.unit ?? 'Länder';
    renderBubbles();
    ui.review.hidden = true;
    ui.hint.hidden = game.placedCount > 0;
    ui.loading.hidden = true;
  } catch (err) {
    ui.loading.hidden = false;
    ui.loading.textContent = `Karte konnte nicht geladen werden (${err.message}).`;
  }
}

function onMapClick(ev) {
  if (!selectedId || game.mode !== 'play') return;
  const hit = map.countryAt(ev.clientX, ev.clientY);
  if (!hit) return;
  if (placeCountry(hit.id, selectedId)) {
    selectedId = null;
    renderBubbles();
  }
}

function onMapHover(ev) {
  if (drag || game.mode !== 'play') return;
  if (!selectedId) { map.setHover(null); return; }
  const hit = map.countryAt(ev.clientX, ev.clientY);
  map.setHover(hit ? hit.id : null);
}

/* -------------------------------------------------------------------- Start */

function wireControls() {
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);

  ui.evaluate.addEventListener('click', showReview);
  ui.continue.addEventListener('click', leaveReview);
  ui.restart.addEventListener('click', () => { game.reset(); leaveReview(); renderBubbles(); });
  ui.reset.addEventListener('click', () => {
    if (!game.placedCount) return;
    game.reset();
    leaveReview();
    renderBubbles();
    ui.hint.hidden = false;
  });
  ui.shuffle.addEventListener('click', () => {
    shuffled = !shuffled;
    ui.shuffle.textContent = shuffled ? 'A–Z' : 'Mischen';
    renderBubbles();
  });

  for (const button of document.querySelectorAll('.zoom button')) {
    button.addEventListener('click', () => {
      const how = button.dataset.zoom;
      if (how === 'reset') map.resetView();
      else map.zoomBy(how === 'in' ? 1 / 1.4 : 1.4);
    });
  }

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (regionIndex.some((r) => r.id === id)) openRegion(id);
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && selectedId) select(selectedId);
  });
}

async function boot() {
  try {
    const index = await loadJSON('data/regions.json');
    regionIndex = index.regions;
  } catch (err) {
    ui.loading.textContent = `Regionen konnten nicht geladen werden (${err.message}).`;
    return;
  }
  wireControls();
  const wanted = location.hash.slice(1);
  const start = regionIndex.some((r) => r.id === wanted) ? wanted : regionIndex[0].id;
  await openRegion(start);
}

boot();
