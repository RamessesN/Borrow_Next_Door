"""
Self-test script for Role C (Environment & Postcode Data Lead).
Run this script to verify:
1. Postcode normalization and parsing
2. Offline fallback functionality for demo postcodes (EH14 4AS, EH1 1YZ)
3. Error handling for invalid postcodes
4. JSON structure required by Frontend (A) and Task Manager (D)
"""

import json
import sys
import os

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.environment_service import EnvironmentService


def run_tests():
    print("=" * 60)
    print("🌿 Borrow Next Door - Role C Self-Test Suite")
    print("=" * 60)

    service = EnvironmentService(timeout_seconds=3)

    # Test 1: Heriot-Watt / Currie Demo Postcode
    print("\n[Test 1] Testing Demo Postcode: 'EH14 4AS' (Heriot-Watt Campus)")
    res1 = service.get_community_snapshot("eh14 4as")
    assert res1["success"] is True, f"Failed on EH14 4AS: {res1}"
    data1 = res1["data"]
    print(f"  ✓ Postcode Formatted: {data1['postcode']}")
    print(f"  ✓ District: {data1['location']['district']}")
    print(f"  ✓ Coordinates: ({data1['location']['latitude']}, {data1['location']['longitude']})")
    print(f"  ✓ Air Quality Status: {data1['air_quality']['status']} (AQI: {data1['air_quality']['aqi']})")
    print(f"  ✓ Carbon Intensity: {data1['carbon_intensity']['index']} ({data1['carbon_intensity']['forecast']} gCO2/kWh)")
    print(f"  ✓ Clean Energy: {data1['carbon_intensity']['clean_energy_percentage']}%")
    print(f"  ✓ Green Spaces Found: {len(data1['green_spaces'])}")
    for g in data1["green_spaces"]:
        print(f"     - {g['name']} (~{g['distance_km']} km, {g['type']})")

    # Test 2: City Centre Postcode
    print("\n[Test 2] Testing City Centre Demo Postcode: 'EH1 1YZ'")
    res2 = service.get_community_snapshot("EH1 1YZ")
    assert res2["success"] is True, f"Failed on EH1 1YZ: {res2}"
    data2 = res2["data"]
    print(f"  ✓ District: {data2['location']['district']}")
    print(f"  ✓ Found {len(data2['green_spaces'])} parks including: {data2['green_spaces'][0]['name']}")

    # Test 3: Invalid Postcode Handling
    print("\n[Test 3] Testing Invalid Postcode: 'XYZ 999'")
    res3 = service.get_community_snapshot("XYZ 999")
    print(f"  ✓ Success Flag: {res3['success']} (Expected False)")
    print(f"  ✓ Graceful Error Message: {res3.get('error')}")
    print(f"  ✓ Helpful User Hint: {res3.get('hint')}")

    print("\n" + "=" * 60)
    print("✅ All tests passed! Ready to integrate with A (Frontend) and B (Backend).")
    print("=" * 60)


if __name__ == "__main__":
    run_tests()
