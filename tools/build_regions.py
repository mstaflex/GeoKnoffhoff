#!/usr/bin/env python3
"""Baut die Kartendaten fuer GeoKnoffhoff aus Natural-Earth-Daten.

Ergebnis: pro Region eine JSON-Datei in app/data/ mit fertig projizierten
SVG-Pfaden, Label-Ankerpunkten und deutschen Laendernamen. Die Webapp muss
zur Laufzeit also nicht rechnen und keine Geo-Bibliothek laden.

    python3 tools/build_regions.py            # laedt Quelldaten bei Bedarf
    python3 tools/build_regions.py --input ne_50m.geojson

Quelle: Natural Earth (public domain) via natural-earth-vector.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request
from typing import Iterable

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_50m_admin_0_countries.geojson"
)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT_DIR = os.path.join(REPO, "app", "data")
CACHE = os.path.join(HERE, ".cache", "ne_50m_admin_0_countries.geojson")

# Breite der Karte in SVG-Einheiten; die Hoehe folgt aus dem Kartenfenster.
VIEW_WIDTH = 1000.0
# Rand um das Kartenfenster (SVG-Einheiten).
PADDING = 6.0
# Vereinfachungstoleranz in SVG-Einheiten (Douglas-Peucker).
SIMPLIFY_TOLERANCE = 0.30
# Ab dieser projizierten Flaeche (SVG-Einheiten^2) ist ein Land bespielbar.
MIN_PLAYABLE_AREA = 16.0
# So viel eines Landes muss im Kartenfenster liegen, damit es bespielbar ist.
MIN_VISIBLE_FRACTION = 0.55
# Zusaetzlicher Rand beim geographischen Vorschnitt (Grad). Der Vorschnitt haelt
# nur die Projektion von weit entfernten Punkten frei - er muss deutlich
# ausserhalb des Kartenausschnitts liegen, sonst sieht man seine geraden
# Schnittkanten mitten in der Karte.
GEO_CLIP_MARGIN = 30.0

# Natural Earth ordnet manche Laender anders zu, als es fuer ein Quiz sinnvoll
# ist (Russland z.B. komplett "Europe"). "force" macht ein Land in einer Region
# spielbar, auch wenn Kontinent oder Sichtbarkeit dagegen sprechen.
REGIONS = [
    {
        "id": "europa",
        "name": "Europa",
        "center": (15.0, 54.0),
        "window": (-25.0, 34.0, 45.0, 71.5),
        "continents": ["Europe"],
        "force": ["TUR", "CYP", "RUS"],
    },
    {
        "id": "afrika",
        "name": "Afrika",
        "center": (18.0, 2.0),
        "window": (-19.0, -36.0, 52.5, 38.0),
        "continents": ["Africa"],
        "force": [],
    },
    {
        "id": "asien",
        "name": "Asien",
        "center": (85.0, 27.0),
        "window": (25.0, -11.0, 147.0, 57.0),
        "continents": ["Asia"],
        "force": ["RUS", "KAZ"],
    },
    {
        "id": "amerika",
        "name": "Amerika",
        "center": (-85.0, 12.0),
        "window": (-170.0, -56.0, -30.0, 73.0),
        "continents": ["North America", "South America"],
        # Groenland ragt ueber den rechten Fensterrand hinaus, gehoert aber dazu
        "force": ["GRL"],
    },
    {
        "id": "ozeanien",
        "name": "Ozeanien",
        "center": (152.0, -20.0),
        "window": (110.0, -48.0, 190.0, 12.0),
        "continents": ["Oceania"],
        "force": [],
    },
]

# Laender, die im Quiz nichts zu suchen haben (umstritten bzw. nicht allgemein
# anerkannt). Sie werden weiter gezeichnet, aber nicht als Bubble ausgegeben.
PLAYABLE_TYPES = ("Sovereign country", "Sovereignty")

# Gebiete, die Natural Earth als Land fuehrt, die aber kein Quiz-Land sind.
NOT_PLAYABLE = {
    "SOL",  # Somaliland
    "CYN",  # Nordzypern
    "ALD",  # Åland (autonomer Teil Finnlands)
}

# Kuerzere / gaengigere deutsche Namen, wo Natural Earth sperrig ist.
NAME_OVERRIDES = {
    "USA": "USA",
    "CHN": "China",
    "CYP": "Zypern",
    "MDA": "Moldau",
    "PRK": "Nordkorea",
    "KOR": "Südkorea",
    "TWN": "Taiwan",
    "GBR": "Vereinigtes Königreich",
    "CZE": "Tschechien",
    "COD": "DR Kongo",
    "COG": "Republik Kongo",
    "CAF": "Zentralafrikanische Rep.",
    "ARE": "Ver. Arab. Emirate",
    "BIH": "Bosnien-Herzegowina",
    "MKD": "Nordmazedonien",
    "PNG": "Papua-Neuguinea",
    "FSM": "Mikronesien",
    "SWZ": "Eswatini",
    "TTO": "Trinidad und Tobago",
    "STP": "São Tomé und Príncipe",
    "DOM": "Dominikanische Rep.",
    "KNA": "St. Kitts und Nevis",
    "VCT": "St. Vincent u. d. Gren.",
    "ATG": "Antigua und Barbuda",
    "SSD": "Südsudan",
    "MMR": "Myanmar",
    "TLS": "Timor-Leste",
    "CIV": "Elfenbeinküste",
    "NLD": "Niederlande",
}


# --------------------------------------------------------------------------
# Geometrie-Helfer
# --------------------------------------------------------------------------


def norm_lon(lon: float, center: float) -> float:
    """Longitude so verschieben, dass sie stetig um center liegt (Datumsgrenze)."""
    d = lon - center
    while d > 180.0:
        d -= 360.0
    while d < -180.0:
        d += 360.0
    return center + d


def unwrap_ring(ring, center: float):
    """Ring an der Datumsgrenze zusammenhalten.

    Punktweises Normalisieren zerreisst Ringe, die mehr als 180 Grad vom
    Kartenzentrum entfernt liegen (z.B. Alaska): ein Teil landet bei -168, der
    andere bei +192, und der anschliessende Schnitt liefert Unsinn. Deshalb wird
    der Ring fortlaufend entfaltet und danach als Ganzes so verschoben, dass er
    moeglichst nah am Zentrum liegt.
    """
    out = []
    prev = None
    for lon, lat in ring:
        if prev is None:
            lon = norm_lon(lon, center)
        else:
            while lon - prev > 180.0:
                lon -= 360.0
            while lon - prev < -180.0:
                lon += 360.0
        out.append((lon, lat))
        prev = lon
    mean = sum(p[0] for p in out) / len(out)
    shift = 0.0
    while mean + shift - center > 180.0:
        shift -= 360.0
    while mean + shift - center < -180.0:
        shift += 360.0
    if shift:
        out = [(p[0] + shift, p[1]) for p in out]
    return out


def clip_ring(ring: list[tuple[float, float]], rect) -> list[tuple[float, float]]:
    """Sutherland-Hodgman: Ring gegen ein Rechteck (x0, y0, x1, y1) schneiden."""
    x0, y0, x1, y1 = rect
    edges = (
        ("x", 1, x0),  # innen: x >= x0
        ("x", -1, x1),  # innen: x <= x1
        ("y", 1, y0),
        ("y", -1, y1),
    )
    poly = ring
    for axis, sign, limit in edges:
        if not poly:
            return []
        idx = 0 if axis == "x" else 1

        def inside(p, idx=idx, sign=sign, limit=limit):
            return (p[idx] - limit) * sign >= 0

        out: list[tuple[float, float]] = []
        n = len(poly)
        for i in range(n):
            cur = poly[i]
            prv = poly[(i - 1) % n]
            cur_in = inside(cur)
            prv_in = inside(prv)
            if cur_in != prv_in:
                # Schnittpunkt mit der Kante
                d = cur[idx] - prv[idx]
                t = 0.0 if d == 0 else (limit - prv[idx]) / d
                ix = prv[0] + (cur[0] - prv[0]) * t
                iy = prv[1] + (cur[1] - prv[1]) * t
                out.append((ix, iy))
            if cur_in:
                out.append(cur)
        poly = out
    return poly


def ring_area(ring: Iterable[tuple[float, float]]) -> float:
    """Betrag der Shoelace-Flaeche."""
    pts = list(ring)
    if len(pts) < 3:
        return 0.0
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def geo_area(ring: Iterable[tuple[float, float]]) -> float:
    """Grobe Flaeche in Grad^2 mit Breitenkorrektur - reicht als Verhaeltnismass."""
    pts = list(ring)
    if len(pts) < 3:
        return 0.0
    lat_mid = sum(p[1] for p in pts) / len(pts)
    k = math.cos(math.radians(max(-89.0, min(89.0, lat_mid))))
    return ring_area([(p[0] * k, p[1]) for p in pts])


def simplify(ring: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas-Peucker fuer einen geschlossenen Ring."""
    if len(ring) < 5:
        return ring

    def rdp(pts):
        if len(pts) < 3:
            return pts
        ax, ay = pts[0]
        bx, by = pts[-1]
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        worst, idx = -1.0, 0
        for i in range(1, len(pts) - 1):
            px, py = pts[i]
            if seg == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / seg
            if d > worst:
                worst, idx = d, i
        if worst <= tol:
            return [pts[0], pts[-1]]
        left = rdp(pts[: idx + 1])
        right = rdp(pts[idx:])
        return left[:-1] + right

    # Ring an der laengsten Diagonale aufteilen, damit der Start nicht fixiert wird
    closed = ring + [ring[0]]
    half = len(closed) // 2
    out = rdp(closed[: half + 1])[:-1] + rdp(closed[half:])[:-1]
    return out if len(out) >= 3 else ring


