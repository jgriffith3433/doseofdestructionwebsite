#!/usr/bin/env python3
"""Cut The Board v3 animatic: held on-model stills with moves, real voices, captions (<=38 chars/card, 2 lines).
Usage: build_v3.py <out dir>   (reads stills/, audio/, keys.json: shot name -> still file, optional crop)"""
import subprocess, sys, os, json, textwrap
H = os.path.dirname(os.path.abspath(__file__)); O = sys.argv[1]; os.makedirs(O, exist_ok=True)
FPS = 24
KEYS = json.load(open(f'{H}/keys.json'))
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
# (start, dur, key, move, caption) ; moves: zin zout pan shake
S = [
 (0.0,1.0,'hook','shake',''),
 (1.0,1.0,'hook_land','shake',''),
 (2.0,1.2,'ride_1','pan',''),
 (3.2,1.8,'creeper2','zin','MECHANIC: You\'re late.'),
 (5.0,1.0,'watch','zin',''),
 (6.0,2.1,'ep_defensive_1','zin','EXIT PUNK: I\'m eleven seconds late.'),
 (8.1,2.5,'ots_mech2','zin','MECHANIC: Eleven seconds is how a furnace goes out.'),
 (10.6,1.9,'ep_sheepish_0','zin','EXIT PUNK: It\'s a bolt.'),
 (12.5,2.0,'mech_stern_1','zin','MECHANIC: It\'s THE bolt.'),
 (14.5,1.5,'board_snapped_1','zin','MECHANIC: That deck\'s snapped.'),
 (16.0,1.6,'ep_smirk_0','zin','EXIT PUNK: It\'s fine. It\'s held together by optimism.'),
 (17.6,1.6,'ep_smirk_1','zout',''),
 (19.2,2.1,'mech_soft_1','zin','MECHANIC: It\'s held together by me. Third time this month. Sit.'),
 (21.3,1.2,'ep_defensive_0','zin',''),
 (22.5,1.0,'wrench','zin',''),
 (23.5,2.0,'weld','zin',''),
 (25.5,1.8,'ep_watching_0','zin',''),
 (27.3,1.8,'file','pan',''),
 (29.1,1.6,'wheel_0','zin',''),
 (30.7,1.3,'ep_watching_1','zin',''),
 (32.0,2.5,'board_between','zin','MECHANIC: You know why you keep breaking it?'),
 (34.5,2.1,'ep_smirk_1','zin','EXIT PUNK: I\'m bad at stopping.'),
 (36.6,2.8,'mech_soft_0','zout','MECHANIC: You never ride it anywhere you\'re allowed.'),
 (39.4,1.8,'ep_hurt_1','zin','EXIT PUNK: Nowhere I\'m allowed to ride has an exit.'),
 (41.2,1.1,'ep_hurt_0','zin',''),
 (42.3,1.5,'mech_soft_1','zin',''),
 (43.8,3.0,'ots_mech2','zin','MECHANIC: There\'s a window upstairs. Gets the broadcast.'),
 (46.8,3.0,'mech_grave_0','zin','Whole city watching the floor at midnight.'),
 (49.8,1.2,'ep_hurt_1','zin','People who walk onto that stage'),
 (51.0,3.0,'mech_grave_1','zin','don\'t come back the same. Or at all.'),
 (54.0,1.9,'ep_hopeful_1','zin','EXIT PUNK: Sounds like a way out.'),
 (55.9,1.6,'mech_grave_0','zin','MECHANIC: It\'s a way in.'),
 (57.5,2.5,'handoff_1','zin','MECHANIC: New rule. Wheels down.'),
 (60.0,1.8,'handoff_0','zin','MECHANIC: Whatever you land on, wheels down.'),
 (61.8,1.4,'ep_hopeful_0','zin','EXIT PUNK: That\'s the rule?'),
 (63.2,2.0,'mech_soft_0','zin','MECHANIC: Only one I ever kept.'),
 (65.2,2.0,'mech_stern_0','zin','MECHANIC: And bring the bolt back.'),
 (67.2,2.0,'ride_0','pan',''),
 (69.2,1.8,'ride_1','pan',''),
 (71.0,1.8,'grate_ep','zin','ANNOUNCER: Tonight, a walk-on.'),
 (72.8,1.6,'ep_resolve_1','zin','EXIT PUNK: Wheels down.'),
 (74.4,1.2,'drop_1','zin',''),
 (75.6,0.6,'drop_0','zout',''),
]
END = 76.2
VOICE = [('M1',3.3),('E1',6.1),('M2',8.2),('E2',11.3),('M3',12.6),('E3',16.0),('M4',19.2),('M5',32.3),('E4',34.6),('M6',36.7),('E5',39.5),
         ('M7',43.9),('E6',54.1),('M8',55.9),('E7',61.9),('M9',63.2),('ANN',71.0),('E8',73.0)]
