import re
import unicodedata


def slugify(text, max_len=60):
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    if len(s) > max_len:
        cut = s[:max_len + 1]
        i = cut.rfind("-")
        s = cut[:i] if 0 < i <= max_len else s[:max_len]
        s = s.rstrip("-")
    return s or "n-a"