def point_in_polygon(x: float, y: float, rings: list[list[tuple[float, float]]]) -> bool:
    """Even-odd-Test ueber alle Ringe (Loecher inklusive)."""
    inside = False
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xx = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
                if xx > x:
                    inside = not inside
    return inside


def dist_to_rings(x: float, y: float, rings) -> float:
    best = float("inf")
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]
            x2, y2 = ring[(i + 1) % n]
            dx, dy = x2 - x1, y2 - y1
            l2 = dx * dx + dy * dy
            if l2 == 0:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / l2))
                d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
            if d < best:
                best = d
    return best


def pole_of_inaccessibility(rings) -> tuple[float, float, float]:
    """Punkt mit maximalem Abstand zum Rand (Gitter + lokale Verfeinerung)."""
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    w, h = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
    steps = 24
    best = (x0 + w / 2, y0 + h / 2, -1.0)
    for i in range(steps + 1):
        for j in range(steps + 1):
            x = x0 + w * i / steps
            y = y0 + h * j / steps
            if not point_in_polygon(x, y, rings):
                continue
            d = dist_to_rings(x, y, rings)
            if d > best[2]:
                best = (x, y, d)
    if best[2] < 0:  # sehr schmales Gebilde: Schwerpunkt nehmen
        return (x0 + w / 2, y0 + h / 2, 0.0)
    step = max(w, h) / steps
    bx, by, bd = best
    for _ in range(5):
        step *= 0.55
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            x, y = bx + dx * step, by + dy * step
            if not point_in_polygon(x, y, rings):
                continue
            d = dist_to_rings(x, y, rings)
            if d > bd:
                bx, by, bd = x, y, d
    return (bx, by, bd)


