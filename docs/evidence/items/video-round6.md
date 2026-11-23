# Video round 6: slower, pharmacist view only

- Owner feedback: screens moved too fast. Now the whole video is the pharmacist's view (j.rivera, signed in once off camera). Cashier and admin are mentioned in narration and a four-role lower-third only. No store switch.
- Pace: 8 scenes (Today, Receiving, Fill, AI agents, Recalls, Integrations, Roles and security, Kiro), average 21.2 s each. Cursor glide about 700 ms, 1.3 s after each click. Largest speed-up 1.22x (limit 1.25x).
- Voices: A `am_onyx`, B `am_michael`, speed 1.0, handover gap 60 ms, speaker-prefixed captions.
- Result: 2:49.8, 508 words, 179.6 wpm, no silence over 0.4 s at -35 dB, integrated loudness -17.4 LUFS (ebur128 on the final file; -16 LUFS per turn before the final loudnorm).
- End card: name, github.com/pjborad/Chimera-Rx, pjborad.github.io/Chimera-Rx only. The "synthetic data only" line is gone from the card and narration. The app's own demo notice bar stays visible on staff pages.
- Checked by viewing: 14 boundary frames (0.3 s before and after 7 cuts) and 12 mid-scene frames. Only the pharmacist role appears; no ring on a wrong screen; no errors. A first render showed "Audit chain · Admin" in a lower-third; fixed and re-rendered.
- Dropped from last round: DSCSA scene and technician, cashier and admin sign-ins.
- Not verified: playback with sound on a Mac. Duration is 0.2 s under the 2:50 target.
