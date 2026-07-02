function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") resolve();
      else existing.addEventListener("load", () => resolve());
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => {
      script.dataset.loaded = "1";
      resolve();
    };
    script.onerror = () => reject(new Error(`Не удалось загрузить: ${src}`));
    document.head.appendChild(script);
  });
}

function geoJsonToYandexCoords(geojson) {
  const geom = geojson.type === "Feature" ? geojson.geometry : geojson;
  if (geom.type === "Polygon") {
    return [geom.coordinates[0].map((c) => [c[1], c[0]])];
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.map((poly) => poly[0].map((c) => [c[1], c[0]]));
  }
  return [];
}

const PICK_COLORS = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316"];

class MapEngine {
  constructor(containerId, center, zoom, mapKeys = {}) {
    this.containerId = containerId;
    this.center = center;
    this.zoom = zoom;
    this.mapKeys = mapKeys;
    this.engine = "yandex";
    this.map = null;
    this.zoneObjects = [];
    this.userMarker = null;
    this.yandexDrawPolygon = null;
    this.pickableObjects = [];
    this.drawnLayer = null;
    this.onDrawCreated = null;
    this._drawingActive = false;
    this._zoneBackup = null;
    this._userPos = null;
  }

  async init() {
    const container = document.getElementById(this.containerId);
    if (!container) throw new Error("Контейнер карты не найден");
    container.innerHTML = "";
    this._destroy();
    return this._initYandex();
  }

  async _initYandex() {
    const key = this.mapKeys.yandex_api_key;
    if (!key) throw new Error("Нет ключа Яндекс.Карт в .env (YANDEX_MAPS_API_KEY)");
    await loadScript(`https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU&load=package.full`);
    await new Promise((resolve) => ymaps.ready(resolve));
    this.engine = "yandex";
    this.map = new ymaps.Map(this.containerId, {
      center: [this.center[0], this.center[1]],
      zoom: this.zoom,
      controls: ["zoomControl", "geolocationControl"],
    });
    return this.map;
  }

  _destroy() {
    this.clearPickableCandidates();
    this._stopDrawing();
    this.zoneObjects = [];
    this.userMarker = null;
    this.drawnLayer = null;
    this.yandexDrawPolygon = null;
    if (this.map) {
      this.map.destroy();
      this.map = null;
    }
  }

  renderZones(zones) {
    this._zoneBackup = zones;
    this.clearZones();
    zones.forEach((zone) => {
      const geo = typeof zone.polygon_geojson === "string"
        ? JSON.parse(zone.polygon_geojson)
        : zone.polygon_geojson;
      this.addZone(geo, zone.name, zone.is_active !== false);
    });
  }

  clearZones() {
    if (!this.map) return;
    this.zoneObjects.forEach((obj) => this.map.geoObjects.remove(obj));
    this.zoneObjects = [];
  }

  addZone(geojson, name = "", active = true) {
    if (!this.map) return;
    const color = active ? "#ef4444" : "#3b82f6";
    const fill = active ? "#ef444466" : "#3b82f688";
    const coords = geoJsonToYandexCoords(geojson);
    const polygon = new ymaps.Polygon(coords, { hintContent: name, balloonContent: name }, {
      fillColor: fill,
      strokeColor: color,
      strokeWidth: 2,
    });
    this.map.geoObjects.add(polygon);
    this.zoneObjects.push(polygon);
  }

  clearPickableCandidates() {
    if (!this.map) return;
    this.pickableObjects.forEach((obj) => this.map.geoObjects.remove(obj));
    this.pickableObjects = [];
  }

