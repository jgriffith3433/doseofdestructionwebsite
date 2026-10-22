#!/usr/bin/env python3
"""Assemble the Dead Air cut from kf/ stills, clips/ Gen clips and audio/ lines. Run from this folder."""
import subprocess, os, json
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
W,H,FPS=1920,1080,30
os.makedirs('out/seg',exist_ok=True)
def kf(n): 
    import glob
    p=[l.split()[1] for l in open('kf/PICKS.txt') if l.split()[0]==n][0]; return 'kf/'+p
def clip(d,pat='*Save_Video.mp4'):
    import glob; return sorted(glob.glob(f'clips/{d}/{pat if d[0]=="E" else "*.mp4"}'))[0]
LAND=f"scale={W}:{H}:flags=lanczos,fps={FPS},format=yuv420p,setsar=1"
def still_vf(d,kind):
    n=int(d*FPS); base="scale=2880:-1"
    if kind=='push': z=f"1+0.12*on/{n}"; xo=yo="0"
    elif kind=='pull': z=f"1.12-0.12*on/{n}"; xo=yo="0"
    elif kind=='hand': z="1.08"; xo="40*sin(on/5)"; yo="30*sin(on/7)"
    else: z="1.02"; xo=yo="0"
    return f"{base},zoompan=z='{z}':x='iw/2-(iw/zoom/2)+{xo}':y='ih/2-(ih/zoom/2)+{yo}':d=1:s={W}x{H}:fps={FPS},format=yuv420p,setsar=1"
segs=[]  # (name,video_args,vf,dur,audio_file or None, extra_vf)
def S(name,src,dur,vf,audio=None,fixed=False,extra=""):
    segs.append(dict(name=name,src=src,dur=dur,vf=vf+extra,audio=audio,fixed=fixed))
def dur_of(f): return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',f]))
def clipseg(name,d,extra="",trim=None):
    f=clip(d); S(name,f,trim or dur_of(f),LAND,fixed=True,extra=extra)
def stillseg(name,k,dur,kind,audio=None,extra=""):
    S(name,kf(k),dur,still_vf(dur,kind),audio=audio,extra=extra)
A=lambda x:f'audio/{x}.mp3'
# CRT gags on the Bot's flat-line screen: black patch over the line, then cyan marks drawn on it (screen interior only)
def crt(blank,*marks):
    f=",drawbox=x=740:y=535:w=470:h=64:color=0x050708:t=fill:enable='between(t,%s,%s)'"%blank
    for (x,y,w,h,a,b) in marks: f+=",drawbox=x=%d:y=%d:w=%d:h=%d:color=0x19e6ff:t=fill:enable='between(t,%s,%s)'"%(x,y,w,h,a,b)
    return f
clipseg('s01_hook','E1a',extra=",fade=t=in:st=0:d=0.3,eq=brightness='0.05*sin(t*40)*exp(-t*1.5)':eval=frame")
stillseg('s02_botflat','k19_bot_flat'.split('_')[0] if False else 'botflat',1.6,'push')
stillseg('s03_count','pace1',dur_of(A('E2a'))+0.3,'hand',audio=A('E2a'))
clipseg('s04_dry','E2b')
stillseg('s04b_botblink','botflat',1.0,'static',extra=crt((0.3,0.7),(950,562,22,22,0.3,0.7)))   # the Bot blinks. once. that's the review
stillseg('s05_nolaugh','wait',1.7,'push')
stillseg('s06_do_you_like','pace2',dur_of(A('E3a'))+0.4,'hand',audio=A('E3a'))
clipseg('s07_waiting','E3b')
clipseg('s08_bucket','E3c')
stillseg('s09_bucketicon_a','botflat',0.5,'push')
stillseg('s09_bucketicon_b','botbucket',1.2,'push')
stillseg('s10_joke','hopeful',dur_of(A('E4'))+0.7,'push',audio=A('E4'))
dots=[(820+i*110,565,26,26,0.35+0.4*i,1.9) for i in range(3)]
stillseg('s10b_typing','botflat',2.0,'static',extra=crt((0.3,1.9),*dots))   # three dots: it starts to answer, then deletes it

