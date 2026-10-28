#!/usr/bin/env python3
"""Builds out/cut.mp4 for Headline (Blog Man's newsroom) with ffmpeg only. Usage: build.py [only-shot-index]"""
import json, subprocess, os, sys, glob
H = os.path.dirname(os.path.abspath(__file__)); R = os.path.abspath(os.path.join(H, '../..'))
P = H + '/parts'; os.makedirs(P, exist_ok=True)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
W, Hh, FPS = 1920, 1080, 24
CH = json.load(open(H + '/talk/chunks.json'))
def sh(args): subprocess.check_call(['ffmpeg', '-v', 'error', '-y'] + args)
def snd(n): return glob.glob(f'{H}/sfx/{n}/*.mp3')[0]
VID = ['-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', str(FPS)]

def zoomchain(z0, z1, dur, fy=0.28, fx=0.5):
    n = max(1, int(dur * FPS))
    return (f"zoompan=z='{z0}+({z1}-{z0})*on/{n}':x='iw*{fx}-iw/zoom*{fx}':y='ih*{fy}-ih/zoom*{fy}':d=1:s={W}x{Hh}:fps={FPS}")

def talk_cut(idx, clip, ss, dur, z0, z1, fy=0.28):
    out = f'{P}/{idx}.mp4'
    vf = f"scale={W}:{Hh}:flags=lanczos,fps={FPS},tpad=stop_mode=clone:stop_duration=3,{zoomchain(z0, z1, dur, fy)},eq=saturation=1.05,vignette=PI/6"
    sh(['-ss', f'{ss:.3f}', '-i', f'{H}/talk/{clip}.mp4', '-vf', vf, '-an', '-frames:v', str(round(dur * FPS))] + VID + [out]); return out

def still(idx, img, dur, z0=1.0, z1=1.15, fy=0.4, fx=0.5, extra='', shake=0):
    out = f'{P}/{idx}.mp4'
    sk = ''
    if shake:
        sk = f",crop={W-2*shake}:{Hh-2*shake}:x='{shake}+{shake}*sin(t*90)*max(0,1-t*2.2)':y='{shake}+{shake}*cos(t*110)*max(0,1-t*2.2)',scale={W}:{Hh}"
    vf = f"scale=2880:1620:flags=lanczos,{zoomchain(z0*1.0, z1, dur, fy, fx).replace(f's={W}x{Hh}', f's={W}x{Hh}')}{sk},fps={FPS},vignette=PI/6{extra}"
    sh(['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', img, '-vf', vf, '-an'] + VID + [out]); return out

def cutlist(idx, clip, ss, dur, zooms, fy=0.28):
    """split a talk segment into len(zooms) cuts, each (z0,z1)"""
    n = len(zooms); d = dur / n; outs = []
    for i, (a, b) in enumerate(zooms):
        outs.append(talk_cut(f'{idx}_{i}', clip, ss + i * d, d, a, b, fy))
    return outs

plates = {i: f'{H}/plates/P{i}.png' for i in range(1, 7)}
por = lambda d, f: glob.glob(f'{H}/portraits/{d}/*{f}.png')[0]
BMBOOM, BMBOOM2, BMMOVED, BMMOVED2 = por('bm_boom', '101'), por('bm_boom', '102'), por('bm_moved', '111'), por('bm_moved', '112')
EPDEAD1, EPDEAD2, EPCUR = por('ep_dead', '121'), por('ep_dead', '122'), por('ep_cur', '131')

# ---------- graphics ----------
def page_bg(headline, fs, photo_vf_inputs=None):
    pass

def make_headline_card(out, text_lines, fs, y0, stamp_t=0.4):
    """front page: newsprint plate with a big stamped headline (pops from large to size at stamp_t)"""
    dts = []
    for i, tl in enumerate(text_lines):
        dts.append(f"drawtext=fontfile={FONT}:text='{tl}':fontsize='if(lt(t-{stamp_t},0.12),{int(fs*1.6)},{fs})':fontcolor=0x141414:x=(w-text_w)/2:y={y0}+{i}*{int(fs*1.15)}:enable='gte(t,{stamp_t})'")
    return dts

def insert_page(idx, headline, fs, dur, sub=None):
    out = f'{P}/{idx}.mp4'
    dts = ",".join(make_headline_card(out, headline, fs, 300 if len(headline) == 1 else 250, 0.35))
    vf = (f"scale={W}:{Hh},drawbox=x=0:y=120:w=1920:h=830:color=0xefe6cf@1:t=fill,drawbox=x=60:y=150:w=1800:h=6:color=0x141414@1:t=fill,"
          f"drawbox=x=60:y=900:w=1800:h=6:color=0x141414@1:t=fill,"
          f"drawtext=fontfile={FONT}:text='THE DAILY DOSE':fontsize=64:fontcolor=0x141414:x=(w-text_w)/2:y=40,"
          f"drawtext=fontfile={FONT}:text='PAGE ONE':fontsize=34:fontcolor=0x555555:x=80:y=190,"
          + dts + f",{zoomchain(1.0, 1.08, dur, 0.5)},fps={FPS},vignette=PI/6")
    sh(['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', plates[6], '-vf', "scale=2880:1620," + vf.replace(f"scale={W}:{Hh},", f"scale={W}:{Hh},", 1), '-an'] + VID + [out]); return out

