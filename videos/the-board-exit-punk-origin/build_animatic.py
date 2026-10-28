#!/usr/bin/env python3
"""Cut the Board v2 animatic: held on-model stills with moves, real voices, captions.
Usage: build_animatic.py <keyframe dir with <key>_<take>.png> <audio dir (M1.mp3, sfx_*.mp3, hum.mp3...)> <out dir>"""
import subprocess, sys, os, json
K, A, O = sys.argv[1:4]
os.makedirs(O, exist_ok=True)
FPS = 24
# (start, dur, image, move, crop(x,y,w,h as fractions) or None, caption)
S = [
 (0.0,2.0,'hook_0','zin',None,''),
 (2.0,1.4,'ride_1','pan',None,''),
 (3.4,1.8,'creeper_1','zin',None,'MECHANIC: You\'re late.'),
 (5.2,2.3,'ep_defensive_1','zin',None,'EXIT PUNK: I\'m eleven seconds late.'),
 (7.5,3.2,'ots_mech_0','zin',None,'MECHANIC: Eleven seconds is how a furnace goes out.'),
 (10.7,1.3,'ep_sheepish_0','zin',None,'EXIT PUNK: It\'s a bolt.'),
 (12.0,1.6,'mech_stern_1','zin',None,'MECHANIC: It\'s THE bolt.'),
 (13.6,2.1,'board_snapped_1','zin',None,'MECHANIC: That deck\'s snapped.'),
 (15.7,3.3,'ep_smirk_1','zin',None,'EXIT PUNK: It\'s fine. It\'s held together by optimism.'),
 (19.0,4.6,'mech_soft_1','zin',None,'MECHANIC: It\'s held together by me. Third time this month. Sit.'),
 (23.6,2.4,'weld_1','zin',None,''),
 (26.0,1.8,'ep_watching_0','zin',None,''),
 (27.8,2.0,'file_1','pan',None,''),
 (29.8,1.8,'wheel_0','zin',None,''),
 (31.6,1.7,'creeper_1','zin',(0.0,0.0,1.0,1.0),''),
 (33.3,2.3,'mech_soft_0','zin',None,'MECHANIC: You know why you keep breaking it?'),
 (35.6,2.1,'ep_smirk_0','zin',None,'EXIT PUNK: I\'m bad at stopping.'),
 (37.7,2.8,'mech_soft_1','zout',None,'MECHANIC: You never ride it anywhere you\'re allowed.'),
 (40.5,3.0,'ep_hurt_1','zin',None,'EXIT PUNK: Nowhere I\'m allowed to ride has an exit.'),
 (43.5,4.0,'ots_mech_1','zin',None,'MECHANIC: There\'s a window upstairs. Gets the broadcast. Whole city watching the floor at midnight.'),
 (47.5,2.0,'ride_1','pan',(0.2,0.0,0.6,0.6),''),
 (49.5,4.3,'mech_grave_0','zin',None,'MECHANIC: People who walk onto that stage don\'t come back the same. Or at all.'),
 (53.8,2.0,'ep_hopeful_1','zin',None,'EXIT PUNK: Sounds like a way out.'),
 (55.8,2.2,'mech_grave_1','zin',None,'MECHANIC: It\'s a way in. New rule. Wheels down.'),
 (58.0,2.2,'handoff_1','zin',None,'MECHANIC: Whatever you land on, wheels down.'),
 (60.2,1.5,'mech_stern_0','zin',None,''),
 (61.7,1.3,'ep_hopeful_0','zin',None,'EXIT PUNK: That\'s the rule?'),
 (63.0,4.2,'mech_soft_0','zin',None,'MECHANIC: Only one I ever kept. And bring the bolt back.'),
 (67.2,2.8,'ride_0','zin',None,''),
 (70.0,2.2,'drop_1','zin',(0.0,0.0,1.0,0.6),'ANNOUNCER: Tonight, a walk-on.'),
 (72.2,2.1,'ep_resolve_1','zin',None,'EXIT PUNK: Wheels down.'),
 (74.3,1.5,'drop_0','zout',None,''),
]
END = 75.8
VOICE = [('M1',3.4),('E1',5.2),('M2',7.5),('E2',10.7),('M3',12.0),('E3',15.7),('M4',19.1),('M5',33.3),('E4',35.6),('M6',37.8),('E5',40.6),
         ('M7',43.6),('E6',53.9),('M8',55.8),('E7',61.7),('M9',63.05),('ANN',70.0),('E8',72.3)]
