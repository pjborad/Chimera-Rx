#!/usr/bin/env python3
"""Kokoro voiceover pipeline.

Feed it a GitHub repo (or a local folder). It finds the narration script
(beats.json: [{"start": "0:12", "say": "..."}]) and the silent demo video,
speaks every beat with Kokoro-82M (Hugging Face: hexgrad/Kokoro-82M), fits
each beat to its time slot, and muxes the voice onto the video.

Natural delivery: each beat is spoken sentence by sentence with a tiny speed
jitter, edge silence is trimmed, sentences are joined with short 120-260 ms
gaps (never long pauses), and speed is chosen so the line fills its slot
instead of leaving dead air.

The narrator defaults to the male Kokoro voice am_michael (am_adam is the
other male US voice). Kokoro runs in-process (python package `kokoro`) or,
with --kokoro-url, through a local Kokoro-FastAPI server (the same server the
Chimera Rx API uses with VOICE_PROVIDER=kokoro). --segments writes one tight
WAV per beat, with no leading or trailing silence, for editing by hand.

Usage:
  python voiceover.py --repo https://github.com/<owner>/<repo>
  python voiceover.py --repo ./local-folder --voice am_adam --out out/
  python voiceover.py --repo . --kokoro-url http://127.0.0.1:8880 --segments
"""
from __future__ import annotations

import argparse, io, json, os, random, re, shutil, subprocess, sys, tempfile
import urllib.parse, urllib.request
from pathlib import Path

import numpy as np

SR = 24000
REPO_RE = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+?(\.git)?/?$")

# Spoken forms the model would otherwise mangle. Extend with --pronounce file.json.
PRONOUNCE = {
    "FHIR": "fire", "EPCIS": "E P C I S", "NDC": "N D C", "OCR": "O C R",
    "MCP": "M C P", "REST": "rest", "SMS": "S M S", "DSCSA": "D S C S A",
    "PDC": "P D C", "LLM": "L L M", "STOP": "stop", "GS1": "G S one",
    "Rx": "R x", "openFDA": "open F D A", "FDA": "F D A", "API": "A P I",
}


def _ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("missing ffmpeg: brew install ffmpeg, or pip install imageio-ffmpeg")


FFMPEG = _ffmpeg()


def sh(*cmd: str, capture=False) -> str:
    r = subprocess.run(cmd, check=True, text=True, capture_output=capture)
    return r.stdout if capture else ""


def need(tool: str, hint: str) -> None:
    if not shutil.which(tool):
        sys.exit(f"missing `{tool}`: {hint}")


def fetch_repo(repo: str, work: Path) -> Path:
    if Path(repo).is_dir():
        return Path(repo).resolve()
    if not REPO_RE.match(repo):
        sys.exit("--repo must be a https://github.com/<owner>/<repo> URL or a local folder")
    dest = work / "repo"
    sh("git", "clone", "--depth", "1", "--quiet", repo, str(dest))
    return dest


