"""
Standalone Lightweight HTTP Server for testing Role C's endpoints.
Uses Python built-in http.server (ZERO third-party packages required).

Usage:
    python3 services/mock_api_server.py
Then open in browser or fetch from frontend:
    http://localhost:8000/api/community?postcode=EH144AS
"""

import json
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from services.environment_service import EnvironmentService

service = EnvironmentService(timeout_seconds=3)


class CommunityDataHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        """Enable CORS for frontend A development."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        
        # Route: /api/community?postcode=EH144AS
        if parsed_url.path == "/api/community":
            params = urllib.parse.parse_qs(parsed_url.query)
            postcode = params.get("postcode", ["EH144AS"])[0]
            
            result = service.get_community_snapshot(postcode)
            
            self.send_response(200 if result.get("success") else 400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8"))
            return

        # Health check
        if parsed_url.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"Borrow Next Door - Environment API is running! Access /api/community?postcode=EH144AS")
            return

        self.send_response(404)
        self.end_headers()


def run_server(port=8000):
    server_address = ("", port)
    httpd = HTTPServer(server_address, CommunityDataHandler)
    print(f"🚀 Environment API Server running at http://localhost:{port}/")
    print(f"👉 Try: http://localhost:{port}/api/community?postcode=EH144AS")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
        httpd.server_close()


if __name__ == "__main__":
    port = 8000
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    run_server(port)
