#!/usr/bin/env python3
"""Cut The Board v5 animatic: held on-model stills with moves, real voices, captions (<=38 chars/card, 2 lines).
Usage: build_v5.py <out dir>   (reads stills/, audio/, keys.json: shot name -> still file, optional crop)"""
import subprocess, sys, os, json, textwrap
H = os.path.dirname(os.path.abspath(__file__)); O = sys.argv[1]; os.makedirs(O, exist_ok=True)
FPS = 24
KEYS = json.load(open(f'{H}/keys.json'))
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
# (start, dur, key, move, caption) ; moves: zin zout pan shake
T = [(1.2, 'hook_launch', 'shake', '', None, 0), (1.0, 'hook_face', 'shake', '', None, 0), (1.0, 'hook_land', 'zin', '', None, 0), (1.6, 'creeper2', 'zin', '', None, 0), (1.0, 'watch', 'zin', '', None, 0), (1.7, 'sit_up', 'zin', "MECHANIC: You're late.", 'M1', 1), (2.3, 'ep_defensive_1', 'zin', "EXIT PUNK: I'm eleven seconds late.", 'E1', 0), (1.5, 'watch', 'zin', 'MECHANIC: I counted.', 'M10', 0), (3.1, 'ots_mech2', 'zin', 'MECHANIC: Eleven seconds is how a furnace goes out.', 'M2', 0), (1.4, 'ep_sheepish_0', 'zin', "EXIT PUNK: It's a bolt.", 'E2', 0), (1.5, 'mech_stern_1', 'zin', "MECHANIC: It's THE bolt.", 'M3', 0), (2.0, 'board_snapped_1', 'zin', "That deck's snapped.", None, 1), (1.9, 'ep_smirk_0', 'zin', "EXIT PUNK: It's fine. It's held together by optimism.", 'E3', 0), (1.4, 'mech_stern_0', 'zin', '', None, 0), (2.1, 'mech_soft_1', 'zin', "MECHANIC: It's held together by me. Third time this month.", 'M4', 0), (1.2, 'ep_defensive_0', 'zin', 'Sit.', None, 0), (1.2, 'wrench', 'zin', '', None, 0), (1.8, 'weld', 'zin', '', None, 0), (1.6, 'ep_watching_0', 'zin', "EXIT PUNK: I'm not watching.", 'E10', 0), (1.6, 'file', 'pan', '', None, 0), (1.5, 'wheel_0', 'zin', '', None, 0), (1.7, 'ep_watching_1', 'zin', 'MECHANIC: Nobody asked.', 'M11', 0), (2.4, 'two_high', 'zin', 'MECHANIC: You know why you keep breaking it?', 'M5', 1), (2.2, 'ep_smirk_1', 'zin', "EXIT PUNK: I'm bad at stopping.", 'E4', 0), (2.8, 'mech_soft_0', 'zout', "MECHANIC: You never ride it anywhere you're allowed.", 'M6', 0), (1.6, 'ep_hurt_1', 'zin', "EXIT PUNK: Nowhere I'm allowed to ride has an exit.", 'E5', 0), (1.3, 'ep_eyes', 'zin', '', None, 0), (1.8, 'mech_stops', 'zin', '', None, 0), (1.5, 'ots_mech3', 'zin', "MECHANIC: There's a window upstairs.", 'M7', 0), (1.5, 'tv_glow', 'zin', 'Gets the broadcast.', None, 1), (3.0, 'mech_grave_0', 'zin', 'Whole city watching the floor at midnight.', None, 0), (2.0, 'mech_grave_1', 'zin', "People who walk onto that stage don't come back the same.", None, 0), (2.1, 'ep_hurt_0', 'zin', 'Or at all.', None, 0), (1.9, 'ep_hopeful_1', 'zin', 'EXIT PUNK: Sounds like a way out.', 'E6', 0), (1.6, 'mech_stern_0', 'zin', "MECHANIC: It's a way in.", 'M8', 0), (2.4, 'handoff2', 'zin', 'New rule. Wheels down.', None, 1), (1.8, 'handoff_0', 'zin', 'Whatever you land on, wheels down.', None, 1), (1.4, 'ep_hopeful_0', 'zin', "EXIT PUNK: That's the rule?", 'E7', 0), (2.0, 'mech_soft_0c', 'zin', 'MECHANIC: Only one I ever kept.', 'M9', 0), (2.2, 'mech_stern_1c', 'zin', 'And bring the bolt back.', None, 0), (1.3, 'ep_defensive_0', 'zin', 'EXIT PUNK: Which bolt?', 'E11', 0), (1.6, 'mech_stern_1', 'zin', 'MECHANIC: THE bolt.', 'M12', 0), (1.8, 'ride_wide', 'pan', '', 'RIDE', 0), (1.2, 'ride_wheels', 'shake', '', None, 0), (1.6, 'ride_front', 'zin', '', None, 0), (1.4, 'ride_0', 'pan', '', None, 0), (1.4, 'ride_1', 'zin', '', None, 0), (2.2, 'grate_face', 'zin', 'ANNOUNCER: Tonight, a walk-on.', 'ANN', 0), (1.8, 'ep_resolve_1', 'zin', 'EXIT PUNK: Wheels down.', 'E8', 0), (1.2, 'drop_1', 'zin', '', None, 0), (0.6, 'drop_0', 'zout', '', None, 0), (2.4, 'BLACK', 'zin', 'EXIT PUNK: ...Mostly.', 'E12', 0)]
S=[];VOICE=[];t=0.0;RIDE=0
for d,key,mv,cap,v,top in T:
    S.append((round(t,2),d,key,mv,cap,top))
    if v=='RIDE': RIDE=t
    elif v: VOICE.append((v,round(t+0.1,2)))
    t+=d