clipseg('s11_slide','slide')
stillseg('s12_silence','sit',8.0,'push',extra=",eq=brightness='0.07*sin(2*PI*t*0.7)-0.03':eval=frame")
clipseg('s13_eyes','eyes')
stillseg('s14_reveal','twoshot',3.0,'pull')
clipseg('s15_humming','E5')
stillseg('s16_fine1','botflat',dur_of(A('B1a'))+0.4,'push',audio=A('B1a'))
clipseg('s17_okay','E6')
stillseg('s18_together','sidebyside',3.6,'push')
stillseg('s19_smile','botsmile',1.6,'push')
clipseg('s20_doors','doors')
clipseg('s21_hand','bothelp')
clipseg('s22_lose','E7')
stillseg('s23_fine2','botback',dur_of(A('B1b'))+0.5,'push',audio=A('B1b'))
stillseg('s24_grin','grinecu',1.3,'push')
# ---- render segments
starts={}; t=0; lst=[]
for s in segs:
    out=f"out/seg/{s['name']}.mp4"; d=s['dur']
    cmd=['ffmpeg','-y','-loglevel','error']
    if s['fixed']: cmd+=['-i',s['src']]
    else: cmd+=['-loop','1','-framerate',str(FPS),'-t',f'{d:.3f}','-i',s['src']]
    if s['audio']: cmd+=['-i',s['audio']]
    cmd+=['-vf',s['vf']]
    if s['fixed']: cmd+=['-af','aresample=48000,apad,atrim=0:%.3f'%d,'-map','0:v','-map','0:a?']
    elif s['audio']: cmd+=['-af','aresample=48000,apad,atrim=0:%.3f'%d,'-map','0:v','-map','1:a']
    else: cmd+=['-f','lavfi','-t',f'{d:.3f}','-i','anullsrc=r=48000:cl=stereo','-map','0:v','-map','2:a' if False else '1:a']
    cmd+=['-t',f'{d:.3f}','-r',str(FPS),'-c:v','libx264','-crf','17','-preset','fast','-c:a','aac','-ar','48000','-ac','2',out]
    if not s['fixed'] and not s['audio']:
        cmd=['ffmpeg','-y','-loglevel','error','-loop','1','-framerate',str(FPS),'-t',f'{d:.3f}','-i',s['src'],'-f','lavfi','-t',f'{d:.3f}','-i','anullsrc=r=48000:cl=stereo','-vf',s['vf'],'-map','0:v','-map','1:a','-t',f'{d:.3f}','-r',str(FPS),'-c:v','libx264','-crf','17','-preset','fast','-c:a','aac','-ar','48000','-ac','2',out]
    subprocess.check_call(cmd)
    starts[s['name']]=t; t+=d; lst.append(out)
# end card (hard cut)
card="out/seg/s25_card.mp4"
subprocess.check_call(['ffmpeg','-y','-loglevel','error','-f','lavfi','-t','1.5','-i',f'color=c=black:s={W}x{H}:r={FPS}','-f','lavfi','-t','1.5','-i','anullsrc=r=48000:cl=stereo','-vf',
 f"drawtext=fontfile={FONT}:text='DOSE OF DESTRUCTION':fontcolor=0xe8c9a0:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2-30,drawtext=fontfile={FONT}:text='Made with Hawkes Gen · hawkesgen.com':fontcolor=0x9a9a9a:fontsize=34:x=(w-text_w)/2:y=(h/2)+80,format=yuv420p",
 '-c:v','libx264','-crf','17','-c:a','aac','-ar','48000','-ac','2','-shortest',card])
