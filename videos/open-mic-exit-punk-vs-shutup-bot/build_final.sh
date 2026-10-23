#!/bin/bash
# Final: v3 cut with the 2D-clip wides (s03, s11b) replaced by Gen 3D-style wide stills. Run after build_v3.sh shots exist in <out>.
# Usage: build_final.sh <out>   (stills in ./stills; re-run build_v3.sh's concat/caption/audio tail with the new s03/s11b)
O=$1; ENC="-r 24 -c:v libx264 -crf 18 -pix_fmt yuv420p -an"; S=$(dirname $0)/stills
ffmpeg -v error -y -loop 1 -i $S/wide_open.png -vf "fps=24,scale=1080:1920:flags=lanczos,scale=w='1080*(1.05+0.10*t/1.8)':h=-2:eval=frame,crop=1080:1920:'(iw-1080)*(0.3+0.4*t/1.8)':'(ih-1920)*0.5',unsharp=5:5:0.6,vignette=PI/5,format=yuv420p" -t 1.8 $ENC $O/s03.mp4
ffmpeg -v error -y -f lavfi -i "color=black:s=1080x1920:r=24:d=1.8" -vf "geq=lum='if(gt(random(1),0.985+0.01*min(1,hypot(X-760,Y-(900-T*160))/200)),170,0)':cb=128:cr=128,gblur=sigma=14,eq=contrast=1.8,format=rgb24" $ENC $O/sm.mp4
ffmpeg -v error -y -loop 1 -i $S/wide_walkoff.png -i $O/sm.mp4 -filter_complex "[0:v]fps=24,scale=1080:1920:flags=lanczos,format=rgb24,scale=1250:2222,crop=1080:1920:'85+30*t/1.8':'300-300*t/1.8',unsharp=5:5:0.5,vignette=PI/5[w];[1:v]format=gbrp[s];[w]format=gbrp[w1];[w1][s]blend=all_mode=screen:all_opacity=0.55,format=yuv420p[v]" -map "[v]" -t 1.8 $ENC $O/s11b.mp4
