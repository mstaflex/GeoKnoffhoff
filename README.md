# GeoKnoffhoff

Eine Webapp zum Ländertraining: Die Karte zeigt nur die nackten Umrisse einer
Weltregion, am Rand liegen die Ländernamen als Bubbles. Wer eine Bubble auf
einen Umriss zieht, sieht das ganze Land aufleuchten – so ist klar, welcher
Umriss getroffen ist. Beim Loslassen verschwindet die Bubble und der Name
steht als kleines Schild im Land.

**Richtig oder falsch bleibt bis zur Auswertung offen.** Erst der Knopf
„Auswerten“ färbt grün/rot und zeigt, was noch fehlt.

Weltregionen: **Europa, Afrika, Asien, Amerika, Ozeanien** – Länder zuordnen.
Einzelne Länder: **Deutschland** (16 Bundesländer), **USA** (50 Bundesstaaten,
Alaska und Hawaii in eigenen Rahmen), **Ukraine** (27 Regionen).

## Starten

```bash
docker compose up --build        # danach: http://localhost:8080
```

Der Container lauscht auf Port 8080 und ist per Compose nur an `127.0.0.1`
gebunden – für den Zugang aus dem Internet gehört ein Reverse Proxy mit TLS
davor. Ohne Compose:

```bash
docker build -t geoknoffhoff .
docker run -d --name geoknoffhoff \
  -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp --tmpfs /var/cache/nginx \
  --cap-drop ALL --security-opt no-new-privileges:true \
  geoknoffhoff
```

Zum Entwickeln genügt ein beliebiger statischer Server, die App hat keinen
Build-Schritt:

```bash
python3 -m http.server 8000 --directory app
```

## Bedienen

| Aktion | Wie |
| --- | --- |
| Land platzieren | Bubble auf den Umriss ziehen (Maus oder Finger) |
| Alternative ohne Ziehen | Bubble antippen, dann auf den Umriss tippen |
| Korrigieren | Namensschild von der Karte ziehen oder antippen – es geht zurück in die Liste |
| Zoomen | Mausrad, Zwei-Finger-Geste oder die Knöpfe unten rechts |
| Verschieben | Karte ziehen |
| Auswerten | „Auswerten“ – grün = richtig, rot = falsch (mit richtiger Lösung), grau gestrichelt = nicht platziert |

Der Spielstand liegt pro Region im `localStorage` und übersteht einen Reload.
„Weiter üben“ führt aus der Auswertung zurück ins Spiel, ohne etwas zu
verwerfen.

## Wie die Karte entsteht

Zur Laufzeit rechnet die App nichts: `tools/build_regions.py` erzeugt aus den
Natural-Earth-Daten fertige SVG-Pfade. Deshalb braucht der Container weder
Netzzugang noch eine Geo-Bibliothek, und es gibt keinerlei JS-Abhängigkeiten.

Kontinentkarten entstehen aus dem Datensatz 1:50 Mio, Länderkarten aus 1:10 Mio –
Verwaltungseinheiten und Nachbarländer aus derselben Stufe, sonst klaffen an den
Grenzen Lücken.

Der Generator

* projiziert jede Region flächentreu (Lambert azimutal, auf die Region zentriert),
* passt den Ausschnitt an die tatsächliche Landausdehnung an,
* schneidet die Geometrie auf den Kartenausschnitt zu,
* vereinfacht die Umrisse (Douglas-Peucker) und
* sucht je Land den Punkt mit dem größten Abstand zum Rand als Ankerpunkt für
  das Namensschild und
* setzt abgelegene Teile (Alaska, Hawaii) mit eigener Projektion in einen
  Rahmen – sie landen im selben Koordinatensystem, Treffererkennung und
  Beschriftung funktionieren dadurch unverändert.

Neu bauen (lädt die Quelldaten einmalig nach `tools/.cache/`, rund 55 MB):

```bash
python3 tools/build_regions.py              # alle Karten, ca. 20 s
python3 tools/build_regions.py --only usa   # nur eine
```

