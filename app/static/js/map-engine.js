const LEAFLET_PROVIDERS = {
  osm: {
    label: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  },
  carto: {
    label: "Carto (светлая)",
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OSM, CARTO",
    maxZoom: 20,
  },
  dark: {
    label: "Carto (тёмная)",
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: "&copy; OSM, CARTO",
    maxZoom: 20,
  },
  satellite: {
    label: "Спутник (Esri)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "&copy; Esri",
    maxZoom: 19,
  },
};

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

class MapEngine {
  constructor(containerId, center, zoom, mapKeys = {}) {
    this.containerId = containerId;
    this.center = center;
    this.zoom = zoom;
    this.mapKeys = mapKeys;
    this.engine = "leaflet";
    this.map = null;
    this.tileLayer = null;
    this.zoneObjects = [];
    this.userMarker = null;
    this.drawnItems = null;
    this.drawControl = null;
    this.drawnLayer = null;
    this.onDrawCreated = null;
    this.onDrawEdited = null;
  }

  getProviders() {
    const providers = { ...LEAFLET_PROVIDERS };
    if (this.mapKeys.yandex_api_key) {
      providers.yandex = { label: "Яндекс.Карты", engine: "yandex" };
    }
    if (this.mapKeys.dgis_api_key) {
      providers.dgis = { label: "2ГИС", engine: "dgis" };
    }
    return providers;
  }

  supportsDrawing(providerId) {
    const providers = this.getProviders();
    const p = providers[providerId];
    return !p?.engine || p.engine === "leaflet";
  }

  async init(providerId = "osm") {
    const container = document.getElementById(this.containerId);
    if (!container) throw new Error("Контейнер карты не найден");
    container.innerHTML = "";
    this._destroy();

    const providers = this.getProviders();
    const provider = providers[providerId] || providers.osm;
    this.engine = provider.engine || "leaflet";

    if (this.engine === "yandex") return this._initYandex(providerId);
    if (this.engine === "dgis") return this._init2GIS(providerId);
    return this._initLeaflet(providerId);
  }