def halftone_page(idx, stage, char, headline, fs, dur, flip=False):
    out = f'{P}/{idx}.mp4'
    pw, ph = 1500, 560
    photo = f'{P}/{idx}_photo.png'
    sh(['-i', stage, '-i', char, '-filter_complex',
        f"[0]scale={pw*2}:{ph*2}:force_original_aspect_ratio=increase,crop={pw*2}:{ph*2}[b];[1]scale=-2:{int(ph*2*0.98)}[c];[b][c]overlay=x=(W-w)/2+{300 if not flip else -300}:y=H-h[o]", '-map', '[o]', '-frames:v', '1', photo])
    ht = ("format=gray,eq=contrast=1.35:brightness=0.02,"
          "geq=lum='255*gt(pow(lum(X,Y)/255,0.85),0.5+0.5*sin(0.75*(X+Y))*sin(0.75*(X-Y)))',"
          "format=rgb24,lutrgb=r='28+val*0.83':g='26+val*0.80':b='24+val*0.71'")
    n = int(dur * FPS)
    ph_vf = f"scale={pw*2}:{ph*2},zoompan=z='1.0+0.16*on/{n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={pw}x{ph}:fps={FPS},{ht}"
    txt = ",".join(make_headline_card(out, headline, fs, 190 if len(headline) == 1 else 170, 0.45))
    fc = (f"[0]scale={W}:{Hh}[bg];[1]{ph_vf}[p];"
          f"[bg]drawbox=x=0:y=110:w=1920:h=850:color=0xefe6cf@1:t=fill,drawbox=x=60:y=140:w=1800:h=6:color=0x141414@1:t=fill,"
          f"drawtext=fontfile={FONT}:text='THE DAILY DOSE':fontsize=64:fontcolor=0x141414:x=(w-text_w)/2:y=34,{txt}[b2];"
          f"[b2][p]overlay=x=(W-w)/2:y=390:shortest=1,drawbox=x=210:y=385:w=1500:h=5:color=0x141414@1:t=fill,drawbox=x=210:y=950:w=1500:h=5:color=0x141414@1:t=fill,"
          f"crop='{W-24}:{Hh-24}:x=12+10*sin(t*80)*max(0,1-(t-0.45)*5):y=12',scale={W}:{Hh},vignette=PI/6[o]")
    sh(['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', plates[6], '-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', photo,
        '-filter_complex', fc, '-map', '[o]', '-t', f'{dur:.3f}'] + VID + [out]); return out

def endcard(idx, dur=1.5):
    out = f'{P}/{idx}.mp4'
    sh(['-f', 'lavfi', '-i', f"color=c=0x0b0b0e:s={W}x{Hh}:r={FPS}:d={dur}", '-vf',
        f"drawtext=fontfile={FONT}:text='DOSE OF DESTRUCTION':fontcolor=0xe8c9a0:fontsize=110:x=(w-text_w)/2:y=(h-text_h)/2-30,"
        f"drawtext=fontfile={FONT}:text='Made with Hawkes Gen · hawkesgen.ai':fontcolor=0x9a9a9a:fontsize=34:x=(w-text_w)/2:y=(h/2)+90"] + VID + [out]); return out

def hook_page(idx, dur):
    out = f'{P}/{idx}.mp4'
    l1, l2 = 'LOCAL SKATER DEFEATS', 'LARGE SHARK'
    tt = []
    step = 0.04
    for line, y, t0 in ((l1, 330, 0.1), (l2, 470, 0.1 + len(l1) * step)):
        for i in range(1, len(line) + 1):
            a = t0 + (i - 1) * step; b = a + step if i < len(line) else 99
            tt.append(f"drawtext=fontfile={FONT}:text='{line[:i]}':fontsize=130:fontcolor=0x141414:x=140:y={y}:enable='between(t,{a:.3f},{b:.3f})'")
    vf = (f"scale=2880:1620,scale={W}:{Hh},drawbox=x=0:y=120:w=1920:h=830:color=0xefe6cf@1:t=fill,drawbox=x=60:y=150:w=1800:h=6:color=0x141414@1:t=fill,"
          f"drawtext=fontfile={FONT}:text='THE DAILY DOSE':fontsize=64:fontcolor=0x141414:x=(w-text_w)/2:y=40," + ",".join(tt) +
          f",{zoomchain(1.0, 1.12, dur, 0.4)},fps={FPS},vignette=PI/6")
    sh(['-loop', '1', '-framerate', str(FPS), '-t', f'{dur:.3f}', '-i', plates[6], '-vf', vf, '-an'] + VID + [out]); return out

