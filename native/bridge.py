#!/usr/bin/env python3
"""Local-only Photon/Parakeet Redux bridge. No web/cloud transcription."""
import argparse
import json
import os
from pathlib import Path
import secrets
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MODEL = "moondream/parakeet-redux"
MAX_AUDIO = 12 * 1024 * 1024
infer_lock = threading.Lock()


def make_handler(engine, token, origins):
    class Handler(BaseHTTPRequestHandler):
        def send_json(self, status, obj):
            payload = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            origin = self.headers.get("Origin")
            if origin and origin not in origins:
                self.send_json(403, {"error": "Disallowed browser origin"})
                return False
            if not secrets.compare_digest(self.headers.get("X-Nexus-Token", ""), token):
                self.send_json(401, {"error": "Incorrect local bridge token"})
                return False
            return True

        def do_OPTIONS(self):
            origin = self.headers.get("Origin")
            if origin not in origins:
                self.send_json(403, {"error": "Disallowed browser origin"})
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Nexus-Token")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != "/health":
                return self.send_json(404, {"error": "Not found"})
            self.send_json(200, {"ok": True, "model": MODEL, "backend": "photon", "ready": True})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/transcribe":
                return self.send_json(404, {"error": "Not found"})
            if self.headers.get("Content-Type", "").split(";")[0] != "audio/wav":
                return self.send_json(415, {"error": "Expected audio/wav"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return self.send_json(400, {"error": "Invalid content length"})
            if not 44 <= size <= MAX_AUDIO:
                return self.send_json(413, {"error": "WAV too large or empty"})
            raw = self.rfile.read(size)
            if len(raw) != size or not raw.startswith(b"RIFF") or raw[8:12] != b"WAVE":
                return self.send_json(400, {"error": "Invalid WAV"})
            name = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                    name = f.name
                    f.write(raw)
                with infer_lock:
                    result = engine.transcribe(audio=name)
                output = result.get("text")
                if not isinstance(output, str):
                    raise ValueError("Photon did not return text")
                return self.send_json(200, {"text": output, "model": MODEL})
            except Exception as exc:
                return self.send_json(500, {"error": str(exc)})
            finally:
                if name:
                    Path(name).unlink(missing_ok=True)
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=47832)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port out of range")
    origins = set(args.allow_origin) or {"http://127.0.0.1:4173", "http://localhost:4173"}
    if any(not o.startswith(("http://127.0.0.1:", "http://localhost:")) for o in origins):
        parser.error("only local browser origins permitted")
    import moondream as md
    secret = os.getenv("NEXUS_DICTATION_TOKEN") or secrets.token_urlsafe(24)
    print("Loading Photon model", MODEL, flush=True)
    with md.photon(MODEL, device=args.device) as engine:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(engine, secret, origins))
        print(f"Listening on http://127.0.0.1:{args.port}", flush=True)
        print(f"Session token: {secret}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
