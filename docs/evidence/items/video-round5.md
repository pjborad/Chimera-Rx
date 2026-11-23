# Video round 5: highlight rings and two voices

- Rings (scripts/demo/video-core.mjs): each ring is now tied to its element (rect recomputed every frame), lives 700 ms, is removed on scroll, resize and route change, and is cleared (and a clean frame awaited) before and after every step, navigation, scroll and card. No ring is kept across page loads. Cards no longer use the yellow bar and pulsing box.
- Voices: A `am_onyx` (why), B `am_michael` (how), env VOICE_A / VOICE_B; each turn trimmed and normalised to -16 LUFS; handover gap 60 ms. Captions are prefixed `A:` / `B:`.
- Mismatch fixed: DSCSA export and the sandbox verifier are separate narration units; the words "verified / not verified" match the screen.
- Result: 2:53.6, 528 words, 182.5 wpm, no silence over 0.4 s at -35 dB.
- Checked: 42 boundary frames (0.3 s before and after each of 21 cuts) and 12 mid-scene frames, all viewed. No ring on a screen it does not belong to. The only ring seen mid-scene sits on the Refrigerated filter it highlights.
- Not verified: playback with sound on a Mac.
