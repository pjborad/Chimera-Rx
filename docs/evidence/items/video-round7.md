# Video round 7: every tab, faster, voices in halves

- Owner request: show all the tabs, increase the speed, one voice does half and the other does the other half.
- Tabs (all 14 appear, pharmacist j.rivera signed in once off camera): Today 18.8 s (includes the opening hook), Receiving 12.4, Inventory 9.3, Register 7.6, Stock help 6.7, Transfers 7.6, Fill & pickup 20.6 (Rx Guardian evidence, accept), Patients 7.0, Recalls 17.5 (one gap example), Refills 5.1, DSCSA & trace 5.4, Sandbox outbox 4.5, AI agents 19.6 (Run now, background mode, providers), Integrations 11.7. Then roles and security 12.0 and Kiro with the end card 9.6.
- Pace: cursor glide about 450 ms, about 0.7 s after each click, a lower-third names each tab on arrival. Largest speed-up 1.32x (limit 1.4x); most steps sit at 0.9 to 1.0x.
- Voices: A `am_onyx` speaks Today through Fill & pickup and one handover line ("Over to my co-host for the care side"); B `am_michael` speaks Patients to the end card, including the URLs. Speaking time A 82.4 s (47.4%), B 91.4 s (52.6%). Voice speed 1.1. Captions keep the A:/B: prefix.
- Result: 2:55.4, 560 words, 192 wpm (spoken), no silence over 0.3 s at -35 dB, integrated loudness -16.0 LUFS and true peak -1.9 dBFS on the final file (ebur128). make-voice.py now measures and applies the final gain with a limiter at -2.5 dBFS (last round -17.4 LUFS).
- Checked by viewing: 30 boundary frames (0.3 s before and after 15 cuts) and 16 mid-scene frames. Right tab each time, pharmacist role only, no stray highlight box, no error. The app's own demo notice bar stays visible.
- Closing narration and end card: name, github.com/pjborad/Chimera-Rx, pjborad.github.io/Chimera-Rx only; "HIPAA-style safeguards, not certified" stays in the narration.
- Not verified: playback with sound on a Mac. Refills, DSCSA and outbox get 4.5 to 5.4 s each, short but readable.
