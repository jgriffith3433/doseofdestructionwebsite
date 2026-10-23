#!/bin/bash
# v2 cut, all local ffmpeg from Gen outputs + DoD clips. Usage: build_v2.sh <repo> <gendir> <outdir>
R=$1; G=$2; O=$3; mkdir -p $O; A=/srv/hawkes/AllTheCharacters
K="colorkey=0x00FF00:0.32:0.1,despill=green"; FY=1330
EPI=$A/ExitPunk/anims/idle.mp4; SBI=$A/ShutupBot/anims/idle.mp4; FAIR=$A/ExitPunk/anims/fair.mp4
SKATE=$G/skate/video-i2v-41.mp4; T1=$G/t1/video-talk-61-Save_Video.mp4; T2=$G/t2/video-talk-62-Save_Video.mp4
SB=$G/sb/image-edit-31.png
ENC="-r 24 -c:v libx264 -crf 22 -pix_fmt yuv420p -an"
# plate: darkened city-top
ffmpeg -v error -y -i $R/stages/city-top/backdrop.webp -i $R/stages/city-top/wide/stage-art.webp -filter_complex "[0]scale=-2:1920,crop=1080:1920:1100:0,eq=brightness=-0.2[bg];[1]scale=1900:-1[art];[bg][art]overlay=(W-w)/2+120:$FY-324,vignette=PI/4" -frames:v 1 $O/plate.png
# sparks layer: SPARK <out> <dur> <cx> <cy> <r> <t0>   (random specks around a point, orange)
spark(){ ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=$2" -vf "geq=lum='if(gt(random(1)*(1+0.0*X),0.9975+0.0025*min(1,hypot(X-$3,Y-$4)/$5)),255,0)*gte(T,$6)*lt(T,$6+0.5)':cb=128:cr=128,dilation,dilation,gblur=sigma=1.5,format=gbrp,colorchannelmixer=rr=1:gg=0.6:bb=0.15" $ENC $O/$7.mp4; }
# S1 WS low follow: skate-in
ffmpeg -v error -y -loop 1 -i $O/plate.png -i $SKATE -filter_complex "
 [1:v]trim=0.7:2.5,setpts=PTS-STARTPTS,fps=24,$K,scale=1500:-2[s];
 [0:v]fps=24,trim=0:1.8,scale=1500:2667,crop=1080:1920:'210+60*t':380[bg];
 [bg][s]overlay=x='-380+330*t':y=600:shortest=1[v];
 [v]drawbox=x='mod(t*3000,1400)-300':y=1440:w=260:h=3:c=white@0.6:t=fill,drawbox=x='mod(t*2300+500,1400)-300':y=1500:w=200:h=3:c=white@0.5:t=fill,drawbox=x='mod(t*2700+900,1400)-300':y=1390:w=160:h=2:c=white@0.5:t=fill,vignette=PI/5[v2]" -map "[v2]" -t 1.8 $ENC $O/s01.mp4
# SB face builder: FACE <seg> <dur> <zoom0> <zoom1> <cx> <cy> <eyes-expr-enable...> uses drawbox on the 550x520 screen layer
# face(t) pieces: eyes bar(x,y,w,h), lid bar above, mouth bar
face(){ # $1 out $2 dur $3 z0 $4 z1 $5 cx(offset expr) $6 cy $7 eyefilter $8 extra post filter
 ffmpeg -v error -y -loop 1 -i $SB -f lavfi -i "color=0x03080b:s=560x530:r=24,format=rgb24" -filter_complex "
 [1:v]format=rgb24,drawgrid=w=0:h=5:t=1:c=0x00e5ff@0.06,$7,split[f0][f1];[f1]gblur=sigma=14[g];[f0][g]blend=all_mode=screen,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip((70-hypot(max(0,abs(X-W/2)-(W/2-70)),max(0,abs(Y-H/2)-(H/2-70))))/10,0,1)'[face];
 [0:v]fps=24,format=yuv444p${9:+,$9},format=rgb24,null[b];[b][face]overlay=235:230:shortest=1:format=auto,format=rgb24[h];
 [h]scale=w='1080*($3+($4-$3)*t/$2)':h=-2:eval=frame,pad=w='max(iw,1080)':h='max(ih,1920)':x=0:y='(max(ih,1920)-ih)/2':color=0x050608,crop=1080:1920:'(iw-1080)/2+$5':'($6)*0+(ih-1920)/2'${8:+,$8}[o]" -map "[o]" -t $2 $ENC $O/$1.mp4; }
EYES='drawbox=x=75:y=150:w=130:h=26:c=0x7ff6ff:t=fill,drawbox=x=345:y=150:w=130:h=26:c=0x7ff6ff:t=fill,drawbox=x=75:y=138:w=130:h=12:c=0x7ff6ff:t=fill,drawbox=x=345:y=138:w=130:h=12:c=0x7ff6ff:t=fill'
MOUTH='drawbox=x=185:y=330:w=180:h=12:c=0x7ff6ff:t=fill'

E(){ echo "drawbox=x=75:y=150:w=130:h=26:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=345:y=150:w=130:h=26:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=75:y=138:w=130:h=${2:-12}:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=345:y=138:w=130:h=${2:-12}:c=0x7ff6ff:t=fill:enable='$1'"; }   # eyes with half-lid
DASH(){ echo "drawbox=x=75:y=160:w=130:h=7:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=345:y=160:w=130:h=7:c=0x7ff6ff:t=fill:enable='$1'"; }
M(){ echo "drawbox=x=185:y=330:w=180:h=12:c=0x7ff6ff:t=fill:enable='$1'"; }
MS(){ echo "drawbox=x=185:y=318:w=180:h=36:c=0x7ff6ff:t=fill:enable='$1'"; }   # mouth open (speaking pulse)
# S2 ECU push-in: screen powers on
face s02 1.6 1.6 1.95 0 0 "$(E 'gte(t,0.5)'),$(M 'gte(t,0.6)')" "noise=alls=8:allf=t,eq=brightness='-0.2*lt(t,0.5)'"
# S5 MCU: "Please stop talking." speaks 0.2-2.1; slow stepped servo head-turn (stutter)
face s05 2.3 1.15 1.3 '-34*floor(t*3.2)/7' 0 "$(E 'lt(t,1.0)'),$(E 'gte(t,1.0)' 22),$(M 'lt(t,0.2)+gt(t,2.1)'),$(M 'between(t,0.2,2.1)*gt(mod(t,0.34),0.14)'),$(MS 'between(t,0.2,2.1)*lt(mod(t,0.34),0.14)')" "noise=alls=6:allf=t"
# S6b + S7 reaction: eyes drop to dashes
face s06b 0.8 1.7 1.95 0 0 "$(E 'lt(t,0.3)'),$(DASH 'gte(t,0.3)'),$(M 'lt(t,0.3)')" "rgbashift=rh=12:bh=-12:enable='between(t,0.28,0.36)'"
face s07 1.2 1.6 1.9 0 0 "$(DASH 'lt(t,0.7)'),$(E 'gte(t,0.7)'),$(M 'gt(t,0)')" "rgbashift=rh=14:bh=-14:enable='between(t,0.02,0.1)+between(t,0.66,0.72)'"
# S8 "...Yes." ECU
face s08 0.9 1.9 2.0 0 0 "$(E 'gt(t,0)'),$(M 'lt(t,0.1)+gt(t,0.8)'),$(MS 'between(t,0.1,0.8)')" "noise=alls=6:allf=t"
# S10 "Ow." dented head, tear, handheld, sparks
DENT="geq=lum='if(lt(hypot(X-165,Y-600),140),lum(X,Y)*(0.3+0.7*hypot(X-165,Y-600)/140),lum(X,Y))':cb='cb(X,Y)':cr='cr(X,Y)'"
face s10a 1.8 1.3 1.25 0 0 "$(DASH 'lt(t,0.5)'),$(E 'gte(t,0.5)' 22),$(M 'lt(t,0.3)+gt(t,1.35)'),$(MS 'between(t,0.3,1.35)*gt(mod(t,0.3),0.12)'),$(M 'between(t,0.3,1.35)*lt(mod(t,0.3),0.12)')" "rgbashift=rh=22:bh=-22:enable='between(t,0,0.12)',noise=alls=10:allf=t,crop=1080:1920:'sin(t*47)*10':'cos(t*39)*10'" "$DENT"
# sparks over the dent (head coords scaled: ~ (480,760) in the frame)
ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=1.8" -vf "geq=lum='if(gt(random(1),0.9985+0.0014*min(1,hypot(X-300,Y-640)/300)),255,0)*lt(T,0.9)':cb=128:cr=128,dilation,dilation,gblur=sigma=1.2,format=rgb24,lutrgb=g='val*0.62':b='val*0.15'" $ENC $O/sp10.mp4
ffmpeg -v error -y -i $O/s10a.mp4 -i $O/sp10.mp4 -filter_complex "[0]format=gbrp[a];[1]format=gbrp[b];[a][b]blend=all_mode=screen,format=yuv420p" $ENC $O/s10.mp4
# end card
ffmpeg -v error -y -f lavfi -i "color=c=0x0b0b0e:s=1080x1920:r=24:d=1.5,format=yuv420p,drawtext=text='DOSE OF DESTRUCTION':fontcolor=0xe8c9a0:fontsize=84:x=(w-text_w)/2:y=(h-text_h)/2-30,drawtext=text='Made with Hawkes Gen · hawkesgen.com':fontcolor=0x9a9a9a:fontsize=34:x=(w-text_w)/2:y=(h/2)+80,fade=t=in:st=0:d=0.2" $ENC $O/s12.mp4

# ---- wide shots on the stage plate ----
# wide <out> <dur> <epclip filter> ... done inline below
# S3 WS pan: Exit Punk stops, Shutup Bot stands (3.4-5.2)
ffmpeg -v error -y -loop 1 -i $O/plate.png -stream_loop -1 -i $EPI -stream_loop -1 -i $SBI -filter_complex "
 [1:v]fps=24,$K,scale=980:980,setpts=PTS-STARTPTS[ep];[2:v]fps=24,$K,scale=980:980,hflip,setpts=PTS-STARTPTS[sb];
 [0:v][sb]overlay=330:534:shortest=1[a];[a][ep]overlay=-60:534:shortest=1,scale=1400:2489,crop=1080:1920:'t/1.8*320':'300'[v]
 ;[v]drawbox=x=0:y=0:w=1080:h=1920:c=white@0.0:t=fill,eq=1" -t 1.8 $ENC $O/s03.mp4 2>&1 | tail -2
# S9 MS whip-pan hit: fair clip sped up, flash, shake, sparks (15.6-16.6)
ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=1.0" -vf "geq=lum='if(gt(random(1),0.9985+0.0014*min(1,hypot(X-760,Y-800)/260)),255,0)*gte(T,0.55)*lt(T,0.95)':cb=128:cr=128,dilation,dilation,gblur=sigma=1.4,format=rgb24,lutrgb=g='val*0.62':b='val*0.15'" $ENC $O/sp09.mp4
ffmpeg -v error -y -loop 1 -i $O/plate.png -stream_loop -1 -i $FAIR -stream_loop -1 -i $SBI -i $O/sp09.mp4 -filter_complex "
 [1:v]fps=24,$K,scale=980:980,setpts=(PTS-STARTPTS)/2.2[ep];[2:v]fps=24,$K,scale=980:980,hflip,setpts=PTS-STARTPTS[sb];
 [0:v][sb]overlay=330:534:shortest=1[a];[a][ep]overlay=20:534:shortest=1,format=rgb24[w];
 [3:v]format=gbrp[sp];[w]format=gbrp[w1];[w1][sp]blend=all_mode=screen[w2];
 [w2]drawbox=x=0:y=0:w=1080:h=1920:c=white@0.9:t=fill:enable='between(t,0.55,0.62)',scale=1450:2578,crop=1080:1920:'(360)+(400*max(0,0.25-t)/0.25)+28*sin(t*80)*exp(-(t-0.55)*9)*gte(t,0.55)':'380+22*cos(t*70)*exp(-(t-0.55)*9)*gte(t,0.55)',boxblur=lr=22:lp=0:enable='lt(t,0.2)',format=yuv420p[v]" -map "[v]" -t 1.0 $ENC $O/s09.mp4 2>&1 | tail -2
# S11 crane-up sign-off with smoke from the dented head (18.4-20.1)
ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=1.7" -vf "geq=lum='if(gt(random(1),0.985+0.01*min(1,hypot(X-830,Y-(900-T*140))/200)),170,0)':cb=128:cr=128,gblur=sigma=14,eq=contrast=1.8,format=rgb24" $ENC $O/sm11.mp4
ffmpeg -v error -y -loop 1 -i $O/plate.png -stream_loop -1 -i $EPI -stream_loop -1 -i $SBI -i $O/sm11.mp4 -filter_complex "
 [1:v]fps=24,$K,scale=980:980,setpts=PTS-STARTPTS[ep];[2:v]fps=24,$K,scale=980:980,hflip,setpts=PTS-STARTPTS[sb];
 [0:v][sb]overlay=330:534:shortest=1[a];[a][ep]overlay='-60-90*t':534:shortest=1,format=rgb24[w];[3:v]format=gbrp[sm];[w]format=gbrp[w1];[w1][sm]blend=all_mode=screen:all_opacity=0.5,scale=1300:2311,crop=1080:1920:110:'400-t/1.7*400',format=yuv420p[v]" -map "[v]" -t 1.7 $ENC $O/s11.mp4 2>&1 | tail -2
# ---- Exit Punk talking shots (video.talk outputs), slow push-ins ----
talk(){ ffmpeg -v error -y -i $1 -vf "trim=$2:$3,setpts=PTS-STARTPTS,fps=24,scale=w='1108*(1+$5*t/$4)':h=-2:eval=frame,crop=1080:1920,unsharp=5:5:0.8,vignette=PI/5,format=yuv420p" -t $4 $ENC $O/$6.mp4; }
talk $T1 0 2.6 2.6 0.12 s04
talk $T2 0 1.9 1.9 0.10 s06a
talk $T2 2.7 3.4 0.7 0.05 s06c
# ---- sound: voices from Gen, SFX synthesized here ----
V=$G/v; ANN1=$V/audio-voice-a_ee14e0ea1048b835.mp3; EP1=$V/audio-voice-a_d7241779a202bd0a.mp3; SB1=$V/audio-voice-a_0601a01c5194a3ad.mp3
EP2=$V/audio-voice-a_f9dca3af28f29716.mp3; SB2=$V/audio-voice-a_bb7b038627870c98.mp3; SB3=$V/audio-voice-a_ffac42b53eb8d1a9.mp3; ANN2=$V/audio-voice-a_9bbfe98221105268.mp3
cat > $O/list.txt <<L
file s01.mp4
file s02.mp4
file s03.mp4
file s04.mp4
file s05.mp4
file s06a.mp4
file s06b.mp4
file s06c.mp4
file s07.mp4
file s08.mp4
file s09.mp4
file s10.mp4
file s11.mp4
file s12.mp4
L
ffmpeg -v error -y -f concat -i $O/list.txt -c copy $O/picture.mp4
CAP="fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1380"
C=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions
dt(){ echo "drawtext=textfile=$C/$1.txt:enable='between(t,$2,$3)':$CAP"; }
ffmpeg -v error -y -i $O/picture.mp4 -vf "$(dt 0 0.2 5.0),$(dt 1 5.2 7.8),$(dt 2 8.0 10.1),$(dt 3 10.1 13.5),$(dt 4 14.7 15.5),$(dt 5 16.9 17.9),$(dt 6 18.5 20.1)" $ENC $O/picture_c.mp4
# SFX
sfx(){ ffmpeg -v error -y -f lavfi -i "$2" -af "$3" -t $4 $O/$1.wav; }
sfx rumble "anoisesrc=c=brown:a=0.5:d=1.9" "lowpass=f=300,afade=t=out:st=1.4:d=0.5" 1.9
sfx clack "anoisesrc=c=white:a=0.9:d=0.12" "bandpass=f=2200:w=1800,afade=t=out:st=0.03:d=0.09" 0.12
sfx servo "sine=f=420:d=2.0" "tremolo=f=22:d=0.5,afade=t=in:st=0:d=0.3,afade=t=out:st=1.5:d=0.5,volume=0.12" 2.0
sfx hum "sine=f=110:d=1.6" "tremolo=f=50:d=0.3,volume=0.25" 1.6
sfx click "anoisesrc=c=white:a=0.9:d=0.05" "highpass=f=1500,afade=t=out:st=0.01:d=0.04" 0.05
sfx whoosh "anoisesrc=c=pink:a=0.8:d=0.4" "bandpass=f=900:w=1500,afade=t=in:st=0:d=0.3,afade=t=out:st=0.3:d=0.1" 0.4
sfx whack "sine=f=170:d=0.5" "afade=t=out:st=0.05:d=0.45,volume=1.2" 0.5
sfx clang "sine=f=1250:d=0.9" "tremolo=f=9:d=0.4,afade=t=out:st=0.05:d=0.85,volume=0.35" 0.9
sfx fizz "anoisesrc=c=white:a=0.5:d=1.0" "highpass=f=4500,tremolo=f=30:d=0.8,afade=t=out:st=0.4:d=0.6,volume=0.5" 1.0
sfx bed "sine=f=55:d=21.6" "tremolo=f=2:d=0.4,volume=0.28,afade=t=in:st=0:d=1,afade=t=out:st=20.5:d=1" 21.6
sfx sting "anoisesrc=c=pink:a=0.7:d=1.4" "lowpass=f=1200,afade=t=in:st=0:d=0.3,afade=t=out:st=0.5:d=0.9,volume=0.6" 1.4
IN=(); F=""; i=0
add(){ IN+=(-i "$1"); F+="[$i:a]adelay=$(( $(printf '%.0f' $(echo "$2*1000"|bc -l)) ))|$(( $(printf '%.0f' $(echo "$2*1000"|bc -l)) )),volume=$3[a$i];"; i=$((i+1)); }
add $ANN1 0.0 1.0; add $EP1 5.2 1.0; add $SB1 8.0 1.0; add $EP2 10.1 1.0; add $SB2 14.75 1.0; add $SB3 16.95 1.0; add $ANN2 18.5 1.0
add $O/rumble.wav 0.0 0.5; add $O/clack.wav 3.45 0.7; add $O/hum.wav 1.8 0.5; add $O/servo.wav 8.0 1.0; add $O/click.wav 13.8 0.8; add $O/click.wav 14.4 0.6
add $O/whoosh.wav 15.5 0.8; add $O/whack.wav 16.15 1.0; add $O/clang.wav 16.17 1.0; add $O/fizz.wav 16.7 0.9; add $O/bed.wav 0 0.5; add $O/sting.wav 18.4 0.6; add $O/click.wav 12.0 0.5
N=$i; M=$(for ((k=0;k<N;k++)); do printf "[a$k]"; done)
ffmpeg -v error -y "${IN[@]/#-i/-i}" -filter_complex "${F}${M}amix=inputs=$N:normalize=0,alimiter=limit=0.95,atrim=0:21.6[aud]" -map "[aud]" $O/audio.wav
ffmpeg -v error -y -i $O/picture_c.mp4 -i $O/audio.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart $O/cut.mp4
ffmpeg -v error -y -ss 5.6 -i $O/cut.mp4 -frames:v 1 $O/poster.png
