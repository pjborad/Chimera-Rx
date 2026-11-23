#!/usr/bin/env python3
"""Tiny local OpenAI-compatible speech server backed by the in-process Kokoro-82M model.

Same route the Chimera Rx API uses with VOICE_PROVIDER=kokoro: POST /v1/audio/speech
{model, voice, input, speed, response_format: mp3|wav}. Use it when Docker and Kokoro-FastAPI
are not available. Loopback only (127.0.0.1). Demo tooling, not part of the app.

  .venv-voice/bin/python scripts/voiceover/kokoro_server.py --port 4662
  VOICE_PROVIDER=kokoro KOKORO_URL=http://127.0.0.1:4662 KOKORO_VOICE=am_michael pnpm dev
"""
from __future__ import annotations

import argparse, io, json, shutil, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf

SR = 24000


def ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4662)
    ap.add_argument("--lang", default="a")
    args = ap.parse_args()
    from kokoro import KPipeline
    pipe = KPipeline(lang_code=args.lang, repo_id="hexgrad/Kokoro-82M")
    ff = ffmpeg()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def do_GET(self):
            self.send_response(200 if self.path.startswith("/health") else 404)
            self.end_headers()

        def do_POST(self):
            if not self.path.endswith("/v1/audio/speech"):
                self.send_response(404); self.end_headers(); return
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            text, voice = str(body.get("input", "")), str(body.get("voice", "am_michael"))
            speed, fmt = float(body.get("speed", 1) or 1), str(body.get("response_format", "mp3"))
            parts = [np.asarray(a, dtype=np.float32) for _, _, a in pipe(text, voice=voice, speed=speed)]
            audio = np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)
            buf = io.BytesIO()
            sf.write(buf, audio, SR, format="WAV")
            data, mime = buf.getvalue(), "audio/wav"
            if fmt == "mp3":
                data = subprocess.run([ff, "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "-b:a", "96k", "pipe:1"], input=data, capture_output=True, check=True).stdout
                mime = "audio/mpeg"
            self.send_response(200)
            self.send_header("content-type", mime)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()


if __name__ == "__main__":
    main()
