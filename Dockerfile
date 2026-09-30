# GeoKnoffhoff ist eine rein statische Webapp: die Kartendaten liegen als
# fertige JSON-Dateien im Repo (siehe tools/build_regions.py), zur Laufzeit
# wird also weder Netz noch eine Geo-Bibliothek gebraucht. Im Container laeuft
# nur nginx - und zwar ohne root, auf Port 8080.
FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="GeoKnoffhoff" \
      org.opencontainers.image.description="Länder per Drag and Drop auf Kartenumrisse ziehen" \
      org.opencontainers.image.licenses="MIT"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY app/ /usr/share/nginx/html/

# Das Basis-Image setzt bereits USER 101 - hier nur zur Deutlichkeit.
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
