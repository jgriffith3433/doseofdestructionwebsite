#!/usr/bin/env python3
"""Mixes the cut's audio: song (two parts around the bridge), 9 voice lines, synthesized sfx. Usage: mix.py <workdir>"""
import subprocess, sys
WD = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dropin"
A = f"{WD}/aud"
OUT = f"{WD}/mix.wav"
TOTAL = 111.9
def run(*a): subprocess.run(["ffmpeg", "-v", "error", "-y", *a], check=True)

# ---- synthesized sfx (lavfi) ----
S = f"{WD}/sfx"; import os; os.makedirs(S, exist_ok=True)
def synth(name, src, af):
    run("-f", "lavfi", "-i", src, "-af", af, "-ar", "44100", "-ac", "2", f"{S}/{name}.wav")
synth("crash", "anoisesrc=d=2.6:c=white:a=0.9", "highpass=f=2500,volume='exp(-t*1.9)':eval=frame,volume=1.6")
synth("whoosh", "anoisesrc=d=1.1:c=pink:a=0.7", "bandpass=f=900:w=1.5,afade=t=in:d=0.5,afade=t=out:st=0.5:d=0.6,volume=1.4")
synth("fire", "anoisesrc=d=1.6:c=brown:a=1.0", "lowpass=f=1800,afade=t=in:d=0.25,afade=t=out:st=0.4:d=1.2,volume=2.0")
synth("thump", "sine=f=62:d=0.6", "volume='exp(-t*7)':eval=frame,volume=2.2,lowpass=f=300")
synth("impact", "anoisesrc=d=0.5:c=white:a=0.9", "bandpass=f=1800:w=2,volume='exp(-t*14)':eval=frame,volume=1.3")
synth("clack", "anoisesrc=d=0.15:c=white:a=0.9", "bandpass=f=2500:w=1.5,volume='exp(-t*40)':eval=frame,volume=1.2")
synth("tick", "sine=f=1320:d=0.12", "volume='exp(-t*30)':eval=frame")
synth("roar", "anoisesrc=d=4.0:c=pink:a=0.8", "bandpass=f=1100:w=2.5,tremolo=f=7:d=0.4,afade=t=in:d=1.0,afade=t=out:st=2.5:d=1.5,volume=1.6")
synth("note", "aevalsrc='0.35*sin(2*PI*246.94*t)+0.2*sin(2*PI*369.99*t)+0.12*sin(2*PI*493.88*t)':d=8.4:s=44100", "tremolo=f=5:d=0.12,afade=t=in:d=0.5,afade=t=out:st=6.6:d=1.8,volume=0.9")
synth("crackle", "anoisesrc=d=2.0:c=white:a=0.5", "highpass=f=4000,tremolo=f=19:d=0.95,volume=0.25,afade=t=out:st=1.2:d=0.8")

# ---- timeline: (file, start, volume) ----
voices = [("py_hook", 0.5), ("ep_dont", 5.5), ("py_nobody", 7.7), ("ep_know", 41.3), ("py_three", 62.6), ("ep_again", 67.0),
          ("py_flat", 103.5), ("ep_chorus", 105.7), ("py_stay", 107.8)]
sfx = [("crash", 0.0, 1.0), ("fire", 0.05, 0.9), ("crash", 25.6, 0.7), ("crash", 69.0, 0.9), ("clack", 5.6, 0.6), ("whoosh", 21.0, 0.8), ("clack", 22.9, 0.7),
       ("thump", 46.5, 1.0), ("impact", 46.5, 0.9), ("fire", 46.5, 0.7), ("thump", 50.9, 1.0), ("impact", 50.9, 0.9), ("fire", 50.9, 0.7),
       ("thump", 53.5, 1.2), ("impact", 53.5, 1.0), ("fire", 53.4, 0.9), ("tick", 54.8, 0.8), ("tick", 55.15, 0.8),
       ("roar", 54.9, 0.9), ("roar", 56.3, 0.7), ("note", 61.2, 0.9), ("roar", 81.0, 0.8), ("whoosh", 66.8, 0.5), ("whoosh", 68.6, 0.9),
       ("crackle", 101.6, 0.9), ("crackle", 105.0, 0.4)]
duck = [(0.5, 9.4), (41.2, 43.2), (62.4, 68.6), (103.4, 109.8)]

inputs = []; filt = []; labels = []
def add(path):
    inputs.extend(["-i", path]); return len(inputs) // 2 - 1
# song A: src 0..61.0 at 1.2 ; song B: src 65.1..97.7 at 69.0
ia = add(f"{A}/song.mp3"); ib = add(f"{A}/song.mp3")
mus_a = f"[{ia}:a]atrim=0:61.0,asetpts=PTS-STARTPTS,afade=t=out:st=60.4:d=0.6,adelay=1200|1200,aformat=sample_rates=44100:channel_layouts=stereo[ma]"
mus_b = f"[{ib}:a]atrim=65.1:97.7,asetpts=PTS-STARTPTS,afade=t=in:d=0.04,afade=t=out:st=31.4:d=1.2,adelay=69000|69000,aformat=sample_rates=44100:channel_layouts=stereo[mb]"
dv = "*".join(f"(1-0.62*between(t,{a},{b}))" for a, b in duck)
filt += [mus_a, mus_b, f"[ma][mb]amix=inputs=2:normalize=0[mus0]", f"[mus0]volume='{dv}':eval=frame,volume=0.9[mus]"]
labels.append("[mus]")
for i, (n, st) in enumerate(voices):
    k = add(f"{A}/{n}.mp3"); ms = int(st * 1000)
    filt.append(f"[{k}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=1.5,adelay={ms}|{ms}[v{i}]"); labels.append(f"[v{i}]")
for i, (n, st, vol) in enumerate(sfx):
    k = add(f"{S}/{n}.wav"); ms = int(st * 1000)
    filt.append(f"[{k}:a]volume={vol},adelay={ms}|{ms}[s{i}]"); labels.append(f"[s{i}]")
filt.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0:dropout_transition=0,alimiter=limit=0.95,apad=whole_dur={TOTAL},atrim=0:{TOTAL}[out]")
run(*inputs, "-filter_complex", ";".join(filt), "-map", "[out]", "-ar", "44100", OUT)
print("mix ok", OUT)
