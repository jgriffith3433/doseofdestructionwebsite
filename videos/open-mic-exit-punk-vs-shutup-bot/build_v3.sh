#!/bin/bash
# v3 cut. Needs build_v2.sh's shots in <out> first. Usage: build_v3.sh <repo> <gendir> <outdir>
R=$1; G=$2; O=$3; D=$R/videos/open-mic-exit-punk-vs-shutup-bot; ST=$D/stills
ENC="-r 24 -c:v libx264 -crf 20 -pix_fmt yuv420p -an"
SWING=$G/swing/video-i2v-576440299.mp4
# stills pushes: still <png> <out> <dur> <z0> <z1> <cy offset>
still(){ ffmpeg -v error -y -loop 1 -i $1 -vf "fps=24,scale=1080:1920:flags=lanczos,scale=w='1080*($4+($5-$4)*t/$3)':h=-2:eval=frame,crop=1080:1920,unsharp=5:5:0.6,vignette=PI/5,format=yuv420p" -t $3 $ENC $O/$2.mp4; }
still $ST/ep_smirk.png s13 0.9 1.0 1.12
still $ST/ep_satisfied.png s17 0.7 1.0 1.08
# swing: wind-up already done in the clip; use the swing itself, handheld shake
ffmpeg -v error -y -i $SWING -vf "trim=0.8:1.3,setpts=2*(PTS-STARTPTS),fps=24,scale=1110:1924:flags=lanczos,crop=1080:1920:'15+10*sin(t*37)':'2+8*cos(t*31)',unsharp=5:5:0.7,vignette=PI/5,format=yuv420p" -t 1.0 $ENC $O/s14.mp4
# impact ECU: flash, 3-frame negative freeze, then shake + sparks
ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=0.7" -vf "geq=lum='if(gt(random(1),0.9975+0.0020*min(1,hypot(X-620,Y-900)/400)),255,0)*gte(T,0.12)*lt(T,0.6)':cb=128:cr=128,dilation,dilation,gblur=sigma=1.3,format=rgb24,lutrgb=g='val*0.62':b='val*0.15'" $ENC $O/sp15.mp4
ffmpeg -v error -y -loop 1 -i $ST/hit_ecu.png -i $O/sp15.mp4 -filter_complex "
 [0:v]fps=24,scale=1080:1920:flags=lanczos,format=rgb24[a];
 [a]scale=w='1080*(1.22-0.08*min(t,0.7))':h=-2:eval=frame,crop=1080:1920:'(iw-1080)/2+34*sin(t*85)*exp(-(t-0.125)*7)*gte(t,0.125)':'(ih-1920)/2+26*cos(t*73)*exp(-(t-0.125)*7)*gte(t,0.125)',format=rgb24[b];
 [b]negate=enable='between(t,0.04,0.125)',format=gbrp[c];[1:v]format=gbrp[s];[c][s]blend=all_mode=screen,
 drawbox=x=0:y=0:w=1080:h=1920:c=white@0.85:t=fill:enable='lt(t,0.04)',vignette=PI/5,format=yuv420p[v]" -map "[v]" -t 0.7 $ENC $O/s15.mp4
