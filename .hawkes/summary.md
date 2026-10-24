Open Mic v6 FINAL (cut a_ee3002fedf9bfb2b, 35.5 s, edit-only, $0 GPU; about $5.60 of $6.03 used overall).
1. Stray vocal fragment before "Then you'll have to go through the main event": muted the bleed (scene B 8.5-10.35 s); the line now starts clean at 0:21.0. Checked by audio levels (silence 0:18.5-21.0, then the line).
2. "No sponsor. No record." lip sync: voice and caption moved 4 frames later against the picture. Not verified by the critic (Gemini 429); my own mouth-motion measurement was inconclusive, so J should check by eye.
3. Full-bleed portrait: not done. Gen's video.scene aspect enum still lacks the portrait value the H3 workflow wants, and about $0.4 is left; scenes stay 1:1 in navy bands. Needs the enum fix plus about $2-3 to re-render A-D.
Source: videos/open-mic-tonight-on-the-show/build_v6.py, edit.json.
