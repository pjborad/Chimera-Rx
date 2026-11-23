#!/usr/bin/env python3
"""Narration -> one continuous Kokoro voice track with exact unit timings.

Reads docs/DEMO_VIDEO_SCRIPT.md. Every line that starts with '>' is one unit. Each unit is spoken sentence by sentence
(Kokoro-82M, male voice am_michael or am_adam), edge silence is trimmed, sentences are joined with 70 ms, units with
60 ms, so the track has no pauses. Loudness is normalised to -16 LUFS. The recorder reads timeline.json and makes the
screen follow this audio.

  .venv-voice/bin/python scripts/demo/make-voice.py full            -> demo-video/work/full/{voice.wav,timeline.json,narration.srt}
  .venv-voice/bin/python scripts/demo/make-voice.py cut
Options: --voice am_michael|am_adam  --speed 1.1  --compare (renders a short sample with both voices)
"""
from __future__ import annotations

import argparse, hashlib, json, re, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/voiceover"))
import voiceover as vo  # noqa: E402

SR = vo.SR
SENT_GAP, UNIT_GAP = 0.07, 0.06
PRON = dict(vo.PRONOUNCE)
PRON.update({
    "Kiro": "Keero", "GS1": "G S one", "DataMatrix": "data matrix", "PJ": "P J", "Kokoro": "Kokoro", "EARS": "ears", "OAuth": "oh auth", "DataMatrix": "data matrix", "TI/TS": "T I T S",
    "AI-DLC": "A I D L C", "MFA": "M F A", "EHR": "E H R", "PDF": "P D F", "SKU": "sku", "IDs": "I Ds", "ID": "I D",
    "HIPAA-style": "hip-uh style", "Coroner": "Coroner", "DSCSA": "D S C S A", "GS1": "G S one", "F01": "F zero one", "F08": "F zero eight",
    "NDC": "N D C", "NDCs": "N D Cs", "MCP": "M C P", "REST": "rest", "FHIR": "fire", "EPCIS": "E P C I S", "OCR": "O C R",
    "RX": "R x", "API": "A P I", "SSO": "S S O", "PHI": "P H I", "KMS": "K M S", "Rx": "R x", "UI": "U I", "JSON": "jason",
})


def parse(script: Path, mode: str):
    """Segments: [{id, title, units:[text]}] for the full video or for the cut."""
    segs, cur, in_cut = [], None, False
    for line in script.read_text().splitlines():
        if line.startswith("# The 3-minute cut"):
            in_cut = True
            continue
        if line.startswith("# Judging"):
            in_cut = None
        h = re.match(r"^## (?:Cut )?(?:\d+)\. (.+?)\s*<!--\s*(?:id|cut):\s*([\w-]+)\s*-->", line)
        if h:
            cur = {"id": h.group(2), "title": h.group(1), "units": []} if ((mode == "cut") == bool(in_cut)) else None
            if cur:
                segs.append(cur)
            continue
        if cur is not None and line.startswith("> "):
            cur["units"].append(line[2:].strip())
    return segs


def speakable(text: str) -> str:
    t = text
    for k in sorted(PRON, key=len, reverse=True):
        t = re.sub(rf"(?<![\w-]){re.escape(k)}(?![\w-])", PRON[k], t)
    t = t.replace("&", " and ").replace("·", ",").replace(" - ", ", ")
    return re.sub(r"\s+", " ", t).strip()


def count_words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9'’-]+", text))


def cap_gaps(a: np.ndarray, thr=0.012, max_s=0.26) -> np.ndarray:
    """Shorten any quiet run longer than max_s to max_s (keeps the voice free of audible pauses)."""
    w = int(0.01 * SR)
    n = len(a) // w
    quiet = np.sqrt((a[: n * w].reshape(n, w) ** 2).mean(axis=1)) < thr
    out, i, keep = [], 0, int(max_s / 0.01)
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            out.append(a[i * w:(i + min(j - i, keep)) * w])
            i = j
        else:
            out.append(a[i * w:(i + 1) * w])
            i += 1
    out.append(a[n * w:])
    return np.concatenate(out)


