#!/usr/bin/env python3
"""Turn a narration markdown (docs/DEMO_CUT3.md style) plus the recorder's timing json
into the beats file voiceover.py reads.

  python make_beats.py docs/DEMO_CUT3.md demo-video/chimera-rx-cut-3min.json demo-video/cut3-beats.json

The markdown must hold one `> quote` line per beat, in order, between the headings
"## 3. The script" and the next "## " heading. `[pause]` markers are removed.
The json is the recorder's sidecar: {"sections": [{"start": seconds, ...}, ...]}.
"""
import json, re, sys

md_path, timing_path, out_path = sys.argv[1:4]
md = open(md_path).read().split("## 3. The script")[1].split("\n## ")[0]
say = [re.sub(r"\s*\[pause\]\s*", " ", q).strip() for q in re.findall(r"^> (.*)$", md, flags=re.M)]
sections = json.load(open(timing_path))["sections"]
if len(say) != len(sections):
    sys.exit(f"{len(say)} narration beats but {len(sections)} timed sections; they must match")


def clock(s: float) -> str:
    s = int(round(s))
    return f"{s // 60}:{s % 60:02d}"


beats = [{"start": clock(s["start"]), "say": t} for s, t in zip(sections, say)]
json.dump(beats, open(out_path, "w"), indent=1)
print(f"wrote {out_path}: {len(beats)} beats")