# --------------------------------------------------------------------------
# Projektion: Lambert azimutal flaechentreu, auf das Fenster eingepasst
# --------------------------------------------------------------------------


class Projection:
    def __init__(self, lon0: float, lat0: float):
        self.lon0 = lon0
        self.lat0 = math.radians(lat0)
        self.scale = 1.0
        self.tx = 0.0
        self.ty = 0.0

    def raw(self, lon: float, lat: float) -> tuple[float, float]:
        lam = math.radians(norm_lon(lon, self.lon0) - self.lon0)
        phi = math.radians(max(-89.999, min(89.999, lat)))
        sp, cp = math.sin(phi), math.cos(phi)
        sl, cl = math.sin(self.lat0), math.cos(self.lat0)
        cos_c = sl * sp + cl * cp * math.cos(lam)
        cos_c = max(-1.0, min(1.0, cos_c))
        k = math.sqrt(2.0 / max(1e-9, 1.0 + cos_c))
        x = k * cp * math.sin(lam)
        y = k * (cl * sp - sl * cp * math.cos(lam))
        return (x, -y)  # SVG: y nach unten

    def __call__(self, lon: float, lat: float) -> tuple[float, float]:
        x, y = self.raw(lon, lat)
        return (x * self.scale + self.tx, y * self.scale + self.ty)

    def fit_bbox(self, x0, y0, x1, y1, width: float, padding: float) -> tuple[float, float]:
        """Rohkoordinaten-Bbox auf die Kartenbreite einpassen."""
        bw = max(x1 - x0, 1e-9)
        bh = max(y1 - y0, 1e-9)
        inner = width - 2 * padding
        self.scale = inner / bw
        self.tx = padding - x0 * self.scale
        self.ty = padding - y0 * self.scale
        return (width, bh * self.scale + 2 * padding)

    def fit(self, window, width: float, padding: float) -> tuple[float, float]:
        """Auf das Fenster einpassen, gibt (width, height) der Karte zurueck."""
        lon0, lat0, lon1, lat1 = window
        pts = []
        n = 80
        for i in range(n + 1):
            t = i / n
            pts.append(self.raw(lon0 + (lon1 - lon0) * t, lat0))
            pts.append(self.raw(lon0 + (lon1 - lon0) * t, lat1))
            pts.append(self.raw(lon0, lat0 + (lat1 - lat0) * t))
            pts.append(self.raw(lon1, lat0 + (lat1 - lat0) * t))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        inner = width - 2 * padding
        self.scale = inner / bw
        height = bh * self.scale + 2 * padding
        self.tx = padding - min(xs) * self.scale
        self.ty = padding - min(ys) * self.scale
        return (width, height)


