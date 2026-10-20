"""Local preview server: serves the site and accepts RSVP submissions.

    python rsvp/dev_server.py        ->  http://localhost:8000

Submissions are saved to rsvp/.local/responses.json and rsvp/.local/responses.xlsx
(git-ignored, so test answers never get published).
"""
import json
import os
import sys
import unicodedata
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xlsx import COLUMNS, write_xlsx  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "rsvp", ".local")
JSON_PATH = os.path.join(DATA_DIR, "responses.json")
XLSX_PATH = os.path.join(DATA_DIR, "responses.xlsx")
FIELDS = {key for key, _, _ in COLUMNS} - {"submittedAt", "firstSubmittedAt", "source"}


def name_key(name):
    return " ".join(unicodedata.normalize("NFKC", name).split()).lower()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path != "/api/rsvp":
            self.send_error(404)
            return
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_error(400, "Invalid JSON")
            return
        row = {k: str(data.get(k, ""))[:2000] for k in FIELDS}
        if not row["name"]:
            self.send_error(400, "Name is required")
            return
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        row["submittedAt"] = now

        os.makedirs(DATA_DIR, exist_ok=True)
        rows = []
        if os.path.exists(JSON_PATH):
            with open(JSON_PATH, encoding="utf-8") as f:
                rows = json.load(f)
        # same name (case/spacing ignored) replaces the earlier answers, like the Worker
        match = [i for i, r in enumerate(rows) if name_key(r["name"]) == name_key(row["name"])]
        updated = bool(match)
        if updated:
            row["firstSubmittedAt"] = rows[match[0]].get("firstSubmittedAt") or rows[match[0]]["submittedAt"]
            rows[match[0]] = row
        else:
            row["firstSubmittedAt"] = now
            rows.append(row)
        with open(JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        write_xlsx(rows, XLSX_PATH)
        print(f"  saved RSVP from {row['name']!r} ({len(rows)} total) -> {XLSX_PATH}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "updated": updated}).encode())


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp1252
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving http://localhost:{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
