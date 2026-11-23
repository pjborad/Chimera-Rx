# Kokoro voiceover pipeline

Give it a GitHub repo or a local folder. It reads the narration script, speaks it with the open Kokoro-82M model, fits each line to its time slot and puts the voice on the silent demo video. Runs locally, no API key. The default narrator is the male voice `am_michael`.

This is demo-recording tooling. It is not part of the Chimera Rx app.

## Install (once)

macOS:

```bash
brew install espeak-ng ffmpeg
python3 -m venv .venv-voice && source .venv-voice/bin/activate
pip install -r scripts/voiceover/requirements.txt
```

Linux: `sudo apt install espeak-ng ffmpeg`, then the same two Python lines. The first run downloads the model from Hugging Face (`hexgrad/Kokoro-82M`, about 330 MB) and caches it. After that no network is needed.

`.venv-voice/` and `voiceover-out/` are meant to stay out of git (add them to `.gitignore`).

### Optional: a local Kokoro server

The same voices can come from a local OpenAI-compatible server such as Kokoro-FastAPI. The Chimera Rx API uses it for voicemail audio when it runs with `VOICE_PROVIDER=kokoro`:

```bash
docker run --rm -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
# then, for the app:
VOICE_PROVIDER=kokoro KOKORO_URL=http://127.0.0.1:8880 KOKORO_VOICE=am_michael pnpm dev
```

Both the app and this script refuse any host other than `127.0.0.1`, `localhost` or `::1`. The app only renders voicemail audio. Nothing is dialled.

## Run

```bash
python scripts/voiceover/voiceover.py --repo https://github.com/<owner>/<repo>
python scripts/voiceover/voiceover.py --repo . --voice am_adam --speed 1.1
python scripts/voiceover/voiceover.py --repo . --kokoro-url http://127.0.0.1:8880      # use the local server
python scripts/voiceover/voiceover.py --repo . --segments                              # one WAV per beat
```

The output goes in `voiceover-out/`:

- By default you get `<video>.voiced.mp4`, with the voice inside it. Add `--keep-audio` to also keep `voiceover.wav` and `report.json`, which compares speech length with slot length for each beat.
- `--segments` writes `segments/beat_01.wav` and so on, plus `segments/segments.json` with each segment's length. Each segment starts and ends on speech, with no leading or trailing silence, so you can place the clips back to back in an editor without pauses.

## What it expects in the repo

- `beats.json`: `[{"start": "0:12", "say": "..."}]`. It is found automatically, or you can pass `--script`.
- A silent `.mp4` beside it, or pass `--video`. Without a video you still get the wav (or the segments).

## Why it sounds human

- Each beat is spoken sentence by sentence, with a small random speed change on each sentence.
- Silence is trimmed at both edges of every sentence, and then again at both edges of the whole beat. Sentences are joined with gaps of 120 to 260 ms, so there are no long pauses.
- Speed is chosen per beat so the line fills about 97% of its slot (clamped to 0.88 to 1.25). That avoids dead air without rushing.
- Loudness is normalised to -16 LUFS.
- Acronyms get spoken forms (FHIR, EPCIS, NDC, OCR...). Add more with `--pronounce words.json`.

## Voices

- **Male (US):** `am_michael` (default) and `am_adam`. Other male voices include `am_fenrir`.
- **Female:** `af_heart`, `af_bella`, `af_nicole`, and `bf_emma` (use `--lang b` for UK voices).

`--seed` changes the timing jitter.

A beat marked `OVER` in the report has more words than its slot can hold at 1.25x. Shorten that line in `beats.json`.