SFX = [('sfx_land',1.0,1.0),('sfx_creeper',3.0,0.6),('sfx_weld',23.5,0.8),('sfx_file',27.3,0.8),('sfx_wheel',29.1,0.8),('sfx_crowd',70.5,0.5),('sfx_land',74.6,0.9)]
def cap_cards(t, d, cap):
    # long lines become consecutive cards of <=2 lines x 38 chars, sharing the time
    w = textwrap.wrap(cap, 38); cards = [w[i:i+2] for i in range(0, len(w), 2)]
    n = len(cards); return [(t+d*i/n, d/n, '\n'.join(c)) for i, c in enumerate(cards)]
clips = []
for i,(t,d,key,mv,cap) in enumerate(S):
    n = max(1,round(d*FPS)); out = f'{O}/s{i:02d}.mp4'
    k = KEYS[key]; img = f"{H}/stills/{k['file']}"
    cf = ''
    if 'crop' in k:
        x,y,w,h = k['crop']; cf = f"crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},"
    z = {'zin':f"zoom='1+0.10*on/{n}'",'zout':f"zoom='1.10-0.10*on/{n}'",'pan':"zoom=1.12",'shake':f"zoom='1.12+0.10*on/{n}'"}[mv]
    xp = {"pan":f"x='(iw-iw/zoom)*on/{n}'","shake":"x='iw/2-iw/zoom/2+14*sin(on*2.3)'"}.get(mv,"x='iw/2-iw/zoom/2'")
    yp = "y='ih/2-ih/zoom/2+10*sin(on*3.1)'" if mv=='shake' else "y='ih/2-ih/zoom/2'"
    vf = f"{cf}scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan={z}:{xp}:{yp}:d={n}:s=1920x1080:fps={FPS}"
    if key=='hook_land': vf += ",fade=t=in:st=0:d=0.1:color=white"
    if cap:
        # one caption per line group: lines >38 chars spread over the shot's following shots would be messy, so cards live inside this shot only
        for j,(ct,cd,txt) in enumerate(cap_cards(0, d, cap)):
            open(f'{O}/c{i:02d}_{j}.txt','w').write(txt)
            vf += (f",drawtext=textfile={O}/c{i:02d}_{j}.txt:fontfile={FONT}:fontsize=40:line_spacing=8:fontcolor=white:borderw=3:bordercolor=black:"
                   f"x=(w-text_w)/2:y=h-190:enable='between(t,{ct:.2f},{ct+cd:.2f})'")
    subprocess.run(['ffmpeg','-loglevel','error','-y','-i',img,'-vf',vf,'-frames:v',str(n),'-pix_fmt','yuv420p',out],check=True)
    clips.append(out)
card = f'{O}/card.mp4'
subprocess.run(['ffmpeg','-loglevel','error','-y','-f','lavfi','-i',f'color=c=black:s=1920x1080:r={FPS}:d=1.5','-vf',
 f"drawtext=text='DOSE OF DESTRUCTION':fontfile={FONT}:fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-20,"
 "drawtext=text='Made with Hawkes Gen · hawkesgen.com':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:fontsize=28:fontcolor=0xaaaaaa:x=(w-text_w)/2:y=h/2+70",'-pix_fmt','yuv420p',card],check=True)
clips.append(card)
open(f'{O}/list.txt','w').write(''.join(f"file '{os.path.abspath(c)}'\n" for c in clips))
subprocess.run(['ffmpeg','-loglevel','error','-y','-f','concat','-safe','0','-i',f'{O}/list.txt','-c','copy',f'{O}/video.mp4'],check=True)
total = END+1.5
ins=[]; fl=[]; labels=[]
def add(name, delay, vol, extra=''):
    kk=len(ins)//2; ins.extend(['-i',f'{H}/audio/{name}.mp3'])
    fl.append(f"[{kk}]{extra}adelay={int(delay*1000)}|{int(delay*1000)},volume={vol}[a{kk}]"); labels.append(f'[a{kk}]')
add('hum',0,0.35,'atrim=0:67.5,afade=t=out:st=65:d=2.5,')
add('drums',67.2,0.5,'atrim=0:9.5,afade=t=out:st=7.5:d=2,')
for v,t in VOICE: add(v,t,1.6)
for s,t,vol in SFX: add(s,t,vol,'atrim=0:3,')
fc = ';'.join(fl)+';'+''.join(labels)+f"amix=inputs={len(labels)}:normalize=0,atrim=0:{total},alimiter=limit=0.95[a]"
subprocess.run(['ffmpeg','-loglevel','error','-y']+ins+['-i',f'{O}/video.mp4','-filter_complex',fc,'-map','[a]','-map',f'{len(ins)//2}:v','-c:v','copy','-c:a','aac','-b:a','192k',f'{O}/cut.mp4'],check=True)
json.dump([dict(t=s[0],seconds=s[1],key=s[2],caption=s[4]) for s in S],open(f'{O}/timeline.json','w'),indent=1)
print('ok',total)
