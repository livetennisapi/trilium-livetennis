from pathlib import Path
import json
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def note(note_id, title, filename, mime, labels, children=None):
    result = {
        "noteId": note_id, "title": title, "type": "code", "mime": mime,
        "attributes": [{"type": "label", "name": name, "value": value} for name, value in labels],
        "attachments": [], "children": children or [], "dataFileName": filename,
    }
    if children:
        result["dirFileName"] = "Live Tennis snapshots"
    return result


backend = note("liveTennisBackend", "LiveTennisBackend", "backend.js", "application/javascript;env=backend", [])
config = note("liveTennisConfig", "Live Tennis settings", "config.json", "application/json", [("liveTennisConfig", "v1")])
widget = note("liveTennisWidget", "Live Tennis snapshots", "widget.js", "application/javascript;env=frontend",
              [("widget", ""), ("liveTennisWidget", "v1")], [backend, config])
meta = {"formatVersion": 2, "appVersion": "0.106.0", "files": [widget]}
files = {
    "!!!meta.json": (json.dumps(meta, indent=2) + "\n").encode(),
    "widget.js": (ROOT / "src/widget.js").read_bytes(),
    "Live Tennis snapshots/backend.js": (ROOT / "src/backend.js").read_bytes(),
    "Live Tennis snapshots/config.json": (ROOT / "src/config.json").read_bytes(),
}
output = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist/trilium-livetennis.zip"
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, contents in files.items():
        entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o644 << 16
        archive.writestr(entry, contents)
print(f"Built {output.name}: {len(files)} entries, {output.stat().st_size} bytes")
