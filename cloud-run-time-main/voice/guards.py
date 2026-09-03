from __future__ import annotations

import re


def strip_repetition(text: str) -> str:
    """Keep genuine speech before Sarvam's occasional repeating tail."""
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    if len(parts) < 3:
        return text
    seen: dict[str, int] = {}
    for index, part in enumerate(parts):
        key = re.sub(r"[^a-z0-9 ]", "", part.lower()).strip()
        if not key:
            continue
        seen[key] = seen.get(key, 0) + 1
        if seen[key] >= 3:
            return " ".join(parts[:index]).strip() or text
    return text
