"""Rebuild responses.xlsx and responses.csv from responses.json (run by the GitHub Action)."""
import csv
import json

from xlsx import COLUMNS, write_xlsx

with open("responses.json", encoding="utf-8") as f:
    rows = json.load(f)

write_xlsx(rows, "responses.xlsx")
# utf-8-sig so Excel opens the Chinese text correctly
with open("responses.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.writer(f)
    w.writerow([header for _, header, _ in COLUMNS])
    for row in rows:
        w.writerow([row.get(key, "") for key, _, _ in COLUMNS])
print(f"Built spreadsheet with {len(rows)} responses")
