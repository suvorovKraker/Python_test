from collections import defaultdict
from dataclasses import dataclass

import httpx
from fastapi import HTTPException
from shapely.geometry import LineString, MultiLineString, mapping, shape

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
SPB_VIEWBOX = "29.4,59.7,30.8,60.2"
BUFFER_METERS = 3
STREET_WIDTH_METERS = 10


@dataclass
class GeocodeResult:
    display_name: str
    short_name: str
    base_name: str
    landmark: str
    pick_id: str
    lat: float
    lng: float
    boundingbox: list[str] | None
    geojson: dict | None
    is_duplicate_group: bool = False


def _format_base_name(item: dict) -> str:
    address = item.get("address") or {}
    road = address.get("road") or address.get("pedestrian") or address.get("footway") or address.get("street")
    if road:
        return road
    parts = item.get("display_name", "").split(",")
    return parts[0].strip() if parts else item.get("display_name", "")


def _extract_landmark(item: dict) -> str:
    address = item.get("address") or {}
    display = item.get("display_name", "")
    parts = [p.strip() for p in display.split(",") if p.strip()]
    road = address.get("road") or address.get("pedestrian") or address.get("street") or address.get("footway")

    for key, fmt in (("subway", "метро {}"), ("station", "метро {}"), ("railway", "{}")):
        if address.get(key):
            val = address[key]
            return fmt.format(val).replace("метро метро", "метро")

    for key, fmt in (
        ("park", "парк {}"),
        ("garden", "сад {}"),
        ("forest", "лесопарк {}"),
        ("square", "площадь {}"),
    ):
        if address.get(key):
            return fmt.format(address[key])

    landmark_words = ("ботаническ", "сквер", "парк", "музей", "театр", "сад", "мост", "вокзал", "рынок", "монастыр")
    for part in parts:
        low = part.lower()
        if any(w in low for w in landmark_words) and (not road or road.lower() not in low):
            return f"около {part}"

    if road:
        for part in parts[1:6]:
            if not part or road.lower() in part.lower():
                continue
            low = part.lower()
            if any(w in low for w in ("переулок", "проспект", "набережная", "бульвар", "линия", "шоссе", "проезд")):
                return f"пересечение с {part}"
            if "улица" in low and road.lower() not in low:
                return f"пересечение с {part}"

    for key in ("neighbourhood", "suburb", "city_district", "quarter"):
        if address.get(key):
            return address[key]

    house = address.get("house_number")
    if house:
        return f"дом {house}"

    if len(parts) > 2:
        return parts[1][:50]
    return "участок"


def _meters_to_degrees(meters: float, lat: float) -> float:
    import math

    return meters / (111_320 * max(0.2, abs(math.cos(math.radians(lat)))))


def _buffer_geojson(geojson: dict, meters: float = BUFFER_METERS) -> dict:
    geom = shape(geojson)
    lat = geom.centroid.y
    buffered = geom.buffer(_meters_to_degrees(meters, lat))
    return mapping(buffered)


def _line_to_street_polygon(geojson: dict, width_meters: float = STREET_WIDTH_METERS) -> dict | None:
    geom = shape(geojson)
    if isinstance(geom, LineString):
        lines = [geom]
    elif isinstance(geom, MultiLineString):
        lines = list(geom.geoms)
    else:
        return None

    lat = lines[0].centroid.y
    width_deg = _meters_to_degrees(width_meters, lat)
    parts = [line.buffer(width_deg, cap_style=2, join_style=2) for line in lines if line.length > 0]
    if not parts:
        return None
    merged = parts[0]
    for part in parts[1:]:
        merged = merged.union(part)
    return mapping(merged)


def _normalize_geojson(item: dict) -> dict | None:
    geojson = item.get("geojson")
    if geojson:
        gtype = geojson.get("type")
        if gtype in {"Polygon", "MultiPolygon"}:
            try:
                return _buffer_geojson(geojson)
            except Exception:
                return geojson
        if gtype in {"LineString", "MultiLineString"}:
            try:
                street_poly = _line_to_street_polygon(geojson)
                if street_poly:
                    return _buffer_geojson(street_poly, BUFFER_METERS)
            except Exception:
                pass

    bbox_poly = _bbox_to_polygon(item.get("boundingbox"))
    if bbox_poly:
        try:
            return _buffer_geojson(bbox_poly, BUFFER_METERS)
        except Exception:
            return bbox_poly
    return None


def _disambiguate_results(results: list[GeocodeResult]) -> list[GeocodeResult]:
    groups: dict[str, list[GeocodeResult]] = defaultdict(list)
    for result in results:
        groups[result.base_name.lower()].append(result)

    for group in groups.values():
        if len(group) <= 1:
            continue
        used_landmarks: set[str] = set()
        for idx, result in enumerate(group):
            landmark = result.landmark
            if landmark in used_landmarks:
                landmark = f"{landmark} — участок {idx + 1}"
            used_landmarks.add(landmark)
            result.landmark = landmark
            result.short_name = f"{result.base_name} ({landmark})"
            result.is_duplicate_group = True
    return results


async def search_streets(query: str, limit: int = 15) -> list[GeocodeResult]:
    if len(query.strip()) < 2:
        return []

    params = {
        "q": f"{query}, Санкт-Петербург",
        "format": "json",
        "addressdetails": 1,
        "polygon_geojson": 1,
        "limit": limit,
        "viewbox": SPB_VIEWBOX,
        "bounded": 1,
        "countrycodes": "ru",
    }
    headers = {"User-Agent": "ParkingSPB/1.0 (local admin tool)"}

    async with httpx.AsyncClient(timeout=12.0) as client:
        response = await client.get(NOMINATIM_URL, params=params, headers=headers)
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="Сервис геокодинга недоступен")

    results: list[GeocodeResult] = []
    raw_items = response.json()
    raw_items.sort(key=lambda item: 0 if item.get("class") == "highway" else 1)
    for item in raw_items:
        geojson = _normalize_geojson(item)
        if not geojson:
            continue
        base_name = _format_base_name(item)
        landmark = _extract_landmark(item)
        pick_id = f"{item.get('osm_type', 'x')}_{item.get('osm_id', item.get('place_id', len(results)))}"
        results.append(
            GeocodeResult(
                display_name=item.get("display_name", query),
                short_name=base_name,
                base_name=base_name,
                landmark=landmark,
                pick_id=pick_id,
                lat=float(item["lat"]),
                lng=float(item["lon"]),
                boundingbox=item.get("boundingbox"),
                geojson=geojson,
            )
        )
    return _disambiguate_results(results)


def _bbox_to_polygon(bbox: list[str] | None) -> dict | None:
    if not bbox or len(bbox) != 4:
        return None
    south, north, west, east = map(float, bbox)
    return {
        "type": "Polygon",
        "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    }
