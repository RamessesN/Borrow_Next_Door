"""
Demo cache for Borrow Next Door.
Provides instant fallback data for hackathon demo postcodes if external APIs fail or are offline.
Covers:
1. EH14 4AS (Heriot-Watt University / Currie area)
2. EH1 1YZ (Edinburgh City Centre / Princes St area)
3. EH8 9YL (University of Edinburgh / George Square)
"""

DEMO_CACHE = {
    "EH144AS": {
        "postcode": "EH14 4AS",
        "location": {
            "district": "City of Edinburgh",
            "parish": "Currie Community",
            "outcode": "EH14",
            "latitude": 55.9092,
            "longitude": -3.3193,
            "description": "Heriot-Watt / Riccarton Community"
        },
        "air_quality": {
            "status": "Good",
            "aqi": 19,
            "pm2_5": 4.1,
            "pm10": 7.8,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True
        },
        "carbon_intensity": {
            "index": "very low",
            "forecast": 38,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 76.5,
            "top_source": "Wind (62.3%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True
        },
        "green_spaces": [
            {
                "id": "hw-riccarton-grounds",
                "name": "Riccarton Estate & Campus Loch",
                "type": "Nature Reserve & Grounds",
                "distance_km": 0.2,
                "latitude": 55.9100,
                "longitude": -3.3210
            },
            {
                "id": "currie-comm-park",
                "name": "Currie Community Park",
                "type": "Public Park",
                "distance_km": 1.1,
                "latitude": 55.8985,
                "longitude": -3.3150
            },
            {
                "id": "water-of-leith-currie",
                "name": "Water of Leith Walkway (Currie Section)",
                "type": "River Walkway & Green Corridor",
                "distance_km": 1.4,
                "latitude": 55.8970,
                "longitude": -3.3080
            },
            {
                "id": "baberton-mains-park",
                "name": "Baberton Mains Park",
                "type": "Local Grassland & Recreation",
                "distance_km": 1.8,
                "latitude": 55.9080,
                "longitude": -3.2920
            }
        ]
    },
    "EH11YZ": {
        "postcode": "EH1 1YZ",
        "location": {
            "district": "City of Edinburgh",
            "parish": "City Centre",
            "outcode": "EH1",
            "latitude": 55.9525,
            "longitude": -3.1895,
            "description": "Edinburgh Old Town / Waverley Community"
        },
        "air_quality": {
            "status": "Fair",
            "aqi": 28,
            "pm2_5": 7.3,
            "pm10": 13.5,
            "source": "Open-Meteo Air Quality (11km regional grid forecast)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True
        },
        "carbon_intensity": {
            "index": "low",
            "forecast": 42,
            "unit": "gCO2/kWh",
            "clean_energy_percentage": 71.0,
            "top_source": "Wind (55.0%)",
            "source": "NESO Carbon Intensity API (National Grid ESO)",
            "timestamp": "2026-10-03T10:00:00Z",
            "is_cached": True
        },
        "green_spaces": [
            {
                "id": "princes-st-gardens",
                "name": "Princes Street Gardens",
                "type": "Public Urban Park",
                "distance_km": 0.4,
                "latitude": 55.9508,
                "longitude": -3.1970
            },
            {
                "id": "calton-hill",
                "name": "Calton Hill Park",
                "type": "Historic Green Hill",
                "distance_km": 0.6,
                "latitude": 55.9554,
                "longitude": -3.1829
            },
            {
                "id": "holyrood-park",
                "name": "Holyrood Park",
                "type": "Royal Natural Park",
                "distance_km": 1.2,
                "latitude": 55.9510,
                "longitude": -3.1670
            },
            {
                "id": "the-meadows",
                "name": "The Meadows",
                "type": "Community Green Space",
                "distance_km": 1.3,
                "latitude": 55.9412,
                "longitude": -3.1925
            }
        ]
    }
}
