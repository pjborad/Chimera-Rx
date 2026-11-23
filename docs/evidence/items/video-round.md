# Video round: submission video

- Output: demo-video/chimera-rx-submission.mp4 (1920x1080, H.264, AAC, 25 fps) and .srt. Gitignored.
- Duration 2:50.24. Voice Kokoro am_michael at speed 1.13 (am_adam compared: faster and less even, 204 wpm vs 186 at speed 1.2). 490 spoken words, 173 wpm.
- silencedetect (-35 dB, 0.4 s) on the final mp4: no gap reported. Quiet runs inside a unit are capped at 0.26 s in make-voice.py.
- Ten frames extracted and viewed: sign-in, receiving, Rx Guardian, recall, messages, agents, integrations, end card. No error states.
- Pipeline: scripts/demo/make-voice.py (audio first), scripts/demo/record-submission.mjs (own stack on 4660-4663, one step per narration unit, picture fitted to the audio, hold times learned from the previous run).
- ffmpeg: brew install failed in the sandbox; the pipeline uses the imageio-ffmpeg binary in .venv-voice (no ffprobe; duration read with ffmpeg -i).
- Not done: the video was not played with sound by a person; on-screen text and captions are not burned in except the lower-third role tags.