# --------------------------------------------------------------------------
# Aufbereitung
# --------------------------------------------------------------------------


def iter_polygons(geom) -> list[list[list[tuple[float, float]]]]:
    """GeoJSON-Geometrie in eine Liste von Polygonen (Ringlisten) uebersetzen."""
    if geom is None:
        return []
    t = geom.get("type")
    if t == "Polygon":
        raw = [geom["coordinates"]]
    elif t == "MultiPolygon":
        raw = geom["coordinates"]
    else:
        return []
    polys = []
    for poly in raw:
        rings = []
        for ring in poly:
            pts = [(float(c[0]), float(c[1])) for c in ring]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                pts = pts[:-1]
            if len(pts) >= 3:
                rings.append(pts)
        if rings:
            polys.append(rings)
    return polys


def geo_clip(rings, window, center_lon):
    """Ringe geographisch auf das (erweiterte) Fenster schneiden."""
    lon0, lat0, lon1, lat1 = window
    rect = (lon0, lat0, lon1, lat1)
    out = []
    for ring in rings:
        shifted = unwrap_ring(ring, center_lon)
        clipped = clip_ring(shifted, rect)
        if len(clipped) >= 3:
            out.append(clipped)
    return out


def path_from_rings(rings) -> str:
    parts = []
    for ring in rings:
        coords = []
        for x, y in ring:
            coords.append(f"{x:.1f} {y:.1f}")
        parts.append("M" + " ".join(coords) + "Z")
    return "".join(parts)


