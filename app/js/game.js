/* Spielzustand: welche Bubble liegt auf welchem Umriss, plus Auswertung. */

const STORAGE_PREFIX = 'geoknoffhoff.v1.';

export class Game {
  /** @param {object} region Regionsdaten. */
  constructor(region) {
    this.region = region;
    this.pool = region.countries.filter((c) => c.play);
    /** Umriss-Id -> darauf abgelegte Laender-Id. */
    this.placements = new Map();
    this.mode = 'play'; // 'play' | 'review'
    this.#restore();
  }

  get total() { return this.pool.length; }
  get placedCount() { return this.placements.size; }
  get done() { return this.placements.size === this.pool.length; }

  /** Noch nicht abgelegte Laender. */
  openCountries() {
    const used = new Set(this.placements.values());
    return this.pool.filter((c) => !used.has(c.id));
  }

  /** Liegt auf diesem Umriss schon etwas? */
  occupant(targetId) {
    return this.placements.get(targetId) ?? null;
  }

  place(targetId, countryId) {
    this.placements.set(targetId, countryId);
    this.#save();
  }

  /** Bubble vom Umriss nehmen, gibt die Laender-Id zurueck. */
  lift(targetId) {
    const id = this.placements.get(targetId) ?? null;
    if (id) {
      this.placements.delete(targetId);
      this.#save();
    }
    return id;
  }

  reset() {
    this.placements.clear();
    this.mode = 'play';
    this.#save();
  }

  name(countryId) {
    return this.pool.find((c) => c.id === countryId)?.name ?? countryId;
  }

  /** Ergebnis der Runde. */
  evaluate() {
    const correct = [];
    const wrong = [];
    for (const [targetId, countryId] of this.placements) {
      (targetId === countryId ? correct : wrong).push({ targetId, countryId });
    }
    const open = this.pool
      .filter((c) => !this.placements.has(c.id))
      .map((c) => c.id);
    return { correct, wrong, open, total: this.pool.length };
  }

  /* -------------------------------------------------------------- Speichern */

  get #key() { return STORAGE_PREFIX + this.region.id; }

  #save() {
    try {
      localStorage.setItem(this.#key, JSON.stringify([...this.placements]));
    } catch { /* privater Modus o.ae. - dann eben ohne Speichern */ }
  }

  #restore() {
    let raw = null;
    try {
      raw = localStorage.getItem(this.#key);
    } catch { return; }
    if (!raw) return;
    try {
      const valid = new Set(this.pool.map((c) => c.id));
      for (const [targetId, countryId] of JSON.parse(raw)) {
        if (valid.has(targetId) && valid.has(countryId)) this.placements.set(targetId, countryId);
      }
    } catch { /* kaputter Eintrag: ignorieren */ }
  }
}