def still_here_png():
    out = f'{P}/stillhere.png'
    vf = (f"scale={W}:{Hh},drawbox=x=0:y=0:w=1920:h=1080:color=0xefe6cf@1:t=fill,drawbox=x=60:y=60:w=1800:h=960:color=0x141414@1:t=3,"
          f"drawtext=fontfile={FONT}:text='STILL HERE.':fontsize=215:fontcolor=0x141414:x=(w-text_w)/2:y=(h-text_h)/2")
    sh(['-i', plates[6], '-vf', vf, '-frames:v', '1', out]); return out

def flurry(idx, dur, card):
    out = f'{P}/{idx}.mp4'
    cols, rows = 6, 6; n = cols * rows; tw, th = W // cols, Hh // rows
    fc = f"[0]scale={tw}:{th},split={n}" + "".join(f"[s{i}]" for i in range(n)) + ";"
    fc += f"color=c=0x0b0b0e:s={W}x{Hh}:r={FPS}:d={dur}[b0];"
    order = list(range(n))
    for k, i in enumerate(order):
        x, y = (i % cols) * tw, (i // cols) * th
        t0 = 0.05 + k * 0.045
        fc += f"[b{k}][s{i}]overlay=x={x}:y={y}:enable='gte(t,{t0:.3f})'[b{k+1}];"
    fc += f"[b{n}]{zoomchain(1.18, 1.0, dur, 0.5)},fps={FPS}[o]"
    sh(['-loop', '1', '-framerate', str(FPS), '-t', f'{dur}', '-i', card, '-filter_complex', fc, '-map', '[o]', '-t', f'{dur}'] + VID + [out]); return out

# ---------- timeline ----------
shots = []   # (list of part files)
aud = []     # (file, start, volume, [in])
T = [0.0]
def add(parts, dur): 
    shots.append((parts, dur)); s = T[0]; T[0] += dur; return s
def voice(name, at, vol=1.0): aud.append((f'{H}/audio/{name}.mp3', at, vol))
def sfx(name, at, vol=0.8, ss=0): aud.append((snd(name), at, vol, ss))

LINES = {}
for c, v in CH.items():
    for l, (o, d) in v['lines'].items(): LINES[l] = (c, o, d)

def line_shot(idx, lid, zooms, tail=0.3, fy=0.28, pre=0.1):
    c, o, d = LINES[lid]
    ss = max(0, o - pre); lag = o - ss
    dur = lag + d + tail
    parts = cutlist(idx, c, ss, dur, zooms, fy)
    s = add(parts, dur); voice(lid, s + lag); return s

if __name__ == '__main__':
    still_here_png()
    # 1 hook
    s = add([still('01', plates[4], 1.2, 1.0, 1.35, 0.5, 0.5, shake=14)], 1.2); sfx('bell', s, 0.9)
    s = add([hook_page('02', 1.5)], 1.5); sfx('keys', s, 0.7, 0.0)
    s = add([still('03', BMBOOM2, 1.0, 1.0, 1.1, 0.32, shake=22, extra=',eq=brightness=\'0.35*max(0,1-t*6)\'')], 1.0); sfx('slam', s, 1.0)
    line_shot('04', 'bm1', [(1.0, 1.12), (1.3, 1.5)])
    s = add([still('05', EPDEAD1, 1.7, 1.0, 1.18, 0.5, 0.5)], 1.7)
    line_shot('06', 'ep1', [(1.0, 1.1), (1.35, 1.45)], 0.35)
    add([still('07', BMBOOM, 1.1, 1.3, 1.4, 0.3)], 1.1)
    line_shot('08', 'bm2', [(1.0, 1.15), (1.3, 1.55)], 0.35)
    line_shot('09', 'ep2', [(1.4, 1.5)], 0.45, fy=0.32)
    line_shot('10', 'bm3', [(1.0, 1.1), (1.25, 1.45)], 0.5)
    line_shot('11', 'ep3', [(1.5, 1.9)], 0.9, fy=0.32)
    line_shot('12', 'bm4', [(1.0, 1.1), (1.3, 1.45), (1.0, 1.25)], 0.45)
    # montage: three halftone pages
    st = lambda s, c: f'{R}/stages/{s}/{c}.webp'
    ch = lambda c: f'{R}/characters/large/{c}.webp'
    pg = [halftone_page('13a', st('city-top', 'backdrop'), ch('kaelen'), ['HI, BYE.'], 190, 3.1),
          halftone_page('13b', st('yo-house', 'reference'), ch('break'), ['THE HOUSE FELL', 'OFF THE HOUSE'], 100, 3.1, True),
          halftone_page('13c', st('solar-array', 'reference'), ch('exit-punk'), ['LOST COUNT', 'OF THE FLOORS'], 100, 4.6)]
    s = T[0]
    mont = f'{P}/13.mp4'
    sh(['-i', pg[0], '-i', pg[1], '-i', pg[2], '-filter_complex',
        '[0][1]xfade=transition=slideleft:duration=0.2:offset=2.9[a];[a][2]xfade=transition=slideleft:duration=0.2:offset=5.8[o]', '-map', '[o]'] + VID + [mont])
    add([mont], 10.4); voice('bm5', s + 0.05)
    for off in (0.45, 3.35, 6.25): sfx('stamp', s + off, 0.9)
    line_shot('14', 'ep4', [(1.1, 1.25)], 0.45, fy=0.32)
    line_shot('15', 'bm6', [(1.1, 1.5)], 0.5)
    s = add([still('16', plates[3], 2.2, 1.0, 1.25, 0.5)], 2.2); sfx('room', s, 0.6, 0)
    line_shot('17', 'ep5', [(1.2, 1.4)], 0.25, fy=0.3)
    line_shot('18', 'bm7', [(1.0, 1.1), (1.15, 1.4)], 0.4)
    line_shot('19', 'ep6', [(1.25, 1.45)], 0.55, fy=0.3)
    line_shot('20', 'bm8a', [(1.15, 1.45)], 0.4)
    s = add([still('21', plates[3], 0.9, 1.25, 1.3, 0.5)], 0.9); sfx('room', s, 0.5, 3)
    line_shot('22', 'bm8b', [(1.0, 1.1), (1.3, 1.45), (1.05, 1.3)], 0.4)
    s = add([still('23', plates[4], 1.5, 1.0, 1.25, 0.5)], 1.5)
    s = add([still('24', plates[4], 2.6, 1.7, 2.4, 0.97, 0.40, shake=0)], 2.6); sfx('keys', s, 0.9, 0.0)
    s = add([insert_page('25', ['STILL HERE.'], 215, 1.6)], 1.6); sfx('stamp', s + 0.3, 1.0)
    line_shot('26', 'bm9', [(1.1, 1.3)], 0.4)
    line_shot('27', 'ep7', [(1.1, 1.2), (1.3, 1.5)], 0.6, fy=0.32)
    add([still('28', BMMOVED2, 1.0, 1.0, 1.08, 0.32)], 1.0)
    line_shot('29', 'bm10', [(1.45, 1.8)], 0.3)
    add([still('30', BMMOVED, 1.2, 1.15, 1.25, 0.32)], 1.2)
    line_shot('31', 'bm11', [(1.3, 1.1), (1.1, 1.25)], 0.5)
    s = add([still('32', plates[5], 2.2, 1.0, 1.3, 0.5, 0.35)], 2.2); sfx('tube', s, 1.0, 0)
    s = add([flurry('33', 2.4, f'{P}/stillhere.png')], 2.4); voice('an1', s + 0.35, 1.0)
    add([endcard('34')], 1.5)

    # concat video
    lst = f'{P}/list.txt'
    with open(lst, 'w') as f:
        for parts, d in shots:
            for p in parts: f.write(f"file '{p}'\n")
    sh(['-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', f'{H}/out/video_only.mp4'])
    total = T[0]
    # audio mix
    ins, fl = [], []
    for i, a in enumerate(aud):
        f, at, vol = a[0], a[1], a[2]; ss = a[3] if len(a) > 3 else 0
        ins += ['-ss', str(ss), '-i', f]
        fl.append(f"[{i}]aformat=sample_rates=44100:channel_layouts=stereo,volume={vol},adelay={int(at*1000)}|{int(at*1000)}[a{i}]")
    mix = ";".join(fl) + ";" + "".join(f"[a{i}]" for i in range(len(aud))) + f"amix=inputs={len(aud)}:normalize=0:dropout_transition=0,alimiter=limit=0.95,atrim=0:{total}[o]"
    sh(ins + ['-filter_complex', mix, '-map', '[o]', '-c:a', 'aac', '-b:a', '192k', f'{H}/out/audio.m4a'])
    sh(['-i', f'{H}/out/video_only.mp4', '-i', f'{H}/out/audio.m4a', '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', f'{H}/out/cut.mp4'])
    json.dump({'seconds': total, 'shots': [(p, d) for p, d in shots]}, open(f'{H}/out/timeline.json', 'w'), indent=1)
    print('total', total)