  async _initLeaflet(providerId) {
    this.engine = "leaflet";
    const provider = LEAFLET_PROVIDERS[providerId] || LEAFLET_PROVIDERS.osm;
    this.map = L.map(this.containerId).setView(this.center, this.zoom);
    this.tileLayer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: provider.maxZoom,
    }).addTo(this.map);
    return this.map;
  }

  async _initYandex(providerId) {
    const key = this.mapKeys.yandex_api_key;
    if (!key) throw new Error("Нет ключа Яндекс.Карт");
    await loadScript(`https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU`);
    await new Promise((resolve) => ymaps.ready(resolve));
    this.engine = "yandex";
    this.map = new ymaps.Map(this.containerId, {
      center: [this.center[0], this.center[1]],
      zoom: this.zoom,
      controls: ["zoomControl", "geolocationControl"],
    });
    return this.map;
  }

  async _init2GIS(providerId) {
    const key = this.mapKeys.dgis_api_key;
    if (!key) throw new Error("Нет ключа 2ГИС");
    await loadScript(`https://mapgl.2gis.com/api/js/v1?key=${encodeURIComponent(key)}`);
    this.engine = "dgis";
    this.map = new mapgl.Map(this.containerId, {
      key,
      center: [this.center[1], this.center[0]],
      zoom: this.zoom,
    });
    return this.map;
  }

  _destroy() {
    this.zoneObjects = [];
    this.userMarker = null;
    this.drawnLayer = null;
    if (this.engine === "leaflet" && this.map) {
      this.map.remove();
    } else if (this.engine === "yandex" && this.map) {
      this.map.destroy();
    } else if (this.engine === "dgis" && this.map) {
      this.map.destroy();
    }
    this.map = null;
    this.drawControl = null;
    this.drawnItems = null;
  }

  async setProvider(providerId) {
    const zonesBackup = this._zoneBackup;
    await this.init(providerId);
    if (zonesBackup) this.renderZones(zonesBackup);
    if (this._userPos) this.setUserMarker(this._userPos.lat, this._userPos.lng);
  }

  renderZones(zones) {
    this._zoneBackup = zones;
    this.clearZones();
    zones.forEach((zone) => {
      const geo = typeof zone.polygon_geojson === "string"
        ? JSON.parse(zone.polygon_geojson)
        : zone.polygon_geojson;
      this.addZone(geo, zone.name);
    });
  }

  clearZones() {
    if (this.engine === "leaflet") {
      this.zoneObjects.forEach((layer) => this.map.removeLayer(layer));
    } else if (this.engine === "yandex") {
      this.zoneObjects.forEach((obj) => this.map.geoObjects.remove(obj));
    } else if (this.engine === "dgis") {
      this.zoneObjects.forEach((obj) => obj.destroy());
    }
    this.zoneObjects = [];
  }

  addZone(geojson, name = "") {
    if (this.engine === "leaflet") {
      const layer = L.geoJSON(geojson, {
        style: { color: "#3b82f6", weight: 2, fillOpacity: 0.2 },
      }).bindPopup(name);
      layer.addTo(this.map);
      this.zoneObjects.push(layer);
    } else if (this.engine === "yandex") {
      const coords = geoJsonToYandexCoords(geojson);
      const polygon = new ymaps.Polygon(coords, { hintContent: name }, {
        fillColor: "#3b82f688",
        strokeColor: "#3b82f6",
        strokeWidth: 2,
      });
      this.map.geoObjects.add(polygon);
      this.zoneObjects.push(polygon);
    } else if (this.engine === "dgis") {
      const geom = geojson.type === "Feature" ? geojson.geometry : geojson;
      const rings = geom.type === "Polygon" ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
      rings.forEach((ring) => {
        const polygon = new mapgl.Polygon(this.map, {
          coordinates: [ring],
          color: "#3b82f6",
          opacity: 0.25,
        });
        this.zoneObjects.push(polygon);
      });
    }
  }

  setUserMarker(lat, lng) {
    this._userPos = { lat, lng };
    if (this.engine === "leaflet") {
      if (!this.userMarker) {
        this.userMarker = L.marker([lat, lng]).addTo(this.map).bindPopup("Вы здесь");
      } else {
        this.userMarker.setLatLng([lat, lng]);
      }
      this.map.setView([lat, lng], Math.max(this.map.getZoom(), 15));
    } else if (this.engine === "yandex") {
      if (this.userMarker) this.map.geoObjects.remove(this.userMarker);
      this.userMarker = new ymaps.Placemark([lat, lng], { iconContent: "Вы" }, {
        preset: "islands#blueCircleDotIcon",
      });
      this.map.geoObjects.add(this.userMarker);
      this.map.setCenter([lat, lng], 16);
    } else if (this.engine === "dgis") {
      if (this.userMarker) this.userMarker.destroy();
      this.userMarker = new mapgl.Marker(this.map, {
        coordinates: [lng, lat],
      });
      this.map.setCenter([lng, lat]);
      this.map.setZoom(16);
    }
  }

  fitGeoJson(geojson) {
    if (this.engine === "leaflet") {
      const layer = L.geoJSON(geojson);
      this.map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    } else if (this.engine === "yandex") {
      const coords = geoJsonToYandexCoords(geojson);
      if (coords.length) {
        const bounds = ymaps.util.bounds.fromPoints(coords[0]);
        this.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 30 });
      }
    } else if (this.engine === "dgis") {
      const geom = geojson.type === "Feature" ? geojson.geometry : geojson;
      const ring = geom.coordinates[0];
      const lngs = ring.map((c) => c[0]);
      const lats = ring.map((c) => c[1]);
      const center = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
      this.map.setCenter(center);
      this.map.setZoom(16);
    }
  }

  setView(lat, lng, zoom) {
    if (this.engine === "leaflet") {
      this.map.setView([lat, lng], zoom);
    } else if (this.engine === "yandex") {
      this.map.setCenter([lat, lng], zoom);
    } else if (this.engine === "dgis") {
      this.map.setCenter([lng, lat]);
      this.map.setZoom(zoom);
    }
  }

  enableDrawing() {
    if (this.engine !== "leaflet") return false;
    this.drawnItems = new L.FeatureGroup();
    this.map.addLayer(this.drawnItems);
    this.drawControl = new L.Control.Draw({
      draw: {
        polygon: true,
        polyline: false,
        rectangle: true,
        circle: false,
        marker: false,
        circlemarker: false,
      },
      edit: { featureGroup: this.drawnItems },
    });
    this.map.addControl(this.drawControl);
    this.map.on(L.Draw.Event.CREATED, (event) => {
      this.drawnItems.clearLayers();
      this.drawnLayer = event.layer;
      this.drawnItems.addLayer(this.drawnLayer);
      if (this.onDrawCreated) this.onDrawCreated(this.drawnLayer);
    });
    this.map.on(L.Draw.Event.EDITED, (event) => {
      event.layers.eachLayer((layer) => {
        this.drawnLayer = layer;
        if (this.onDrawEdited) this.onDrawEdited(layer);
      });
    });
    return true;
  }

  setDrawnPolygon(geojson) {
    if (this.engine !== "leaflet") return false;
    if (!this.drawnItems) this.enableDrawing();
    this.drawnItems.clearLayers();
    this.drawnLayer = L.geoJSON(geojson).getLayers()[0];
    if (!this.drawnLayer) return false;
    this.drawnItems.addLayer(this.drawnLayer);
    this.fitGeoJson(geojson);
    return true;
  }

  clearDrawnPolygon() {
    if (this.drawnItems) this.drawnItems.clearLayers();
    this.drawnLayer = null;
  }

  getDrawnGeoJson() {
    if (!this.drawnLayer) return null;
    return this.drawnLayer.toGeoJSON().geometry;
  }
}

function addProviderControl(mapEngine, containerId, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const select = document.createElement("select");
  select.className = "map-provider-select";
  const providers = mapEngine.getProviders();
  Object.entries(providers).forEach(([id, provider]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = provider.label;
    select.appendChild(option);
  });

  const saved = localStorage.getItem("parking_map_provider");
  const initial = saved && providers[saved] ? saved : "osm";
  select.value = initial;

  select.addEventListener("change", async () => {
    try {
      await mapEngine.setProvider(select.value);
      localStorage.setItem("parking_map_provider", select.value);
      if (onChange) onChange(select.value, mapEngine);
    } catch (error) {
      alert(error.message);
      select.value = initial;
    }
  });

  container.innerHTML = "";
  container.appendChild(select);
  return { select, initial };
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
