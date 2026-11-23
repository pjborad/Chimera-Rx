# Demo video recorder

Re-record the 3-minute demo video with the scripted voiceover:

```bash
pnpm demo:record
```

Output (git-ignored) goes to `demo-video/`: `chimera-rx-demo.mp4` (H.264 + AAC, 1440x900), `chimera-rx-demo.srt`, `poster.png` (1280x720), `beats.json` (start offset of every beat).

What it does: builds the web app, starts its own API on port 4560 with a temp `DATA_DIR`, `LG_DEMO=1` and `LLM_PROVIDER=mock`, speaks every row of the Say column in `docs/DEMO_SCRIPT.md` with macOS `say`, drives the real UI in Chromium while each beat lasts at least as long as its audio, then muxes picture and voice. It stops its own API when done. It never touches ports 4000, 5173 or 5174.

Options (environment): `DEMO_VOICE` (default `Samantha`), `DEMO_RATE` words per minute (default `172`), `DEMO_PORT` (default `4560`), `SKIP_BUILD=1`.

Notes:

- macOS only. It needs Playwright's Chromium (`npx playwright install chromium`), `say`, `afconvert`, `sips` and `swiftc` (Xcode command line tools). The ffmpeg bundled with Playwright has no H.264 or audio encoders, so `mux.swift` encodes with AVFoundation. Frames come from a CDP screencast with their own timestamps, because Playwright's `recordVideo` ran about 4% slow against the wall clock and put the voice out of sync.
- The voice is a synthetic macOS voice. To use your own voice, read `docs/DEMO_SCRIPT.md` over the video using the `.srt` timings as a guide, and replace the audio track in any editor.
- Beat 4 uses a tiny stand-in model (a local OpenAI-compatible stub on port 4561 that invents one lot) so the real Coroner gate visibly drops it. The offline mock never invents a lot. The provider is set back to the mock right after. Everything is synthetic and sandboxed.
- The camera scan is not shown; the script uses the same steps as `scripts/e2e/demo-e2e.mjs`.

## Silent recordings for your own voiceover (DEMO-3)

```bash
pnpm demo:record:full   # demo-video/chimera-rx-full-tour.mp4, about 11 minutes, follows docs/DEMO_FULL.md
pnpm demo:record:cut    # demo-video/chimera-rx-cut-3min.mp4, about 3 minutes, follows docs/DEMO_CUT3.md
```

Both are silent H.264 files (no audio track, no synthetic speech) from `scripts/demo/record-silent.mjs` (helpers in `lib.mjs`, encoder `mux.swift` with the audio argument `none`). `pnpm demo:record` (the older synthetic-voice video) still works.

Each run writes next to the mp4: `<name>.cues.md` (every beat with its time code, the on-screen action and the first words to read), `<name>.chapters.txt` (one line per section) and `<name>.json` (timings, cuts, failed beats).

- Pacing: each section has a time target taken from its script window (about 150 words a minute), and a beat starts when its spoken paragraph starts. The Fill & pickup section is given extra time because it shows every path.
- On screen: a caption bar names the screen and action (it does not repeat the voiceover), a bar along the bottom shows the section letter (A to H, or beat 1 to 8), a ring marks each clicked control for about a second, and the demo notice is pinned at the top.
- Jump cuts: slow waits (OCR, bulk sends, switching role) are cut out of the picture, so time codes are picture time.
- Stack: its own API on port 4580 (stand-in model on 4581), temp `DATA_DIR`, `LG_DEMO=1`, `LLM_PROVIDER=mock`. It never touches 4000, 5173 or 5174, and stops its own API by PID. Needs macOS, Playwright Chromium and `swiftc`.
- Env: `DEMO_PORT`, `SKIP_BUILD=1`, `DEMO_ONLY=B5,B9` (record only those sections, for development, no cues), `NOMUX=1` (keep the frames, skip encoding), `KEEP_FRAMES=1`.
- "Stand-in model": the Coroner moments use a tiny local OpenAI-compatible stub that invents one lot, so the real gate visibly drops it. Captions say so.
- The Class I recall D-0611-2026 is looked up through the API just before its beat (off camera, the caption says so), because the Recalls screen does not offer a new look-up after a recall is closed.