def build_region(cfg, features, report):
    lon_c, lat_c = cfg["center"]
    proj = Projection(lon_c, lat_c)

    # Der Ausschnitt soll am Land der Region kleben, nicht am groben Fenster -
    # sonst steht z.B. bei Amerika der halbe Pazifik im Bild.
    xs: list[float] = []
    ys: list[float] = []
    for feat in features:
        props = feat["properties"]
        iso = props.get("ADM0_A3") or props.get("ISO_A3") or props.get("NAME")
        if props.get("CONTINENT") not in cfg["continents"] and iso not in cfg["force"]:
            continue
        for rings in iter_polygons(feat.get("geometry")):
            for ring in geo_clip(rings, cfg["window"], lon_c):
                for lon, lat in ring:
                    x, y = proj.raw(lon, lat)
                    xs.append(x)
                    ys.append(y)
    if xs:
        width, height = proj.fit_bbox(min(xs), min(ys), max(xs), max(ys), VIEW_WIDTH, PADDING)
    else:
        width, height = proj.fit(cfg["window"], VIEW_WIDTH, PADDING)
    view_rect = (-4.0, -4.0, width + 4.0, height + 4.0)

    lon0, lat0, lon1, lat1 = cfg["window"]
    wide_window = (
        max(-360.0, lon0 - GEO_CLIP_MARGIN),
        max(-90.0, lat0 - GEO_CLIP_MARGIN),
        min(360.0, lon1 + GEO_CLIP_MARGIN),
        min(90.0, lat1 + GEO_CLIP_MARGIN),
    )

    countries = []
    for feat in features:
        props = feat["properties"]
        iso = props.get("ADM0_A3") or props.get("ISO_A3") or props.get("NAME")
        if props.get("CONTINENT") in (None, "Antarctica", "Seven seas (open ocean)"):
            continue

        polys = iter_polygons(feat.get("geometry"))
        if not polys:
            continue

        full_geo = sum(geo_area(r[0]) for r in polys)

        # geographischer Vorschnitt, dann projizieren, dann auf die Karte schneiden
        vis_geo = 0.0
        projected: list[list[list[tuple[float, float]]]] = []
        for rings in polys:
            clipped = geo_clip(rings, wide_window, lon_c)
            if not clipped:
                continue
            # Sichtbarkeitsquote am exakten Fenster messen, nicht am Vorschnitt
            exact = geo_clip(rings, cfg["window"], lon_c)
            if exact:
                vis_geo += geo_area(exact[0])
            proj_rings = []
            for ring in clipped:
                pr = [proj(lon, lat) for lon, lat in ring]
                pr = clip_ring(pr, view_rect)
                if len(pr) >= 3:
                    proj_rings.append(pr)
            if proj_rings:
                projected.append(proj_rings)
        if not projected:
            continue

        area_px = sum(ring_area(rings[0]) - sum(ring_area(h) for h in rings[1:]) for rings in projected)
        if area_px < 0.4:  # unsichtbar klein
            continue

        fraction = (vis_geo / full_geo) if full_geo > 0 else 0.0
        forced = iso in cfg["force"]
        in_region = props.get("CONTINENT") in cfg["continents"] or forced
        # Natural Earth fuehrt auch Kronbesitzungen und autonome Gebiete als
        # "Country" - die sind kein Quiz-Land. Souveraen ist, wer sich selbst
        # gehoert (SOVEREIGNT == NAME), alles andere nur auf Ansage.
        sovereign = props.get("TYPE") in PLAYABLE_TYPES or (
            props.get("TYPE") == "Country" and props.get("SOVEREIGNT") == props.get("NAME")
        )
        playable = (
            in_region
            and (sovereign or forced)
            and iso not in NOT_PLAYABLE
            and area_px >= MIN_PLAYABLE_AREA
            and (fraction >= MIN_VISIBLE_FRACTION or forced)
        )

        # Hauchduenne Schnipsel am Kartenrand (z.B. Neuseeland am linken Rand
        # einer Amerika-Karte) sehen wie Zeichenfehler aus - weglassen.
        if not playable and fraction < 0.08 and area_px < 150:
            continue

        simplified = []
        for rings in projected:
            sr = [simplify(r, SIMPLIFY_TOLERANCE) for r in rings]
            sr = [r for r in sr if len(r) >= 3]
            if sr:
                simplified.append(sr)
        if not simplified:
            continue

        entry = {
            "id": iso,
            "path": path_from_rings([r for rings in simplified for r in rings]),
            "area": round(area_px, 1),
        }
        if not in_region:
            entry["dim"] = True  # Nachbarregion: nur zur Orientierung

        if playable:
            name = NAME_OVERRIDES.get(iso) or props.get("NAME_DE") or props["NAME"]
            # Label in das groesste sichtbare Teilstueck setzen
            biggest = max(simplified, key=lambda rings: ring_area(rings[0]))
            lx, ly, lr = pole_of_inaccessibility(biggest)
            entry["name"] = name
            entry["label"] = [round(lx, 1), round(ly, 1), round(lr, 1)]
            entry["play"] = True

        countries.append(entry)

    playable = [c for c in countries if c.get("play")]
    playable.sort(key=lambda c: c["name"])
    report.append(
        {
            "region": cfg["name"],
            "playable": len(playable),
            "context": len(countries) - len(playable),
            "size": f"{width:.0f}x{height:.0f}",
            "smallest": [(c["name"], c["area"]) for c in sorted(playable, key=lambda c: c["area"])[:6]],
        }
    )

    return {
        "id": cfg["id"],
        "name": cfg["name"],
        "width": round(width, 1),
        "height": round(height, 1),
        "countries": countries,
    }


def load_features(path: str | None):
    src = path or CACHE
    if not path and not os.path.exists(CACHE):
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        print(f"lade {SOURCE_URL}", file=sys.stderr)
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp, open(CACHE, "wb") as fh:
            fh.write(resp.read())
    with open(src, "r", encoding="utf-8") as fh:
        return json.load(fh)["features"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", help="lokale ne_50m_admin_0_countries.geojson")
    ap.add_argument("--out", default=OUT_DIR, help="Ausgabeverzeichnis")
    args = ap.parse_args()

    sys.setrecursionlimit(10000)
    features = load_features(args.input)
    os.makedirs(args.out, exist_ok=True)

    report: list[dict] = []
    index = []
    for cfg in REGIONS:
        data = build_region(cfg, features, report)
        out_path = os.path.join(args.out, f"{cfg['id']}.json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        index.append(
            {
                "id": cfg["id"],
                "name": cfg["name"],
                "count": sum(1 for c in data["countries"] if c.get("play")),
            }
        )
        print(f"{cfg['id']:10s} -> {os.path.getsize(out_path)/1024:6.1f} kB")

    with open(os.path.join(args.out, "regions.json"), "w", encoding="utf-8") as fh:
        json.dump({"regions": index}, fh, ensure_ascii=False, indent=1)

    print()
    for r in report:
        print(f"{r['region']:10s} {r['playable']:3d} spielbar, {r['context']:3d} Kontext, {r['size']}")
        print("           kleinste:", ", ".join(f"{n} ({a:.0f})" for n, a in r["smallest"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