# the 3-frame freeze: hold frames 3-5 (t 0.125..) by re-timing: frames 4..6 duplicated
ffmpeg -v error -y -i $O/s15.mp4 -vf "loop=loop=3:size=1:start=3,setpts=N/24/TB" -t 0.825 $ENC $O/s15b.mp4
# "Ow." dented head with the face drawn on the dark screen
EYE(){ echo "drawbox=x=330:y=$2:w=130:h=${3:-26}:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=640:y=$2:w=130:h=${3:-26}:c=0x7ff6ff:t=fill:enable='$1'"; }
DASH(){ echo "drawbox=x=330:y=895:w=130:h=7:c=0x7ff6ff:t=fill:enable='$1',drawbox=x=640:y=895:w=130:h=7:c=0x7ff6ff:t=fill:enable='$1'"; }
MOUTH(){ echo "drawbox=x=455:y=1090:w=190:h=${2:-12}:c=0x7ff6ff:t=fill:enable='$1'"; }
ffmpeg -v error -y -loop 1 -i $ST/bot_dented.png -f lavfi -i "color=black:s=1080x1920:r=24:d=1.4" -filter_complex "
 [0:v]fps=24,scale=1080:1920:flags=lanczos,format=rgb24,
 $(DASH 'lt(t,0.45)'),$(EYE 'gte(t,0.45)' 872 22),$(EYE 'gte(t,0.45)' 850 10),
 $(MOUTH 'lt(t,0.25)+gt(t,1.1)'),$(MOUTH 'between(t,0.25,1.1)*lt(mod(t,0.3),0.14)'),$(MOUTH 'between(t,0.25,1.1)*gte(mod(t,0.3),0.14)' 34),
 split[f0][f1];[f1]gblur=sigma=12[g];[f0][g]blend=all_mode=screen,
 rgbashift=rh=22:bh=-22:enable='between(t,0,0.1)+between(t,0.25,0.3)',noise=alls=9:allf=t,
 scale=w='1080*(1.1+0.12*t/1.4)':h=-2:eval=frame,crop=1080:1920:'(iw-1080)/2+sin(t*47)*9':'(ih-1920)/2+cos(t*39)*9',format=rgb24[h];
 [1:v]geq=lum='if(gt(random(1),0.9988+0.0010*min(1,hypot(X-330,Y-720)/260)),255,0)*gte(T,0.25)*lt(T,0.8)':cb=128:cr=128,dilation,dilation,gblur=sigma=1.2,format=rgb24,lutrgb=g='val*0.62':b='val*0.15',format=gbrp[s];
 [h]format=gbrp[h2];[h2][s]blend=all_mode=screen,format=yuv420p[v]" -map "[v]" -t 1.4 $ENC $O/s16.mp4
