from dataclasses import dataclass

import httpx
from fastapi import HTTPException

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
SPB_VIEWBOX = "29.4,59.7,30.8,60.2"  # left,bottom,right,top


@dataclass
class GeocodeResult:
    display_name: str
    lat: float
    lng: float
    boundingbox: list[str] | None
    geojson: dict | None


async def search_streets(query: str, limit: int = 8) -> list[GeocodeResult]:
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

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(NOMINATIM_URL, params=params, headers=headers)
        if response.status_code != 200:
            raise HTTPException(status_code=502, detail="Сервис геокодинга недоступен")

    results: list[GeocodeResult] = []
    for item in response.json():
        geojson = item.get("geojson")
        if geojson and geojson.get("type") not in {"Polygon", "MultiPolygon"}:
            geojson = _bbox_to_polygon(item.get("boundingbox"))
        elif not geojson:
            geojson = _bbox_to_polygon(item.get("boundingbox"))

        results.append(
            GeocodeResult(
                display_name=item.get("display_name", query),
                lat=float(item["lat"]),
                lng=float(item["lon"]),
                boundingbox=item.get("boundingbox"),
                geojson=geojson,
            )
        )
    return results


def _bbox_to_polygon(bbox: list[str] | None) -> dict | None:
    if not bbox or len(bbox) != 4:
        return None
    south, north, west, east = map(float, bbox)
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }
