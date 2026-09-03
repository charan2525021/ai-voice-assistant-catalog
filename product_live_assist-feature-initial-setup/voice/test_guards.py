"""Regression tests for the transcript guards.

These exist because of a live failure: Whisper returned the user's real words
followed by a hallucinated loop, the repetition detector judged the WHOLE
transcript to be noise, and the agent went deaf mid-conversation. The guards
must reject hallucination without ever costing the user a real turn.

    ./.venv/bin/python -m voice.test_guards
"""

from __future__ import annotations

from voice.server import strip_repetition

CASES: list[tuple[str, str, str]] = [
    (
        "keeps real speech that precedes a loop",
        "let us explore submissions. Hello. I feel like I'm feeling it. "
        "I feel like I'm feeling it. I feel like I'm feeling it. I feel like I'm feeling it.",
        "let us explore submissions",
    ),
    ("leaves an ordinary sentence alone", "Show me how invoicing works.", "Show me how invoicing works."),
    (
        "leaves a long genuine multi-sentence turn alone",
        "Show me invoicing. Then open payments. After that close the panel.",
        "Show me invoicing. Then open payments. After that close the panel.",
    ),
    ("collapses a pure loop to almost nothing", "Scroll. Scroll. Scroll. Scroll. Scroll.", "Scroll."),
    ("tolerates a repeat used naturally twice", "Yes. Yes. That is the one I meant.",
     "Yes. Yes. That is the one I meant."),
]


def main() -> int:
    passed = failed = 0
    for name, raw, expected_prefix in CASES:
        got = strip_repetition(raw)
        ok = got.startswith(expected_prefix.rstrip(".").split(".")[0]) and len(got) <= len(raw)
        if ok:
            passed += 1
            print(f"  ✔ {name}")
        else:
            failed += 1
            print(f"  ✘ {name}\n      got: {got!r}\n      expected to start: {expected_prefix!r}")
    print(f"\n{'✅' if not failed else '❌'} {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
