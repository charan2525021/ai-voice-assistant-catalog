"""Local TTS — Kokoro over plain HTTP.

Replaces the paid Sarvam/OpenAI synthesis for the same job at roughly an eighth
of the latency. Measured on an M1 Pro, warm, CPU only:

    Kokoro   ~520 ms for a 3.1 s line   (5.9x realtime)
    Sarvam  ~4000 ms for the same job

That difference is the whole reason a spoken answer can start in about a second
instead of five. Kokoro is 82M parameters and needs no GPU, which is what makes
it deployable next to the app rather than behind someone's API key.

Deliberately a separate PROCESS, not an in-process binding:
  * the model loads once (~2.4 s) and stays warm across app restarts;
  * Node keeps its event loop free of a CPU-bound synthesis;
  * it scales and deploys as its own container.

Contract (kept identical in shape to the hosted providers so the Node side has
one code path):
    POST /speak  {"text": "...", "voice": "af_heart", "speed": 1.0}
      -> 200 audio/wav
    GET  /health -> {"ok": true, "model": "kokoro", "warm": true}
"""

from __future__ import annotations

import io
import json
import logging
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

LOG = logging.getLogger("tts")
PORT = int(os.environ.get("TTS_PORT", "8091"))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
LANG = os.environ.get("KOKORO_LANG", "a")  # 'a' = American English
SAMPLE_RATE = 24000

_pipeline = None
_lock = threading.Lock()  # Kokoro is not thread-safe; serialise synthesis


def get_pipeline():
    """Load once, keep warm. The first call pays ~2.4s; every later call does not."""
    global _pipeline
    if _pipeline is None:
        with _lock:
            if _pipeline is None:
                from kokoro import KPipeline

                started = time.time()
                _pipeline = KPipeline(lang_code=LANG)
                LOG.info("kokoro loaded in %.2fs", time.time() - started)
    return _pipeline


def to_wav(samples: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    """PCM16 WAV — what the browser and the Node cache both already expect."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def synthesize(text: str, voice: str, speed: float) -> bytes:
    pipe = get_pipeline()
    with _lock:
        chunks = [audio for _, _, audio in pipe(text, voice=voice, speed=speed)]
    if not chunks:
        raise ValueError("kokoro produced no audio")
    return to_wav(np.concatenate(chunks))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet; we log what matters ourselves
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json(200, {"ok": True, "model": "kokoro", "warm": _pipeline is not None})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/speak"):
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("content-length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                return self._json(400, {"error": "text is required"})
            started = time.time()
            wav = synthesize(text, req.get("voice") or DEFAULT_VOICE, float(req.get("speed") or 1.0))
            ms = int((time.time() - started) * 1000)
            LOG.info("spoke %d chars in %dms", len(text), ms)
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(wav)))
            self.send_header("x-synth-ms", str(ms))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as exc:  # never take the server down for one bad line
            LOG.exception("synthesis failed")
            self._json(500, {"error": f"{type(exc).__name__}: {exc}"})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    # Warm the model before accepting traffic, so the first caller is not the one
    # who pays the load — that first request is usually a demo greeting.
    get_pipeline()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    LOG.info("Aidan TTS (kokoro) on http://127.0.0.1:%d  voice=%s", PORT, DEFAULT_VOICE)
    server.serve_forever()


if __name__ == "__main__":
    main()