SFX = [('sfx_land',2.0,1.0),('sfx_creeper',3.2,0.6),('sfx_weld',23.6,0.8),('sfx_file',27.8,0.8),('sfx_wheel',29.8,0.8),('sfx_crowd',69.5,0.5),('sfx_land',74.6,0.9)]
clips = []
for i,(t,d,img,mv,crop,cap) in enumerate(S):
    n = max(1,round(d*FPS)); out = f'{O}/s{i:02d}.mp4'
    cf = ''
    if crop:
        x,y,w,h = crop; cf = f"crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},"
    z = {'zin':f"zoom='1+0.10*on/{n}'",'zout':f"zoom='1.10-0.10*on/{n}'",'pan':f"zoom=1.12"}[mv]
    xp = "x='iw/2-iw/zoom/2'" if mv!='pan' else f"x='(iw-iw/zoom)*on/{n}'"
    vf = f"{cf}scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan={z}:{xp}:y='ih/2-ih/zoom/2':d={n}:s=1920x1080:fps={FPS}"
    if cap:
        open(f'{O}/c{i:02d}.txt','w').write(cap)
        vf += f",drawtext=textfile={O}/c{i:02d}.txt:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=44:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-130"
    subprocess.run(['ffmpeg','-loglevel','error','-y','-i',f'{K}/{img}.png','-vf',vf,'-frames:v',str(n),'-pix_fmt','yuv420p',out],check=True)
    clips.append(out)
# card
card = f'{O}/card.mp4'
subprocess.run(['ffmpeg','-loglevel','error','-y','-f','lavfi','-i',f'color=c=black:s=1920x1080:r={FPS}:d=1.5','-vf',
 "drawtext=text='DOSE OF DESTRUCTION':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-20,"
 "drawtext=text='Made with Hawkes Gen · hawkesgen.ai':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=28:fontcolor=0xaaaaaa:x=(w-text_w)/2:y=h/2+70",'-pix_fmt','yuv420p',card],check=True)
clips.append(card)
open(f'{O}/list.txt','w').write(''.join(f"file '{os.path.abspath(c)}'\n" for c in clips))
subprocess.run(['ffmpeg','-loglevel','error','-y','-f','concat','-safe','0','-i',f'{O}/list.txt','-c','copy',f'{O}/video.mp4'],check=True)
total = END+1.5
ins = []; fl = []; labels = []
def add(path, delay, vol, extra=''):
    k = len(ins)//2; ins.extend(['-i',path])
    fl.append(f"[{k}]{extra}adelay={int(delay*1000)}|{int(delay*1000)},volume={vol}[a{k}]"); labels.append(f'[a{k}]')
add(f'{A}/hum.mp3',0,0.35,f'atrim=0:67.5,afade=t=out:st=65:d=2.5,')
add(f'{A}/drums.mp3',67.2,0.5,f'atrim=0:9.5,afade=t=out:st=7.5:d=2,')
for v,t in VOICE: add(f'{A}/{v}.mp3',t,1.6)
for s,t,vol in SFX: add(f'{A}/{s}.mp3',t,vol,'atrim=0:3,')
fc = ';'.join(fl)+';'+''.join(labels)+f"amix=inputs={len(labels)}:normalize=0,atrim=0:{total},alimiter=limit=0.95[a]"
subprocess.run(['ffmpeg','-loglevel','error','-y']+ins+['-i',f'{O}/video.mp4','-filter_complex',fc,'-map','[a]','-map',f'{len(ins)//2}:v','-c:v','copy','-c:a','aac','-b:a','192k',f'{O}/cut.mp4'],check=True)
json.dump([dict(t=s[0],seconds=s[1],image=s[2],caption=s[5]) for s in S],open(f'{O}/timeline.json','w'),indent=1)
print('ok',total)
