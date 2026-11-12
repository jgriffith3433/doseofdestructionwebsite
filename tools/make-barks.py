#!/usr/bin/env python3
"""Normalise raw fighter bark takes (Hawkes Gen voice_line mp3s) to -16 LUFS into audio/voice/.
Usage: tools/make-barks.py <rawdir>   (files <fighter>.<slot>.mp3; <fighter>.hurt.0 also makes hurt.1 at +6% pitch)
Short clips are padded to 1 s for the loudness measurement (ebur128 needs a 400 ms block), then a plain gain is applied."""
import subprocess, sys, re, os
TRIM = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"
def run(args): return subprocess.run(args, capture_output=True, text=True)
def make(src, dst, pre=""):
    chain = (pre + "," if pre else "") + TRIM
    tmp = dst + ".tmp.wav"
    run(["ffmpeg","-loglevel","error","-y","-i",src,"-af",chain,"-ar","44100","-ac","1",tmp])
    r = run(["ffmpeg","-nostats","-i",tmp,"-af","apad=whole_dur=1,ebur128","-f","null","-"])
    i = float(re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)[-1])
    gain = -16 - i
    run(["ffmpeg","-loglevel","error","-y","-i",tmp,"-af",f"volume={gain}dB,alimiter=limit=0.84:level=disabled","-ar","44100","-ac","1","-b:a","96k",dst])
    os.remove(tmp)
raw = sys.argv[1]
for f in sorted(os.listdir(raw)):
    b = f[:-4]; src = os.path.join(raw, f)
    make(src, f"audio/voice/fighter.{b}.mp3")
    if b.endswith(".hurt.0"):
        make(src, f"audio/voice/fighter.{b[:-2]}.1.mp3", "asetrate=46747,aresample=44100")
