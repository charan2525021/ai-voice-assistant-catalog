from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class UtteranceState:
    transcript_buffer: list[str] = field(default_factory=list)
    waiting_for_silence: bool = False
    consecutive_low_energy_packets: int = 0
    utterance_started_at: float | None = None

    def reset(self) -> None:
        self.transcript_buffer.clear()
        self.waiting_for_silence = False
        self.consecutive_low_energy_packets = 0
        self.utterance_started_at = None


def merge_transcript(buffer: list[str], new_text: str) -> bool:
    text = new_text.strip()
    if not text:
        return False
    if not buffer:
        buffer.append(text)
        return True
    last = buffer[-1]
    if text == last:
        return False
    if text.startswith(last):
        buffer[-1] = text
        return True
    if last.startswith(text):
        return False
    buffer.append(text)
    return True


def build_final_transcript(buffer: list[str]) -> str:
    return " ".join(part.strip() for part in buffer if part.strip()).strip()