# crane-up walk-off: s11 held 0.1 s longer; end card
ffmpeg -v error -y -i $O/s11.mp4 -vf "tpad=stop_mode=clone:stop_duration=0.1" -t 1.8 $ENC $O/s11b.mp4
# ---- re-cut of the v2 dialogue shots to the v3 beats ----
T1=$G/t1/video-talk-61-Save_Video.mp4; T2=$G/t2/video-talk-62-Save_Video.mp4
talk(){ ffmpeg -v error -y -i $1 -vf "trim=$2:$3,setpts=PTS-STARTPTS,fps=24,scale=w='1108*(1+$5*t/$4)':h=-2:eval=frame,crop=1080:1920,unsharp=5:5:0.8,vignette=PI/5${7:+,$7},format=yuv420p" -t $4 $ENC $O/$6.mp4; }
talk $T1 0 1.5 1.5 0.10 s04a
talk $T1 1.5 2.6 1.1 0.14 s04b "rotate=8*PI/180*t/1.1:fillcolor=black,scale=1180:-2,crop=1080:1920"
talk $T2 0 1.6 1.6 0.06 s06a
talk $T2 1.6 2.9 1.3 0.05 s06c
ffmpeg -v error -y -i $O/s05.mp4 -vf "tpad=stop_mode=clone:stop_duration=0.1" -t 2.4 $ENC $O/s05p.mp4
ffmpeg -v error -y -i $O/s07.mp4 -t 0.5 -c:v libx264 -crf 20 -pix_fmt yuv420p -an $O/s07s.mp4
cat > $O/list3.txt <<L
file s01.mp4
file s02.mp4
file s03.mp4
file s04a.mp4
file s04b.mp4
file s05p.mp4
file s06a.mp4
file s06c.mp4
file s06b.mp4
file s07s.mp4
file s08.mp4
file s13.mp4
file s14.mp4
file s15b.mp4
file s16.mp4
file s17.mp4
file s11b.mp4
file s12.mp4
L
ffmpeg -v error -y -f concat -i $O/list3.txt -vf "scale=1080:1920,setsar=1,format=yuv420p" $ENC $O/picture3.mp4
CAP="fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2"
C=$D/captions
dt(){ echo "drawtext=textfile=$C/$1.txt:enable='between(t,$2,$3)':$CAP:y=${4:-1380}"; }
ffmpeg -v error -y -i $O/picture3.mp4 -vf "$(dt 0 0.2 5.0),$(dt 1 5.2 7.8),$(dt 2 8.0 10.1),$(dt 3 10.2 13.1),$(dt 4 14.55 15.4),$(dt 5 18.05 19.1),$(dt 6 20.0 21.7 330)" $ENC $O/picture3_c.mp4
# ---- sound ----
V=$G/v; ANN1=$V/audio-voice-a_ee14e0ea1048b835.mp3; EP1=$V/audio-voice-a_d7241779a202bd0a.mp3; SB1=$V/audio-voice-a_0601a01c5194a3ad.mp3
EP2=$V/audio-voice-a_f9dca3af28f29716.mp3; SB2=$V/audio-voice-a_bb7b038627870c98.mp3; SB3=$V/audio-voice-a_ffac42b53eb8d1a9.mp3; ANN2=$V/audio-voice-a_9bbfe98221105268.mp3
sfx(){ ffmpeg -v error -y -f lavfi -i "$2" -af "$3" -t $4 $O/$1.wav; }
sfx bed3 "sine=f=55:d=23.3" "tremolo=f=2:d=0.4,volume=0.28,afade=t=in:st=0:d=1,afade=t=out:st=22.3:d=1" 23.3
sfx swish "anoisesrc=c=pink:a=0.8:d=0.5" "bandpass=f=1400:w=2000,afade=t=in:st=0:d=0.35,afade=t=out:st=0.35:d=0.1" 0.5
sfx crunch "anoisesrc=c=brown:a=0.9:d=0.5" "lowpass=f=1800,afade=t=out:st=0.04:d=0.45,volume=1.4" 0.5
sfx crowd "anoisesrc=c=pink:a=0.5:d=1.5" "bandpass=f=1200:w=1800,tremolo=f=7:d=0.6,afade=t=in:st=0:d=0.2,afade=t=out:st=0.9:d=0.6,volume=0.5" 1.5
IN=(); F=""; i=0
add(){ IN+=(-i "$1"); ms=$(printf '%.0f' $(echo "$2*1000"|bc -l)); F+="[$i:a]adelay=${ms}|${ms},volume=$3[a$i];"; i=$((i+1)); }
add $ANN1 0.0 1.0; add $EP1 5.2 1.0; add $SB1 8.0 1.0; add $EP2 10.2 1.0; add $SB2 14.55 1.0; add $SB3 18.05 1.0; add $ANN2 20.0 1.0
add $O/rumble.wav 0.0 0.5; add $O/clack.wav 3.45 0.7; add $O/hum.wav 1.8 0.5; add $O/servo.wav 8.0 1.0; add $O/servo.wav 8.9 0.6
add $O/click.wav 13.2 0.8; add $O/click.wav 13.9 0.6; add $O/swish.wav 16.1 0.9; add $O/whoosh.wav 16.7 0.8
add $O/whack.wav 17.2 1.0; add $O/clang.wav 17.22 1.0; add $O/crunch.wav 17.2 0.9; add $O/fizz.wav 17.5 0.9; add $O/fizz.wav 18.3 0.6
add $O/bed3.wav 0 0.5; add $O/sting.wav 20.0 0.6; add $O/crowd.wav 20.2 0.7; add $O/click.wav 12.0 0.5
N=$i; M=$(for ((k=0;k<N;k++)); do printf "[a$k]"; done)
ffmpeg -v error -y "${IN[@]}" -filter_complex "${F}${M}amix=inputs=$N:normalize=0,alimiter=limit=0.95,atrim=0:23.3[aud]" -map "[aud]" $O/audio3.wav
ffmpeg -v error -y -i $O/picture3_c.mp4 -i $O/audio3.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 160k -shortest -movflags +faststart $O/cut3.mp4
