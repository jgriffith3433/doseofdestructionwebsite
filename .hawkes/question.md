# Open Mic (tonight on the show): portrait scenes can't run, Gen needs a one-line fix

All four animatic scenes failed at validation (no GPU spent beyond cents): Gen's `video.scene` only accepts `aspect` = 16:9 / 9:16 (Portrait) / 1:1, but the MiniMax H3 workflow's list has no "9:16 (Portrait)". It wants "9:16 (Portrait Widescreen)" (also 3:4 "Portrait Standard", 2:3). Gen refuses that value up front, so I can't send it. Same blocker as the earlier Open Mic (Shutup Bot) video. Refs, kits, table read and the four prompts are ready (see videos/open-mic-tonight-on-the-show/video.json and .hawkes/waiting-jobs.txt).

Options:
1. (My pick) Fix Gen's video.scene `aspect` enum to include "9:16 (Portrait Widescreen)" (map it through), then I re-queue the four scenes unchanged (~$2.6 animatic, within the $6.03 budget, ~$5.3 left).
2. Make the scenes 1:1 (square, 0.5 MP = 720 px) and fit them into the 1080x1920 frame with a set-coloured band top and bottom for the end card and captions. Works now but the picture is smaller, with some blur from the upscale.
3. Make them 16:9 and letterbox into the vertical frame. Loses even more picture. Not recommended.

Which one?