starts['card']=t; total=t+1.5; lst.append(card)
open('out/list.txt','w').write(''.join(f"file '{os.path.abspath(p)}'\n" for p in lst))
subprocess.check_call(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i','out/list.txt','-c','copy','out/dialog.mp4'])
# ---- sound bed: room tone, hum, SFX (all synthetic), mixed under the voices
st=starts
hum_on=st['s13_eyes']+0.8; hum_end=st['s19_smile']+1.6
def sfx(expr,dur,at,vol,flt=""):
    return (expr,dur,at,vol,flt)
inputs=[]; filt=[]; labels=[]
def add(src,at,vol,flt=""):
    i=len(inputs)//4; inputs.extend(['-f','lavfi','-i',src]); 
    ms=int(at*1000); filt.append(f"[{i+1}:a]{flt+',' if flt else ''}volume={vol},adelay={ms}|{ms}[b{i}]"); labels.append(f"[b{i}]")
add(f"anoisesrc=d={total:.2f}:c=brown:r=48000:a=0.5",0,0.18,"lowpass=f=300")                         # room tone
# red lamp buzz
add(f"sine=f=120:d={total:.2f}:r=48000",0,0.015)
# hum: off-key hold-music tune (lo-fi)
tune="aevalsrc='0.5*sin(2*PI*(220+30*mod(floor(t*2.2),5)*7)*t)*(0.6+0.4*sin(2*PI*5*t))':d=%.2f:s=48000"%(hum_end-hum_on)
add(tune,hum_on,0.05,"lowpass=f=1500,afade=t=in:d=1.2")
# Exit Punk joining the hum (flat and wrong), from the 'together' shot
add("aevalsrc='0.5*sin(2*PI*(233+20*mod(floor(t*2.2),5)*7)*t)':d=%.2f:s=48000"%(hum_end-st['s18_together']),st['s18_together']+0.4,0.045,"lowpass=f=1200")
# SFX
def ding(at,vol=0.2): add("aevalsrc='sin(2*PI*1318*t)*exp(-t*5)':d=1.2:s=48000",at,vol)
ding(st['s03_count']+3.45)                                    # floor chime, while not moving
add("sine=f=700:d=0.08:r=48000",st['s04b_botblink']+0.3,0.12); add("sine=f=700:d=0.08:r=48000",st['s04b_botblink']+0.7,0.12)
for i in range(3): add("sine=f=%d:d=0.06:r=48000"%(600+60*i),st['s10b_typing']+0.35+0.4*i,0.1)
add("sine=f=400:d=0.25:r=48000",st['s10b_typing']+1.9,0.08,"afade=t=out:d=0.25")   # delete
add("anoisesrc=d=0.8:c=brown:r=48000:a=0.9",0.0,0.6,"lowpass=f=180,afade=t=out:d=0.8")                 # lurch/power-down thud
add("sine=f=700:d=0.08:r=48000",st['s09_bucketicon_a'],0.12)                                            # CRT blip
add("sine=f=900:d=0.08:r=48000",st['s19_smile'],0.12)
add("anoisesrc=d=0.4:c=white:r=48000:a=0.4",st['s11_slide']+1.2,0.25,"lowpass=f=900,afade=t=out:d=0.4") # slide squeak/thud
add("anoisesrc=d=3.5:c=pink:r=48000:a=0.8",st['s20_doors']+0.4,0.45,"highpass=f=300,lowpass=f=3500,afade=t=in:d=1.5,afade=t=out:d=1.2") # crowd roar
add("anoisesrc=d=0.6:c=brown:r=48000:a=0.9",st['s20_doors'],0.5,"lowpass=f=200,afade=t=out:d=0.6")        # jolt
add("sine=f=300:d=0.5:r=48000",st['s21_hand'],0.05,"tremolo=f=30:d=1")                                  # servo
add("anoisesrc=d=1.5:c=pink:r=48000:a=0.8",st['s23_fine2'],0.35,"highpass=f=300,lowpass=f=3500,afade=t=out:d=1.0")  # crowd under the last grin
fc=';'.join(filt)+';'+''.join(labels)+f"amix=inputs={len(labels)}:duration=longest:normalize=0[bed]"
subprocess.check_call(['ffmpeg','-y','-loglevel','error','-i','out/dialog.mp4']+inputs+['-filter_complex',fc+';[0:a][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]','-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-b:a','192k','-t',f'{total:.2f}','out/cut.mp4'])
# hard cut to black at end of grin is the cut to the card
subprocess.check_call(['ffmpeg','-y','-loglevel','error','-ss','2','-i','out/cut.mp4','-frames:v','1','out/poster.png'])
json.dump(dict(total=total,starts=starts),open('out/timeline.json','w'),indent=1)
print('total',total)
