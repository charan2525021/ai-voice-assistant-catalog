from __future__ import annotations

from voice.buffering import build_final_transcript, merge_transcript
from voice.guards import strip_repetition


def main() -> int:
    failures = 0
    cases = [
        ("keeps real speech before a loop", "let us explore submissions. Hello. I feel it. I feel it. I feel it.", "let us explore submissions"),
        ("keeps an ordinary sentence", "Show me how invoicing works.", "Show me how invoicing works."),
        ("keeps a natural double repeat", "Yes. Yes. That is the one.", "Yes. Yes. That is the one."),
    ]
    for name, raw, expected in cases:
        result = strip_repetition(raw)
        if not result.startswith(expected):
            failures += 1
            print(f"FAIL {name}: {result!r}")
    buffer: list[str] = []
    merge_transcript(buffer, "show me")
    merge_transcript(buffer, "show me settings")
    if build_final_transcript(buffer) != "show me settings":
        failures += 1
    print(f"{len(cases) + 1 - failures} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