Die Regionen – Fenster, Zentrum, Sonderfälle wie Russland oder Grönland – stehen
als `REGIONS` und `SUBREGIONS` oben in `tools/build_regions.py`. Spielbar sind
souveräne Staaten bzw. Verwaltungseinheiten ab einer Mindestgröße; Kleinstaaten
und Nachbarregionen werden nur gezeichnet, damit die Karte vollständig aussieht.

Eine Entscheidung, die man kennen sollte: Natural Earth führt **Krim und
Sewastopol unter Russland** (faktische Kontrolle), vergibt im selben Datensatz
aber die ISO-Codes `UA-43` und `UA-40`. Die Ukraine-Karte wählt ihre Einheiten
deshalb über ISO 3166-2 aus – die Krim ist damit Teil der Ukraine, wie es dem
völkerrechtlichen Stand entspricht.

## Aufbau

```
app/
  index.html
  css/style.css
  js/
    main.js      Bedienung: Drag & Drop, Auswahl, Auswertung
    mapview.js   SVG-Karte: Treffererkennung, Zoom/Pan, Namensschilder
    game.js      Spielstand und Ergebnis
  data/          vorgerechnete Regionen (aus tools/build_regions.py)
tools/
  build_regions.py
Dockerfile, nginx.conf, docker-compose.yml
```

Zwei Details, die den Unterschied machen:

* **Treffererkennung** läuft über `isPointInFill` bzw. `isPointInStroke` auf den
  echten Pfaden – nicht über Bounding-Boxen. Bei Überlappung gewinnt das
  kleinere Land, und eine unsichtbare Fangbreite macht auch Luxemburg oder
  Zypern greifbar.
* **Namensschilder** weichen einander aus. Passt ein Schild nicht ins Land,
  landet es daneben und wird mit Punkt und Linie an seinen Umriss angebunden.

## Sicherheit beim Hosten

Die Anwendung hat **keine Laufzeit-Abhängigkeiten**: kein Framework, kein npm-
oder pip-Paket, kein CDN, keine Fonts von fremden Servern, kein Tracking, keine
Cookies, kein Backend, keine Datenbank. Im Browser laufen drei eigene
JavaScript-Dateien, im Container liegt nur nginx mit statischen Dateien. Der
Generator in `tools/` benutzt ausschließlich die Python-Standardbibliothek und
läuft beim Entwickeln, nicht auf dem Server.

Damit bleibt als Angriffsfläche im Wesentlichen nginx selbst – und der wird so
knapp wie möglich gehalten:

| Maßnahme | Wo |
| --- | --- |
| nginx ohne root (uid 101), aktuelles Basis-Image | `Dockerfile` |
| Dateisystem schreibgeschützt, alle Capabilities entzogen, `no-new-privileges` | `docker-compose.yml` |
| nur an `127.0.0.1` gebunden, Speicher- und Prozessgrenze | `docker-compose.yml` |
| nur GET und HEAD, alles andere 405 | `nginx.conf` |
| strenge Content-Security-Policy (`default-src 'none'`, kein `unsafe-inline`) | `nginx.conf` |
| `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP | `nginx.conf` |
| `server_tokens off`, kurze Timeouts, 1 kB Body-Limit | `nginx.conf` |

Die strenge CSP ist nur möglich, weil die Seite wirklich nichts Fremdes lädt –
sie kommt ohne `unsafe-inline` und `unsafe-eval` aus.

**Was du selbst tun solltest:** Ein Basis-Image altert. Baue das Image
regelmäßig neu (`docker compose build --pull`), damit nginx- und
Alpine-Patches ankommen, und scanne es bei Bedarf:

```bash
docker scout cves geoknoffhoff:latest
# oder
trivy image geoknoffhoff:latest
```

## Kartendaten

[Natural Earth](https://www.naturalearthdata.com/) (1:50 m, gemeinfrei), deutsche
Ländernamen aus dem Feld `NAME_DE` des Datensatzes.
