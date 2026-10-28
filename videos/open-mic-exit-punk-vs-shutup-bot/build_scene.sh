#!/bin/bash
# Composites the green-screen DoD clips over City Top into a 1080x1920 scene (no GPU). Usage: build_scene.sh <clipsdir> <repo> <out.mp4>
C=$1; R=$2; OUT=$3
WALK=$C/file-import-a_506f722b61fa9212.mp4; FAIR=$C/file-import-a_845a5582b33013f1.mp4
EPI=$C/file-import-a_23f9c8b2b3af6b67.mp4;  SBI=$C/file-import-a_caa06a43c84d5e0c.mp4
BG=$R/stages/city-top/backdrop.webp; ART=$R/stages/city-top/wide/stage-art.webp
K="colorkey=0x00FF00:0.32:0.1,despill=green"
S=980
FY=1330 # roof line y
D=22.2
ffmpeg -v error -y -loop 1 -t $D -i $BG -loop 1 -t $D -i $ART \
 -stream_loop -1 -i $WALK -stream_loop -1 -i $EPI -i $FAIR -stream_loop -1 -i $SBI \
 -filter_complex "
 [0]scale=-2:1920,crop=1080:1920:1100:0,fps=24,eq=brightness=-0.12[bg];
 [1]scale=1900:-1,fps=24[art];
 [bg][art]overlay=(W-w)/2+120:$FY-324[b1];
 [2]fps=24,$K,scale=$S:$S,trim=0:$D,setpts=PTS-STARTPTS[walk];
 [3]fps=24,$K,scale=$S:$S,trim=0:$D,setpts=PTS-STARTPTS,split=2[epi][epi3];
 [4]fps=24,$K,scale=$S:$S,setpts=PTS+16.0/TB[fair];
 [5]fps=24,$K,scale=$S:$S,hflip,trim=0:$D,setpts=PTS-STARTPTS[sb];
 [b1][sb]overlay=x=330:y=534[b2];
 [b2][walk]overlay=x='-900+(t-0.3)*410':y=534:enable='between(t,0.3,2.3)'[b3];
 [b3][epi]overlay=x=-80:y=534:enable='between(t,2.3,16.0)'[b4];
 [b4][fair]overlay=x=-80:y=534:enable='between(t,16.0,17.2)':eof_action=pass[b5];
 [b5][epi3]overlay=x=-80:y=534:enable='gte(t,17.2)'[b6];
 [b6]vignette=PI/5,format=yuv420p,
 drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/0.txt:enable='between(t,0.3,5.4)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/1.txt:enable='between(t,5.6,8.2)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/2.txt:enable='between(t,8.5,10.6)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/3.txt:enable='between(t,10.9,14.3)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/4.txt:enable='between(t,15.0,15.8)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/5.txt:enable='between(t,17.4,18.4)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,drawtext=textfile=$R/videos/open-mic-exit-punk-vs-shutup-bot/captions/6.txt:enable='between(t,18.9,20.6)':fontcolor=white:fontsize=64:borderw=4:bordercolor=black:line_spacing=10:x=(w-text_w)/2:y=1420,
 fade=t=out:st=20.3:d=0.2[v];
 color=c=0x0b0b0e:s=1080x1920:r=24:d=1.9,format=yuv420p,
 drawtext=text='DOSE OF DESTRUCTION':fontcolor=0xe8c9a0:fontsize=84:x=(w-text_w)/2:y=(h-text_h)/2-30,
 drawtext=text='Made with Hawkes Gen · hawkesgen.ai':fontcolor=0x9a9a9a:fontsize=34:x=(w-text_w)/2:y=(h/2)+80[card];
 [v]trim=0:20.5,setpts=PTS-STARTPTS[v1];[v1][card]concat=n=2:v=1:a=0[o]" \
 -map "[o]" -t 22 -r 24 -c:v libx264 -crf 18 -pix_fmt yuv420p $OUT