def find_script(root: Path, explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    hits = sorted(root.glob("**/beats.json"), key=lambda p: len(p.parts))
    hits = [h for h in hits if "node_modules" not in h.parts]
    if not hits:
        sys.exit("no beats.json found; pass --script")
    return hits[0]


def find_video(root: Path, script: Path, explicit: str | None) -> Path | None:
    if explicit:
        return Path(explicit)
    for base in (script.parent, script.parent.parent, root):
        vids = [v for v in sorted(base.glob("*.mp4")) if "voiced" not in v.name]
        if vids:
            return vids[0]
    return None


def secs(ts: str) -> float:
    parts = [float(p) for p in ts.split(":")]
    out = 0.0
    for p in parts:
        out = out * 60 + p
    return out


def duration(video: Path) -> float:
    r = subprocess.run([FFMPEG, "-i", str(video)], text=True, capture_output=True)
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", r.stderr)
    if not m:
        sys.exit(f"cannot read duration of {video}")
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def speakable(text: str, pron: dict[str, str]) -> str:
    for k, v in pron.items():
        text = re.sub(rf"\b{re.escape(k)}\b", v, text)
    text = text.replace("&", " and ").replace("·", ",")
    return re.sub(r"\s+", " ", text).strip()


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


def trim(a: np.ndarray, thr: float = 0.008, pad_ms: float = 20) -> np.ndarray:
    """Cut silence at both edges. pad_ms keeps a few ms so consonants are not clipped."""
    idx = np.where(np.abs(a) > thr)[0]
    if len(idx) == 0:
        return a[:0]
    pad = int(pad_ms / 1000 * SR)
    return a[max(idx[0] - pad, 0): idx[-1] + 1 + pad]


LOOPBACK = {"127.0.0.1", "localhost", "::1"}


class ServerPipe:
    """Kokoro through a local OpenAI-compatible server (Kokoro-FastAPI). Same call shape as KPipeline."""

    def __init__(self, url: str):
        u = urllib.parse.urlparse(url)
        if u.scheme != "http" or u.hostname not in LOOPBACK:
            sys.exit("--kokoro-url must be http://127.0.0.1:<port> (or localhost)")
        self.endpoint = url.rstrip("/").removesuffix("/v1") + "/v1/audio/speech"

    def __call__(self, text: str, voice: str, speed: float):
        import soundfile as sf
        body = json.dumps({"model": "kokoro", "voice": voice, "input": text, "speed": round(speed, 3), "response_format": "wav"}).encode()
        req = urllib.request.Request(self.endpoint, data=body, headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            audio, sr = sf.read(io.BytesIO(r.read()), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != SR:  # simple linear resample; Kokoro serves 24 kHz, so this rarely runs
            audio = np.interp(np.linspace(0, len(audio), int(len(audio) * SR / sr), endpoint=False), np.arange(len(audio)), audio).astype(np.float32)
        yield None, None, audio


def fade(a: np.ndarray, ms: int = 8) -> np.ndarray:
    n = min(int(SR * ms / 1000), len(a) // 2)
    if n:
        a = a.copy()
        a[:n] *= np.linspace(0, 1, n)
        a[-n:] *= np.linspace(1, 0, n)
    return a


def speak_beat(pipe, text: str, voice: str, speed: float, rng: random.Random) -> np.ndarray:
    chunks: list[np.ndarray] = []
    for s in sentences(text):
        j = speed * rng.uniform(0.97, 1.03)  # small per-sentence drift, sounds less robotic
        parts = [np.asarray(a, dtype=np.float32) for _, _, a in pipe(s, voice=voice, speed=j)]
        if not parts:
            continue
        chunks.append(fade(trim(np.concatenate(parts))))
    out: list[np.ndarray] = []
    for i, c in enumerate(chunks):
        out.append(c)
        if i < len(chunks) - 1:
            gap = rng.uniform(0.12, 0.26)  # short, human, never a long pause
            out.append(np.zeros(int(gap * SR), dtype=np.float32))
    joined = np.concatenate(out) if out else np.zeros(0, dtype=np.float32)
    return trim(joined, pad_ms=0)  # no leading or trailing silence on the beat itself


def fit(pipe, text, voice, slot, base, rng):
    """Pick a speed so the line fills ~93% of its slot, clamped to a natural range."""
    speed = base
    audio = speak_beat(pipe, text, voice, speed, random.Random(rng.random()))
    for _ in range(3):
        dur = len(audio) / SR
        if dur == 0:
            break
        target = slot * 0.97
        ratio = dur / target
        if 0.96 <= ratio <= 1.0:
            break
        speed = float(np.clip(speed * ratio, 0.88, 1.25))
        audio = speak_beat(pipe, text, voice, speed, random.Random(rng.random()))
    return audio, speed


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, help="GitHub URL or local folder")
    ap.add_argument("--script", help="path to beats.json (default: auto-find)")
    ap.add_argument("--video", help="silent video (default: auto-find an .mp4 next to the script)")
    ap.add_argument("--voice", default="am_michael", help="Kokoro voice: am_michael (default, male), am_adam (male), af_heart, bf_emma")
    ap.add_argument("--lang", default="a", help="a=US English, b=UK English")
    ap.add_argument("--speed", type=float, default=1.08, help="starting speed (1.0 is the model default)")
    ap.add_argument("--lead", type=float, default=0.2, help="seconds after a beat starts before speech begins")
    ap.add_argument("--pronounce", help="JSON file of extra {word: spoken form}")
    ap.add_argument("--kokoro-url", help="use a local Kokoro-FastAPI server instead of the python package, e.g. http://127.0.0.1:8880")
    ap.add_argument("--segments", action="store_true", help="write one WAV per beat (no edge silence) to <out>/segments and stop")
    ap.add_argument("--keep-audio", action="store_true", help="also keep voiceover.wav and report.json")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default="voiceover-out")
    args = ap.parse_args()

    need("git", "install git")
    import soundfile as sf
    if not args.kokoro_url:
        try:
            from kokoro import KPipeline
        except ImportError:
            sys.exit("missing kokoro: pip install -r requirements.txt  (also: brew install espeak-ng), or pass --kokoro-url")

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    pron = dict(PRONOUNCE)
    if args.pronounce:
        pron.update(json.loads(Path(args.pronounce).read_text()))

    with tempfile.TemporaryDirectory() as tmp:
        root = fetch_repo(args.repo, Path(tmp))
        script = find_script(root, args.script)
        video = find_video(root, script, args.video)
        beats = json.loads(script.read_text())
        total = duration(video) if video else secs(beats[-1]["start"]) + 20
        print(f"script: {script}\nvideo:  {video}\nbeats:  {len(beats)}  length: {total:.1f}s")

        pipe = ServerPipe(args.kokoro_url) if args.kokoro_url else KPipeline(lang_code=args.lang, repo_id="hexgrad/Kokoro-82M")
        rng = random.Random(args.seed)
        if args.segments:
            seg_dir = out / "segments"
            seg_dir.mkdir(parents=True, exist_ok=True)
            index = []
            for i, b in enumerate(beats):
                audio = speak_beat(pipe, speakable(b["say"], pron), args.voice, args.speed, random.Random(rng.random()))
                f = seg_dir / f"beat_{i + 1:02d}.wav"
                sf.write(f, audio, SR)
                index.append({"beat": i + 1, "start": b["start"], "file": f.name, "seconds": round(len(audio) / SR, 2)})
                print(f"beat {i + 1:>2} @ {b['start']:>5}  {len(audio) / SR:5.1f}s  {f.name}")
            (seg_dir / "segments.json").write_text(json.dumps(index, indent=1))
            print(f"segments: {seg_dir}")
            return
        track = np.zeros(int((total + 2) * SR), dtype=np.float32)
        report = []
        for i, b in enumerate(beats):
            start = secs(b["start"])
            end = secs(beats[i + 1]["start"]) if i + 1 < len(beats) else total
            slot = max(end - start - args.lead, 1.0)
            audio, speed = fit(pipe, speakable(b["say"], pron), args.voice, slot, args.speed, rng)
            at = int((start + args.lead) * SR)
            seg = audio[: max(len(track) - at, 0)]
            track[at: at + len(seg)] += seg
            d = len(audio) / SR
            flag = "OVER" if d > slot else "ok"
            report.append((i + 1, b["start"], round(d, 1), round(slot, 1), round(speed, 2), flag))
            print(f"beat {i + 1:>2} @ {b['start']:>5}  speech {d:5.1f}s / slot {slot:5.1f}s  speed {speed:.2f}  {flag}")

        raw = out / "voiceover.raw.wav"
        wav = out / "voiceover.wav"
        sf.write(raw, track, SR)
        sh(FFMPEG, "-y", "-loglevel", "error", "-i", str(raw),
           "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", str(wav))
        raw.unlink()
        (out / "report.json").write_text(json.dumps(
            [dict(zip(("beat", "start", "speech_s", "slot_s", "speed", "status"), r)) for r in report], indent=1))
        print(f"voice: {wav}")

        if video:
            final = out / f"{video.stem}.voiced.mp4"
            sh(FFMPEG, "-y", "-loglevel", "error", "-i", str(video), "-i", str(wav),
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
               "-shortest", str(final))
            print(f"video: {final}")
            if not args.keep_audio:
                wav.unlink()
                (out / "report.json").unlink()
        if any(r[-1] == "OVER" for r in report):
            print("warning: some beats are longer than their slot; shorten the text or widen the gap.")


if __name__ == "__main__":
    main()
