import json
import sys
cfg = {s["name"]: s for s in json.load(open("config.json"))["services"]}
if set(cfg) != {"web", "api", "worker", "db"}:
    sys.exit(f"services changed: {sorted(cfg)}")
if "api" not in cfg["web"].get("depends_on", []) or not {"api", "db"} <= set(cfg["worker"].get("depends_on", [])):
    sys.exit("a valid dependency was removed")
if cfg["api"].get("depends_on") != ["db"]:
    sys.exit("api should depend on db (the database)")
