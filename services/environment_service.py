"""
Environment & Postcode Data Service for Borrow Next Door.
Responsible for:
1. Postcode lookup & coordinate resolution (Postcodes.io)
2. Local air quality telemetry (Open-Meteo Air Quality API)
3. Regional grid carbon intensity (NESO Carbon Intensity API)
4. Nearby parks and green spaces (OpenStreetMap Overpass API)
5. Reliable graceful degradation and demo fallback cache.

Written with standard library (urllib, json) to ensure zero dependency friction.
"""

import json
import math
import urllib.request
import urllib   .parse
from datetime import datetime, timezone
from services.demo_cache import DEMO_CACHE


class EnvironmentService:
    def __init__(self, timeout_seconds: int = 4):
        self.timeout = timeout_seconds

    @staticmethod
    def normalize_postcode(postcode: str) -> str:
        """Strip whitespace and capitalize UK postcode."""
        if not postcode:
            return ""
        return postcode.strip().replace(" ", "").upper()

    @staticmethod
    def format_uk_postcode(normalized: str) -> str:
        """Convert normalized 'EH144AS' to standard UK display 'EH14 4AS'."""
        if len(normalized) > 3:
            return f"{normalized[:-3]} {normalized[-3:]}"
        return normalized

    def _fetch_json(self, url: str) -> dict:
        """Internal helper to fetch JSON via urllib with timeout and custom User-Agent."""
        headers = {
            "User-Agent": "BorrowNextDoor-AdaHack/1.0 (greener-postcode-community)"
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)

    def lookup_postcode(self, postcode: str) -> dict:
        """
        Query Postcodes.io to get lat/lon, district, parish, and outcode.
        Returns a structured dictionary or None if invalid.
        """
        norm = self.normalize_postcode(postcode)
        if not norm:
            return {"valid": False, "error": "Empty postcode provided"}

        url = f"https://api.postcodes.io/postcodes/{urllib.parse.quote(norm)}"
        try:
            data = self._fetch_json(url)
            if data.get("status") == 200 and "result" in data:
                res = data["result"]
                return {
                    "valid": True,
                    "postcode": self.format_uk_postcode(norm),
                    "normalized": norm,
                    "outcode": res.get("outcode", ""),
                    "district": res.get("admin_district") or res.get("parish") or "Local Area",
                    "parish": res.get("parish") or "",
                    "latitude": res.get("latitude"),
                    "longitude": res.get("longitude"),
                    "source": "Postcodes.io",
                    "status": "live"
                }
        except Exception as e:
            # Check if this is a known demo postcode to rescue
            if norm in DEMO_CACHE:
                cached = DEMO_CACHE[norm]["location"]
                return {
                    "valid": True,
                    "postcode": self.format_uk_postcode(norm),
                    "normalized": norm,
                    "outcode": cached["outcode"],
                    "district": cached["district"],
                    "parish": cached.get("parish", ""),
                    "latitude": cached["latitude"],
                    "longitude": cached["longitude"],
                    "source": "Postcodes.io (Fallback Demo Cache)",
                    "status": "cached"
                }
            return {"valid": False, "error": f"Postcode lookup failed: {str(e)}"}

    def get_air_quality(self, lat: float, lon: float) -> dict:
        """
        Query Open-Meteo Air Quality API for European AQI, PM2.5, PM10.
        """
        url = (
            f"https://air-quality-api.open-meteo.com/v1/air-quality"
            f"?latitude={lat}&longitude={lon}&current=european_aqi,pm10,pm2_5"
        )
        try:
            data = self._fetch_json(url)
            current = data.get("current", {})
            aqi = current.get("european_aqi")
            pm2_5 = current.get("pm2_5")
            pm10 = current.get("pm10")

            # Determine human-friendly status label
            status_label = "Good"
            if aqi is not None:
                if aqi <= 20:
                    status_label = "Good"
                elif aqi <= 40:
                    status_label = "Fair"
                elif aqi <= 60:
                    status_label = "Moderate"
                elif aqi <= 80:
                    status_label = "Poor"
                else:
                    status_label = "Very Poor"

            return {
                "status": status_label,
                "aqi": aqi,
                "pm2_5": pm2_5,
                "pm10": pm10,
                "source": "Open-Meteo Air Quality (11km regional grid forecast)",
                "scope": "Regional forecast (~11km grid)",
                "timestamp": current.get("time") or datetime.now(timezone.utc).isoformat(),
                "is_cached": False,
                "available": True
            }
        except Exception:
            return {
                "status": "Moderate",
                "aqi": 25,
                "pm2_5": 5.0,
                "pm10": 10.0,
                "source": "Open-Meteo (Demo estimate)",
                "scope": "Fallback regional model",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "is_cached": True,
                "available": False
            }

    def get_carbon_intensity(self, outcode: str) -> dict:
        """
        Query NESO (National Grid ESO) Carbon Intensity API by regional outcode (e.g. EH14).
        """
        clean_outcode = outcode.strip().upper()
        url = f"https://api.carbonintensity.org.uk/regional/postcode/{clean_outcode}"
        try:
            data = self._fetch_json(url)
            region_data = data.get("data", [{}])[0]
            intensity_info = region_data.get("data", [{}])[0]
            intensity = intensity_info.get("intensity", {})
            gen_mix = intensity_info.get("generationmix", [])

            # Calculate clean energy percentage (wind, solar, hydro, nuclear, biomass)
            clean_fuels = {"wind", "solar", "hydro", "nuclear", "biomass"}
            clean_pct = sum(item["perc"] for item in gen_mix if item.get("fuel") in clean_fuels)
            
            top_fuel = max(gen_mix, key=lambda x: x["perc"]) if gen_mix else {"fuel": "Wind", "perc": 50}

            return {
                "index": intensity.get("index", "moderate"),
                "forecast": intensity.get("forecast"),
                "unit": "gCO2/kWh",
                "clean_energy_percentage": round(clean_pct, 1),
                "top_source": f"{top_fuel['fuel'].title()} ({top_fuel['perc']}%)",
                "source": "NESO Carbon Intensity API (National Grid ESO)",
                "scope": f"Regional grid zone ({clean_outcode})",
                "timestamp": intensity_info.get("to") or datetime.now(timezone.utc).isoformat(),
                "is_cached": False,
                "available": True
            }
        except Exception:
            return {
                "index": "low",
                "forecast": 42,
                "unit": "gCO2/kWh",
                "clean_energy_percentage": 72.0,
                "top_source": "Wind (60.0%)",
                "source": "NESO Regional API (Demo estimate)",
                "scope": f"Regional grid zone ({clean_outcode})",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "is_cached": True,
                "available": False
            }

    @staticmethod
    def _haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate approximate distance in kilometers between two coordinates."""
        r = 6371.0
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        delta_phi = math.radians(lat2 - lat1)
        delta_lambda = math.radians(lon2 - lon1)
        a = (
            math.sin(delta_phi / 2.0) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return round(r * c, 2)

    def get_nearby_green_spaces(self, lat: float, lon: float, postcode_norm: str = "") -> list:
        """
        Query OpenStreetMap Overpass for parks and green spaces within ~1.5km.
        Falls back seamlessly to curated demo spaces if network fails or times out.
        """
        # If we have a curated list for this demo postcode, prioritize reliability
        if postcode_norm in DEMO_CACHE:
            return DEMO_CACHE[postcode_norm]["green_spaces"]

        overpass_query = f"""
        [out:json][timeout:3];
        (
          node["leisure"="park"](around:1500,{lat},{lon});
          way["leisure"="park"](around:1500,{lat},{lon});
          node["leisure"="garden"](around:1500,{lat},{lon});
        );
        out center 6;
        """
        overpass_url = "https://overpass-api.de/api/interpreter?data=" + urllib.parse.quote(overpass_query)
        try:
            data = self._fetch_json(overpass_url)
            elements = data.get("elements", [])
            results = []
            for idx, el in enumerate(elements):
                tags = el.get("tags", {})
                name = tags.get("name")
                if not name:
                    continue
                el_lat = el.get("lat") or el.get("center", {}).get("lat")
                el_lon = el.get("lon") or el.get("center", {}).get("lon")
                dist = self._haversine_distance_km(lat, lon, el_lat, el_lon) if el_lat and el_lon else 0.5
                results.append({
                    "id": f"osm-{el.get('id', idx)}",
                    "name": name,
                    "type": tags.get("leisure", "Park").title(),
                    "distance_km": dist,
                    "latitude": el_lat,
                    "longitude": el_lon,
                    "source": "OpenStreetMap Overpass API"
                })
            if results:
                # Sort by distance
                results.sort(key=lambda x: x["distance_km"])
                return results[:5]
        except Exception:
            pass

        # Generic safe fallback parks if completely offline and postcode is unknown
        return [
            {
                "id": "local-comm-park",
                "name": "Community Green & Memorial Park",
                "type": "Public Park",
                "distance_km": 0.5,
                "latitude": lat + 0.002,
                "longitude": lon + 0.002,
                "source": "Local Survey (Demo Fallback)"
            },
            {
                "id": "local-allotments",
                "name": "Neighbourhood Allotments & Gardens",
                "type": "Community Allotment",
                "distance_km": 0.9,
                "latitude": lat - 0.003,
                "longitude": lon + 0.001,
                "source": "Local Survey (Demo Fallback)"
            }
        ]

    def get_community_snapshot(self, postcode: str) -> dict:
        """
        Main orchestration endpoint:
        Takes a postcode string, resolves location, air quality, carbon intensity, and green spaces.
        Guarantees response even if external APIs are completely offline.
        """
        norm = self.normalize_postcode(postcode)
        
        # 1. Check Demo Cache first for instant presentation-grade response
        if norm in DEMO_CACHE:
            cached_data = DEMO_CACHE[norm].copy()
            # Try live air & electricity if possible, else use cached
            loc = cached_data["location"]
            # Attempt fast live refresh, but keep cached if fails
            try:
                live_air = self.get_air_quality(loc["latitude"], loc["longitude"])
                if live_air.get("available"):
                    cached_data["air_quality"] = live_air
            except Exception:
                pass
            
            try:
                live_carbon = self.get_carbon_intensity(loc["outcode"])
                if live_carbon.get("available"):
                    cached_data["carbon_intensity"] = live_carbon
            except Exception:
                pass

            return {
                "success": True,
                "data": cached_data,
                "meta": {
                    "mode": "demo_supported",
                    "note": "Optimized for AdaHack 2026 presentation"
                }
            }

        # 2. Dynamic lookup for any arbitrary UK postcode
        pc_info = self.lookup_postcode(norm)
        if not pc_info.get("valid"):
            return {
                "success": False,
                "error": pc_info.get("error", "Invalid UK postcode"),
                "hint": "Try entering a valid UK postcode like 'EH14 4AS' or 'EH1 1YZ'."
            }

        lat = pc_info["latitude"]
        lon = pc_info["longitude"]
        outcode = pc_info["outcode"]

        # 3. Aggregate 3 other independent data feeds with fault isolation
        air_info = self.get_air_quality(lat, lon)
        carbon_info = self.get_carbon_intensity(outcode)
        green_spaces = self.get_nearby_green_spaces(lat, lon, norm)

        snapshot = {
            "postcode": pc_info["postcode"],
            "location": {
                "district": pc_info["district"],
                "parish": pc_info.get("parish", ""),
                "outcode": outcode,
                "latitude": lat,
                "longitude": lon,
                "description": f"{pc_info['district']} community"
            },
            "air_quality": air_info,
            "carbon_intensity": carbon_info,
            "green_spaces": green_spaces
        }

        return {
            "success": True,
            "data": snapshot,
            "meta": {
                "mode": "live_aggregated",
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
        }
