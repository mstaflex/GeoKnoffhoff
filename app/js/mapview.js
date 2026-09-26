/* Karten-Ansicht: SVG aufbauen, Umrisse treffen, Zoom/Pan, Namensschilder. */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Fangbreite um schmale Laender (SVG-Einheiten) - macht Kleinstaaten treffbar. */
const HIT_STROKE = 9;
const MAX_ZOOM = 14;
/** Ausweichplaetze fuer Namensschilder, nach Abstand zum Ankerpunkt sortiert. */
const CANDIDATES = [
  [0, 0],
  [0, -15], [0, 15], [-30, 0], [30, 0],
  [0, -28], [0, 28], [-32, -16], [32, -16], [-32, 16], [32, 16],
  [0, -42], [0, 42], [-58, 0], [58, 0],
  [-58, -28], [58, -28], [-58, 28], [58, 28],
  [0, -58], [0, 58], [-86, 0], [86, 0],
];
/**
 * Fuer kleine Laender: das Schild deckt den Umriss sonst komplett zu. Also
 * bewusst daneben legen - senkrecht zuerst, weil die Schilder breit sind.
 */
const CANDIDATES_SMALL = [
  [0, -24], [0, 24], [0, -40], [0, 40],
  [-72, -24], [72, -24], [-72, 24], [72, 24],
  [0, -58], [0, 58], [-100, 0], [100, 0],
  [-100, -40], [100, -40], [-100, 40], [100, 40],
];

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

export class MapView {
  /**
   * @param {HTMLElement} host Container, der die Karte fuellt.
   * @param {object} region Vorberechnete Regionsdaten aus app/data/.
   */
  constructor(host, region) {
    this.host = host;
    this.region = region;
    this.hoverId = null;
    this.labels = new Map(); // countryId -> {node, w, h, anchor:{x,y}, leader}
    this.onLabelPointerDown = null;

    host.textContent = '';

    const svg = el('svg', {
      viewBox: `0 0 ${region.width} ${region.height}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    svg.append(this.#defs());
    this.svg = svg;

    const context = el('g', { class: 'layer-context' });
    const land = el('g', { class: 'layer-land' });
    const hit = el('g', { class: 'layer-hit', 'pointer-events': 'none' });
    this.leaders = el('g', { class: 'layer-leaders' });

    /** @type {Map<string, {id:string,name:string,area:number,label:number[],node:SVGPathElement,hit:SVGPathElement,bbox:DOMRect}>} */
    this.countries = new Map();

    for (const c of region.countries) {
      const playable = !!c.play;
      // Spielbar > Kleinstaat im Spielgebiet > Nachbarschaft (gedimmt)
      const cls = playable ? 'country' : c.dim ? 'country country--context' : 'country country--extra';
      const node = el('path', { d: c.path, class: cls });
      if (playable) {
        node.dataset.id = c.id;
        land.append(node);
        const hitPath = el('path', {
          d: c.path,
          fill: 'none',
          stroke: 'transparent',
          'stroke-width': HIT_STROKE,
        });
        hit.append(hitPath);
        this.countries.set(c.id, {
          id: c.id,
          name: c.name,
          area: c.area,
          label: c.label,
          node,
          hit: hitPath,
          bbox: null,
        });
      } else {
        context.append(node);
      }
    }

    svg.append(context, land, hit, this.leaders);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';

    host.append(svg, this.labelLayer);

    // Bounding-Boxen einmalig zwischenspeichern (Vorfilter beim Treffertest)
    for (const c of this.countries.values()) c.bbox = c.node.getBBox();

    this.home = { x: 0, y: 0, w: region.width, h: region.height };
    this.view = { ...this.home };
    this.#initZoomPan();
    this.#observeResize();
  }

  #defs() {
    const defs = el('defs', {});
    // Aufleuchten des getroffenen Umrisses
    const filter = el('filter', {
      id: 'glow',
      x: '-30%', y: '-30%', width: '160%', height: '160%',
      filterUnits: 'objectBoundingBox',
    });
    filter.append(el('feDropShadow', {
      dx: 0, dy: 0, stdDeviation: 3,
      'flood-color': '#22d3ee', 'flood-opacity': 0.95,
    }));
    defs.append(filter);
    return defs;
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.host.textContent = '';
  }

  /* ------------------------------------------------------- Treffererkennung */

  /** Bildschirm- in SVG-Koordinaten. */
  toUserSpace(clientX, clientY) {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return p;
  }

  /** SVG- in Bildschirmkoordinaten (relativ zum Container). */
  toHostSpace(x, y) {
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    const box = this.host.getBoundingClientRect();
    return { x: p.x - box.left, y: p.y - box.top };
  }

  /**
   * Land unter einem Bildschirmpunkt. Fuellung gewinnt vor Fangbreite,
   * bei Ueberlappung das kleinere Land (sonst schluckt der Nachbar den Zwerg).
   */
  countryAt(clientX, clientY) {
    const p = this.toUserSpace(clientX, clientY);
    if (!p) return null;
    const pad = HIT_STROKE / 2 + 1;
    let fill = null;
    let stroke = null;
    for (const c of this.countries.values()) {
      const b = c.bbox;
      if (p.x < b.x - pad || p.x > b.x + b.width + pad) continue;
      if (p.y < b.y - pad || p.y > b.y + b.height + pad) continue;
      if (c.node.isPointInFill(p)) {
        if (!fill || c.area < fill.area) fill = c;
      } else if (c.hit.isPointInStroke(p)) {
        if (!stroke || c.area < stroke.area) stroke = c;
      }
    }
    return fill || stroke;
  }

  /** Umriss aufleuchten lassen (null = keiner). */
  setHover(id) {
    if (this.hoverId === id) return;
    if (this.hoverId) this.countries.get(this.hoverId)?.node.classList.remove('is-hover');
    this.hoverId = id;
    if (id) {
      const c = this.countries.get(id);
      c.node.classList.add('is-hover');
      // ganz nach vorn, damit der Leuchtrand nicht von Nachbarn verdeckt wird
      c.node.parentNode.append(c.node);
    }
  }

  flashReject(id) {
    const c = this.countries.get(id);
    if (!c) return;
    c.node.classList.add('is-reject');
    setTimeout(() => c.node.classList.remove('is-reject'), 360);
  }

  setState(id, ...classes) {
    const c = this.countries.get(id);
    if (!c) return;
    c.node.classList.remove('is-placed', 'is-correct', 'is-wrong', 'is-missing');
    if (classes.length) c.node.classList.add(...classes);
  }

  clearStates() {
    for (const c of this.countries.values()) {
      c.node.classList.remove('is-placed', 'is-correct', 'is-wrong', 'is-missing', 'is-hover');
    }
    this.hoverId = null;
  }

  /* ---------------------------------------------------------------- Labels */

  /**
   * Namensschild setzen/aktualisieren.
   * @param {string} id Land, auf dem das Schild klebt.
   * @param {object} content {text, truth?, variant?}
   */
  setLabel(id, content) {
    const c = this.countries.get(id);
    if (!c) return;
    let entry = this.labels.get(id);
    if (!entry) {
      const node = document.createElement('div');
      node.className = 'label';
      node.dataset.id = id;
      node.addEventListener('pointerdown', (ev) => this.onLabelPointerDown?.(ev, id));
      this.labelLayer.append(node);
      const leader = el('line', { class: 'leader' });
      const dot = el('circle', { class: 'leader-dot', r: 2.6 });
      leader.style.display = 'none';
      dot.style.display = 'none';
      this.leaders.append(leader, dot);
      entry = { node, leader, dot, w: 0, h: 0 };
      this.labels.set(id, entry);
    }
    const { node } = entry;
    node.className = 'label' + (content.variant ? ` ${content.variant}` : '');
    if (content.truth) {
      node.innerHTML = '';
      const wrong = document.createElement('span');
      wrong.className = 'label__wrong';
      wrong.textContent = content.text;
      const truth = document.createElement('span');
      truth.className = 'label__truth';
      truth.textContent = content.truth;
      node.append(wrong, truth);
    } else {
      node.textContent = content.text;
    }
    entry.w = 0; // Neu messen
    this.syncLabels();
  }

  removeLabel(id) {
    const entry = this.labels.get(id);
    if (!entry) return;
    entry.node.remove();
    entry.leader.remove();
    entry.dot.remove();
    this.labels.delete(id);
    this.syncLabels();
  }

  clearLabels() {
    for (const id of [...this.labels.keys()]) this.removeLabel(id);
  }

  setLabelDimmed(id, dimmed) {
    this.labels.get(id)?.node.classList.toggle('is-source', dimmed);
  }

  /**
   * Schilder positionieren. Ankerpunkt ist der Label-Punkt des Landes; bei
   * Ueberlappung wird das Schild versetzt und mit einer Linie angebunden.
   */
  syncLabels() {
    if (!this.labels.size) return;
    const view = this.host.getBoundingClientRect();
    const pxPerUnit = this.svg.getScreenCTM()?.a ?? 1;
    const placed = [];
    const entries = [...this.labels.entries()]
      .map(([id, entry]) => ({ id, entry, country: this.countries.get(id) }))
      .filter((x) => x.country)
      .sort((a, b) => b.country.area - a.country.area); // grosse Laender zuerst

    for (const { entry, country } of entries) {
      if (!entry.w) {
        const r = entry.node.getBoundingClientRect();
        entry.w = r.width;
        entry.h = r.height;
      }
      const anchor = this.toHostSpace(country.label[0], country.label[1]);
      // Nach Abstand sortierte Ausweichplaetze; der erste freie gewinnt, sonst
      // der mit der geringsten Ueberdeckung.
      // Passt das Schild auf das Land? Sonst daneben setzen und anbinden.
      const roomy = country.label[2] * pxPerUnit >= 20;
      const candidates = roomy ? CANDIDATES : CANDIDATES_SMALL;
      let best = candidates[0];
      let bestCost = Infinity;
      for (const cand of candidates) {
        const box = {
          x: anchor.x + cand[0] - entry.w / 2,
          y: anchor.y + cand[1] - entry.h / 2,
          w: entry.w,
          h: entry.h,
        };
        let overlap = 0;
        for (const o of placed) {
          const ox = Math.min(box.x + box.w, o.x + o.w) - Math.max(box.x, o.x);
          const oy = Math.min(box.y + box.h, o.y + o.h) - Math.max(box.y, o.y);
          if (ox > 0 && oy > 0) overlap += ox * oy;
        }
        // Schilder, die aus der Karte rutschen wuerden, sind auch nichts wert
        let outside = 0;
        if (box.x < 0) outside += -box.x;
        if (box.y < 0) outside += -box.y;
        if (box.x + box.w > view.width) outside += box.x + box.w - view.width;
        if (box.y + box.h > view.height) outside += box.y + box.h - view.height;

        const cost = overlap * 3 + Math.hypot(cand[0], cand[1]) + outside * 12;
        if (cost < bestCost) { bestCost = cost; best = cand; }
        if (overlap === 0 && outside === 0) break;
      }
      const x = anchor.x + best[0];
      const y = anchor.y + best[1];
      placed.push({ x: x - entry.w / 2, y: y - entry.h / 2, w: entry.w, h: entry.h });

      entry.node.style.setProperty('--tx', `${x - entry.w / 2}px`);
      entry.node.style.setProperty('--ty', `${y - entry.h / 2}px`);
      entry.node.style.transform = `translate(${x - entry.w / 2}px, ${y - entry.h / 2}px)`;

      if (Math.hypot(best[0], best[1]) < 12) {
        entry.leader.style.display = 'none';
        entry.dot.style.display = 'none';
      } else {
        entry.dot.setAttribute('cx', country.label[0]);
        entry.dot.setAttribute('cy', country.label[1]);
        entry.dot.style.display = '';
        // Vom Land zur Schildkante, in SVG-Koordinaten (skaliert mit der Karte)
        const dx = anchor.x - x;
        const dy = anchor.y - y;
        const t = Math.min(
          dx ? (entry.w / 2) / Math.abs(dx) : Infinity,
          dy ? (entry.h / 2) / Math.abs(dy) : Infinity,
        );
        const edge = this.toUserSpace(view.left + x + dx * t, view.top + y + dy * t);
        entry.leader.setAttribute('x1', country.label[0]);
        entry.leader.setAttribute('y1', country.label[1]);
        entry.leader.setAttribute('x2', edge.x);
        entry.leader.setAttribute('y2', edge.y);
        entry.leader.style.display = '';
      }
    }
  }

  /* ------------------------------------------------------------ Zoom & Pan */

  #applyView() {
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.syncLabels();
  }

  #clampView() {
    const v = this.view;
    const minW = this.home.w / MAX_ZOOM;
    v.w = Math.min(this.home.w, Math.max(minW, v.w));
    v.h = v.w * (this.home.h / this.home.w);
    v.x = Math.min(this.home.w - v.w, Math.max(0, v.x));
    v.y = Math.min(this.home.h - v.h, Math.max(0, v.y));
  }

  /** Um einen Punkt (Bildschirm) zoomen; factor < 1 = naeher ran. */
  zoomBy(factor, clientX, clientY) {
    const before = clientX === undefined ? null : this.toUserSpace(clientX, clientY);
    const v = this.view;
    const anchor = before ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    const relX = (anchor.x - v.x) / v.w;
    const relY = (anchor.y - v.y) / v.h;
    v.w *= factor;
    v.h *= factor;
    this.#clampView();
    v.x = anchor.x - relX * v.w;
    v.y = anchor.y - relY * v.h;
    this.#clampView();
    this.#applyView();
  }

  resetView() {
    this.view = { ...this.home };
    this.#applyView();
  }

  #initZoomPan() {
    this.svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.zoomBy(ev.deltaY > 0 ? 1.18 : 1 / 1.18, ev.clientX, ev.clientY);
    }, { passive: false });

    // Ziehen auf der Karte verschiebt den Ausschnitt (solange nicht gedraggt wird)
    let pan = null;
    this.svg.addEventListener('pointerdown', (ev) => {
      if (document.body.classList.contains('is-dragging')) return;
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      pan = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    });
    this.svg.addEventListener('pointermove', (ev) => {
      if (!pan || ev.pointerId !== pan.id) return;
      const box = this.svg.getBoundingClientRect();
      const scale = this.view.w / box.width;
      const dx = (ev.clientX - pan.x) * scale;
      const dy = (ev.clientY - pan.y) * scale;
      if (!pan.moved && Math.hypot(dx, dy) < 3 * scale) return;
      if (!pan.moved) {
        pan.moved = true;
        this.svg.setPointerCapture(pan.id);
        this.svg.classList.add('is-panning');
      }
      this.view.x = pan.vx - dx;
      this.view.y = pan.vy - dy;
      this.#clampView();
      this.#applyView();
    });
    const endPan = () => {
      if (pan?.moved) this.svg.classList.remove('is-panning');
      pan = null;
    };
    this.svg.addEventListener('pointerup', endPan);
    this.svg.addEventListener('pointercancel', endPan);

    // Zwei-Finger-Zoom
    const pointers = new Map();
    let pinch = null;
    this.svg.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'touch') return;
      pointers.set(ev.pointerId, ev);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
        pan = null;
      }
    });
    this.svg.addEventListener('pointermove', (ev) => {
      if (ev.pointerType !== 'touch' || !pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, ev);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (dist > 0 && pinch.dist > 0) {
          this.zoomBy(pinch.dist / dist, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        }
        pinch.dist = dist;
      }
    });
    const dropPointer = (ev) => {
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    this.svg.addEventListener('pointerup', dropPointer);
    this.svg.addEventListener('pointercancel', dropPointer);
  }

  #observeResize() {
    this.resizeObserver = new ResizeObserver(() => this.syncLabels());
    this.resizeObserver.observe(this.host);
  }
}