def say_unit(pipe, text, voice, speed, cache: Path, rng) -> np.ndarray:
    key = hashlib.sha1(f"v2|{voice}|{speed}|{text}".encode()).hexdigest()[:16]
    f = cache / f"{key}.npy"
    if f.exists():
        return np.load(f)
    chunks = []
    for s in vo.sentences(speakable(text)):
        j = speed * rng.uniform(0.98, 1.02)
        parts = [np.asarray(a, dtype=np.float32) for _, _, a in pipe(s, voice=voice, speed=j)]
        if parts:
            chunks.append(vo.fade(vo.trim(np.concatenate(parts), pad_ms=12)))
    out = []
    for i, c in enumerate(chunks):
        out.append(c)
        if i < len(chunks) - 1:
            out.append(np.zeros(int(SENT_GAP * SR), dtype=np.float32))
    a = cap_gaps(vo.trim(np.concatenate(out), pad_ms=0))
    np.save(f, a)
    return a


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["full", "cut"], nargs="?", default="full")
    ap.add_argument("--voice", default="am_onyx")
    ap.add_argument("--speed", type=float, default=1.1)
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--script", default=str(ROOT / "docs/DEMO_VIDEO_SCRIPT.md"))
    a = ap.parse_args()
    import random
    import soundfile as sf
    from kokoro import KPipeline
    pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
    work = ROOT / "demo-video/work"
    cache = work / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    if a.compare:
        text = "Receiving starts at the dock. The camera reads the lot, serial and expiry. Four checks run: the invoice, the transaction information and statement, the expiry, and the recall list."
        for v in ("am_michael", "am_adam"):
            audio = say_unit(pipe, text, v, a.speed, cache, random.Random(3))
            sf.write(work / f"compare-{v}.wav", audio, SR)
            w = count_words(text)
            print(v, f"{len(audio) / SR:.2f}s", f"{w / (len(audio) / SR) * 60:.0f} wpm")
        return

    segs = parse(Path(a.script), a.mode)
    out_dir = work / a.mode
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)
    track, t, timeline, words = [], 0.0, [], 0
    for seg in segs:
        seg_start = t
        units = []
        for i, text in enumerate(seg["units"]):
            text, _, caption = text.partition(" ||| ")
            audio = say_unit(pipe, text, a.voice, a.speed, cache, rng)
            d = len(audio) / SR
            units.append({"i": i, "text": text, "caption": caption or text, "start": round(t, 3), "end": round(t + d, 3)})
            words += count_words(text)
            track.append(audio)
            t += d
            track.append(np.zeros(int(UNIT_GAP * SR), dtype=np.float32))
            t += UNIT_GAP
        timeline.append({"id": seg["id"], "title": seg["title"], "start": round(seg_start, 3), "end": round(t - UNIT_GAP, 3), "units": units})
        print(f"{seg['id']:<12} {t - seg_start:6.1f}s  {len(seg['units'])} units")
    audio = np.concatenate(track)
    raw = out_dir / "voice.raw.wav"
    sf.write(raw, audio, SR)
    vo.sh(vo.FFMPEG, "-y", "-loglevel", "error", "-i", str(raw), "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "1", str(out_dir / "voice.wav"))
    raw.unlink()
    total = len(audio) / SR
    (out_dir / "timeline.json").write_text(json.dumps({"voice": a.voice, "speed": a.speed, "seconds": round(total, 2), "words": words, "wpm": round(words / total * 60, 1), "segments": timeline}, indent=1))
    n = 1
    with open(out_dir / "narration.srt", "w") as f:
        for seg in timeline:
            for u in seg["units"]:
                # captions of at most ~12 words per cue, split at sentence ends
                parts = vo.sentences(u["caption"])
                span, tot = u["end"] - u["start"], sum(count_words(p) for p in parts) or 1
                c = u["start"]
                for p in parts:
                    d = span * count_words(p) / tot
                    f.write(f"{n}\n{srt_time(c)} --> {srt_time(c + d)}\n{p}\n\n")
                    n += 1
                    c += d
    print(f"voice {a.voice} speed {a.speed}: {total:.1f}s ({int(total // 60)}:{int(total % 60):02d}), {words} words, {words / total * 60:.0f} wpm")


if __name__ == "__main__":
    main()