  showPickableCandidates(candidates, onPick) {
    if (!this.map) return;
    this.clearPickableCandidates();
    this.clearDrawnPolygon();
    const allCoords = [];
    candidates.forEach((candidate, index) => {
      if (!candidate.geojson) return;
      const color = PICK_COLORS[index % PICK_COLORS.length];
      const coords = geoJsonToYandexCoords(candidate.geojson);
      if (coords.length) allCoords.push(...coords[0]);

      const polygon = new ymaps.Polygon(coords, {
        balloonContent: candidate.short_name,
        hintContent: `${index + 1}. ${candidate.short_name}`,
      }, {
        fillColor: `${color}88`,
        strokeColor: color,
        strokeWidth: 3,
      });
      polygon.events.add("click", () => {
        this.clearPickableCandidates();
        onPick(candidate);
      });
      this.map.geoObjects.add(polygon);
      this.pickableObjects.push(polygon);

      const mark = new ymaps.Placemark([candidate.lat, candidate.lng], {
        iconContent: String(index + 1),
      }, { preset: "islands#redCircleIcon" });
      mark.events.add("click", () => {
        this.clearPickableCandidates();
        onPick(candidate);
      });
      this.map.geoObjects.add(mark);
      this.pickableObjects.push(mark);
    });

    if (allCoords.length) {
      const bounds = ymaps.util.bounds.fromPoints(allCoords);
      this.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 40 });
    }
  }

  setUserMarker(lat, lng) {
    this._userPos = { lat, lng };
    if (!this.map) return;
    if (this.userMarker) this.map.geoObjects.remove(this.userMarker);
    this.userMarker = new ymaps.Placemark([lat, lng], { iconContent: "Вы" }, {
      preset: "islands#blueCircleDotIcon",
    });
    this.map.geoObjects.add(this.userMarker);
    this.map.setCenter([lat, lng], 16);
  }

  fitGeoJson(geojson) {
    const coords = geoJsonToYandexCoords(geojson);
    if (coords.length && this.map) {
      const bounds = ymaps.util.bounds.fromPoints(coords[0]);
      this.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 30 });
    }
  }

  enableDrawing() {
    return !!this.map;
  }

  startDrawingMode() {
    return this._startYandexDrawing();
  }

  finishDrawingMode() {
    this._drawingActive = false;
    if (this.yandexDrawPolygon?.editor) {
      this.yandexDrawPolygon.editor.stopDrawing();
    }
    document.getElementById("draw-finish-btn")?.classList.add("hidden");
  }

  _stopDrawing() {
    if (this.yandexDrawPolygon && this.map) {
      try {
        this.yandexDrawPolygon.editor?.stopDrawing();
        this.yandexDrawPolygon.editor?.stopEditing();
      } catch (_) {}
      this.map.geoObjects.remove(this.yandexDrawPolygon);
      this.yandexDrawPolygon = null;
    }
    this._drawingActive = false;
  }

  _yandexToGeoJson(polygon) {
    if (!polygon?.geometry) return null;
    const coords = polygon.geometry.getCoordinates();
    if (!coords?.length || !coords[0]?.length || coords[0].length < 3) return null;
    const ring = coords[0].map((c) => [c[1], c[0]]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
    return { type: "Polygon", coordinates: [ring] };
  }

  _startYandexDrawing() {
    if (!this.map) return false;
    this.clearPickableCandidates();
    this._stopDrawing();
    this.yandexDrawPolygon = new ymaps.Polygon([[]], {}, {
      editorDrawingCursor: "crosshair",
      fillColor: "rgba(59,130,246,0.35)",
      strokeColor: "#3b82f6",
      strokeWidth: 3,
    });
    this.map.geoObjects.add(this.yandexDrawPolygon);
    this.yandexDrawPolygon.editor.startDrawing();
    this.drawnLayer = this.yandexDrawPolygon;
    this._drawingActive = true;
    document.getElementById("draw-finish-btn")?.classList.remove("hidden");
    this.yandexDrawPolygon.geometry.events.add("change", () => {
      this.drawnLayer = this.yandexDrawPolygon;
      if (this.onDrawCreated) this.onDrawCreated(this.yandexDrawPolygon);
    });
    return true;
  }

  setDrawnPolygon(geojson) {
    if (!this.map) return false;
    this.clearPickableCandidates();
    this._stopDrawing();
    const coords = geoJsonToYandexCoords(geojson);
    if (!coords.length) return false;
    this.yandexDrawPolygon = new ymaps.Polygon(coords, {}, {
      fillColor: "rgba(59,130,246,0.35)",
      strokeColor: "#3b82f6",
      strokeWidth: 3,
    });
    this.map.geoObjects.add(this.yandexDrawPolygon);
    this.drawnLayer = this.yandexDrawPolygon;
    this.fitGeoJson(geojson);
    return true;
  }

  clearDrawnPolygon() {
    this._stopDrawing();
    this.drawnLayer = null;
  }

  getDrawnGeoJson() {
    if (this.yandexDrawPolygon) return this._yandexToGeoJson(this.yandexDrawPolygon);
    return null;
  }
}

async function loadMapConfig() {
  try {
    const response = await fetch("/api/map-config");
    if (!response.ok) return {};
    return response.json();
  } catch {
    return {};
  }
}

function showPageError(message) {
  const el = document.getElementById("page-error");
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
}

window.addEventListener("error", (event) => {
  showPageError(`Ошибка: ${event.message}`);
});