END = t
SFX = [('sfx_land',0.9,1.0),('sfx_creeper',3.0,0.6),('sfx_weld',S[16][0],0.8),('sfx_file',S[18][0],0.8),('sfx_wheel',S[19][0],0.8),('sfx_crowd',S[-5][0]-0.4,0.5),('sfx_land',S[-3][0]+0.3,0.9),('sfx_wheel',RIDE+1.8,0.9),('sfx_crash',S[-1][0]-0.05,1.0)]
def cap_cards(t, d, cap):
    # long lines become consecutive cards of <=2 lines x 38 chars, sharing the time
    w = textwrap.wrap(cap, 38); cards = [w[i:i+2] for i in range(0, len(w), 2)]
    n = len(cards); return [(t+d*i/n, d/n, '\n'.join(c)) for i, c in enumerate(cards)]
clips = []
for i,(t,d,key,mv,cap,top) in enumerate(S):
    n = max(1,round(d*FPS)); out = f'{O}/s{i:02d}.mp4'
    if key=='BLACK':
        img = f'{O}/black.png'; subprocess.run(['ffmpeg','-loglevel','error','-y','-f','lavfi','-i','color=c=black:s=1920x1080','-frames:v','1',img],check=True); k={}
    else:
        k = KEYS[key]; img = f"{H}/stills/{k['file']}"
    cf = ''
    if 'crop' in k:
        x,y,w,h = k['crop']; cf = f"crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},"
    z = {'zin':f"zoom='1+0.10*on/{n}'",'zout':f"zoom='1.10-0.10*on/{n}'",'pan':"zoom=1.12",'shake':f"zoom='1.12+0.10*on/{n}'"}[mv]
    xp = {"pan":f"x='(iw-iw/zoom)*on/{n}'","shake":"x='iw/2-iw/zoom/2+14*sin(on*2.3)'"}.get(mv,"x='iw/2-iw/zoom/2'")
    yp = "y='ih/2-ih/zoom/2+10*sin(on*3.1)'" if mv=='shake' else "y='ih/2-ih/zoom/2'"
    vf = f"{cf}scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,zoompan={z}:{xp}:{yp}:d={n}:s=1920x1080:fps={FPS}"
    if key=='hook_launch': vf += ",fade=t=in:st=0:d=0.1:color=white"
    if cap:
        # one caption per line group: lines >38 chars spread over the shot's following shots would be messy, so cards live inside this shot only
        for j,(ct,cd,txt) in enumerate(cap_cards(0, d, cap)):
            open(f'{O}/c{i:02d}_{j}.txt','w').write(txt)
            vf += (f",drawtext=textfile={O}/c{i:02d}_{j}.txt:fontfile={FONT}:fontsize=40:line_spacing=8:fontcolor=white:borderw=3:bordercolor=black:"
                   f"x=(w-text_w)/2:y={'110' if top else 'h-190'}:enable='between(t,{ct:.2f},{ct+cd:.2f})'")
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
add('hum',0,0.35,f'atrim=0:{RIDE+0.5},afade=t=out:st={RIDE-2}:d=2.5,')
add('drums',RIDE,0.5,f'atrim=0:{END-RIDE},afade=t=out:st={END-RIDE-2}:d=2,')
for v,t in VOICE: add(v,t,1.6)
for s,t,vol in SFX: add(s,t,vol,'atrim=0:3,')
fc = ';'.join(fl)+';'+''.join(labels)+f"amix=inputs={len(labels)}:normalize=0,atrim=0:{total},alimiter=limit=0.95[a]"
subprocess.run(['ffmpeg','-loglevel','error','-y']+ins+['-i',f'{O}/video.mp4','-filter_complex',fc,'-map','[a]','-map',f'{len(ins)//2}:v','-c:v','copy','-c:a','aac','-b:a','192k',f'{O}/cut.mp4'],check=True)
json.dump([dict(t=s[0],seconds=s[1],key=s[2],caption=s[4]) for s in S],open(f'{O}/timeline.json','w'),indent=1)
print('ok',total)
