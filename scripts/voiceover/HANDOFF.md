# Handoff: making a voiced demo video

Goal: one mp4 with the screen recording and a natural Kokoro voice inside it. No separate audio file.

## The three stages

| # | Stage | Tool | Output |
|---|---|---|---|
| 1 | Record the app silently | `pnpm demo:record:cut` (about 4 min) or `pnpm demo:record:full` (about 13 min) | `demo-video/chimera-rx-cut-3min.mp4` and a `.json` sidecar with section times |
| 2 | Turn the narration into timed beats | `scripts/voiceover/make_beats.py` | `demo-video/cut3-beats.json` |
| 3 | Speak the beats and put the voice on the video | `scripts/voiceover/voiceover.py` (Kokoro-82M) | `demo-video/voiced/<video>.voiced.mp4` |

Stage 1 already ran; the recording is in `demo-video/`. Stages 2 and 3 are this pipeline.

## Where things are

| Thing | Path |
|---|---|
| Voice pipeline | `scripts/voiceover/` (`voiceover.py`, `make_beats.py`, `requirements.txt`, `README.md`) |
| Python environment | `.venv-voice/` (Python 3.10; Kokoro does not support 3.14) |
| Recorder scripts, narration docs | **Branch `chore/remove-legacy` only**: `scripts/demo/`, `docs/DEMO_CUT3.md`, `docs/DEMO_FULL.md`. They are not on `fix/review-2026-11-22`. |
| Finished demo | `demo-video/chimera-rx-demo-final.mp4` (3:02.8, 1440x900) |

`demo-video/` and `.venv-voice/` are gitignored. Nothing here is pushed.

## One-time setup

```bash
/opt/homebrew/bin/python3.10 -m venv .venv-voice
.venv-voice/bin/pip install -r scripts/voiceover/requirements.txt
brew install espeak-ng          # already installed on this Mac
```

ffmpeg: `brew install ffmpeg` failed in the sandbox, so `voiceover.py` falls back to the ffmpeg bundled in `imageio-ffmpeg`. Nothing to do.

The first run downloads the Kokoro model from Hugging Face (about 330 MB) and a small spaCy model. Later runs are offline.

## Make a demo from the repo

```bash
# 1. get the recorder and narration (they live on another branch)
git checkout chore/remove-legacy        # or: git show 3ca7b84:docs/DEMO_CUT3.md > docs/DEMO_CUT3.md

# 2. record silently (app must be running: pnpm dev)
pnpm demo:record:cut

# 3. narration + timings -> beats
.venv-voice/bin/python scripts/voiceover/make_beats.py \
  docs/DEMO_CUT3.md demo-video/chimera-rx-cut-3min.json demo-video/cut3-beats.json

# 4. speak and mux into one video
.venv-voice/bin/python scripts/voiceover/voiceover.py --repo . \
  --script demo-video/cut3-beats.json \
  --video demo-video/chimera-rx-cut-3min.mp4 \
  --out demo-video/voiced
```

Step 4 prints one line per beat (speech seconds against slot seconds, speed used). It takes about a minute.

For a different GitHub repo: `voiceover.py --repo https://github.com/<owner>/<repo>`. It does a shallow clone and looks for `beats.json` and an `.mp4` beside it. Pass `--script` and `--video` when the names differ.

## Making it sound human

- Change voice: `--voice am_michael` (US male), `af_bella`, `af_nicole`, or `--lang b --voice bf_emma` (UK).
- Change feel: `--speed 1.1` raises the starting pace; `--seed 11` changes the small timing variation.
- A beat is too rushed: shorten its text in the beats json. The speed is clamped to 0.88 to 1.25, so a line with too many words cannot be fixed by the tool. It prints `OVER` when a line cannot fit.
- A beat leaves silence at its end: add words, or accept it. Going below 0.88x sounds drawn out. Gaps of 3 to 6 seconds at the end of beats 2, 3, 4, 5 and 7 remain in the current cut, where the screen is doing the work.
- A word is mispronounced: add it to the `PRONOUNCE` table in `voiceover.py`, or pass `--pronounce words.json`.
- Add `--keep-audio` to also keep `voiceover.wav` and `report.json`.

## Known limits

- The cut is 3:02.8. The 2025 Kiroween rule was under 3 minutes. The 2026 rule is unconfirmed because the Devpost page returned 403. Check the live rules page for length, upload site and file size.
- The narration was written for 150 words a minute. Beats 6 and 8 have short slots and run at about 1.2x.
- The 11-minute full tour has no beats file yet. Extract it from `docs/DEMO_FULL.md` the same way, but that file has its own layout, so `make_beats.py` may need adjusting.
- The audio was measured (mean -17 dB) but not listened to by the assistant. Play it once through before submitting.
- Synthetic data only, sandbox messaging. The demo must not say "compliant", "certified" or "clinically validated".
- Do not push or open pull requests until you do it together with the agent (project rule).

## Stop and clean up

Kokoro is not a service. It starts when `voiceover.py` runs and exits when it finishes. To free disk space: delete `.venv-voice/` and the Hugging Face cache folder `~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M`.
