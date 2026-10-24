import json,os
P=os.path.abspath('.')
IDX={'a_eac2a5f75a7f8389':0,'a_d16fb61846f1d9e5':1,'a_fc8543056d6befeb':2,'a_0743a4e04cd9120b':3,'a_e47a723ef12f28ad':4,'endcard':5}
L=lambda a,i,o,beat,label,**k:dict(asset=a,**{'in':i,'out':o},beat=beat,label=label,**k)
A='a_eac2a5f75a7f8389';S='a_d16fb61846f1d9e5';T='a_fc8543056d6befeb';F='a_0743a4e04cd9120b';D='a_e47a723ef12f28ad'
clips=[
 L(A,0,3,'hook_lights','MS Orchestrator: Good evening, city! (push-in)',zoom=dict({'from':1,'to':1.2,'x':.5,'y':.4})),
 L(A,3,6,'wide_screens','WS Orchestrator: a walk-on.'),
 L(S,.2,2.475,'orch_sponsor','CU Orchestrator: No sponsor. No record. (lipsync, voice re-placed 0.21 s later so the mouth lands on the consonants)',sound=False),
 L(A,8.5,11,'empty_entrance','MS empty entrance: One skateboard.'),
 L(T,0,3,'ep_rolls_in',"TWO-SHOT punch-in on Exit Punk's face: I'm not here for the show.",zoom={'from':1.5,'to':1.75,'x':1,'y':.3}),
 L(T,3,4,'ep_kick','MS Exit Punk kicks the board up'),
 L(T,4,6.5,'ep_exit',"MCU Exit Punk: I'm here for the exit. eyes flick to the crack"),
 L(T,6.5,7.8,'kaelen_lands','WS Kaelen lands, floor cracks, Exit Punk eyeline'),
 L(T,7.8,8.5,'kaelen_lands','WS Kaelen on the cracked floor (sound off: stray voice removed)',sound=False),
 L(T,8.5,12,'orch_main_event',"MCU Orchestrator grin, baton snaps up: Then you'll have to go through the main event."),
 L(F,0,2,'fight_drop','WS Exit Punk drops the board, Kaelen charges'),
 L(F,2,3,'fight_dodge','MS dodge'),
 L(F,3,3.9,'fight_swing','CU swing'),
 L(F,3.9,4.6,'fight_hit','WS board hits Kaelen, shockwave ring (slow-mo, held 1.4 s)',speed=.5),
 L(F,4.6,5.2,'crowd','MS Exit Punk holds the board, breath after the hit; crowd roar (slow-mo)',speed=.6),
 L(D,0,2.6,'ep_ratings','MCU Exit Punk: Ratings went up?'),
 L(D,2.6,5.0,'orch_eleven','MCU Orchestrator: Eleven points. (full line, held)'),
 L('endcard',0,1.5,'end_card','END CARD: arena wide, title lockup in the caption band',sound=False),
]
F24=24
st=[];t=0
for c in clips:
  n=round((c['out']-c['in'])/c.get('speed',1)*F24);st.append(t);c['_n']=n;t+=n
tot=t/F24
for c,s in zip(clips,st):c['_s']=s/F24
def start(beat,which=0):return [c['_s'] for c in clips if c['beat']==beat][which]
caps=[]
def cap(text,beat,off,dur,which=0):
  s=start(beat,which)+off;caps.append(dict(text=text,start=round(s,2),end=round(s+dur,2)))
cap('Good evening, city!','hook_lights',.2,2.7)
cap('No sponsor. No record.','orch_sponsor',.45,2.0)
cap('One skateboard.','empty_entrance',.9,1.6)
cap("I'm not here for the show.",'ep_rolls_in',.85,1.55)
cap("I'm here for the exit.",'ep_exit',1.15,1.65)
cap("Then you'll have to go through the main event.",'orch_main_event',.6,2.8)
cap('RATINGS +11','crowd',0,1.0)
cap('Ratings went up?','ep_ratings',1.4,1.2)
cap('Eleven points.','orch_eleven',1.15,.9)
sp=start('orch_sponsor')+.01
drum=start('fight_drop')
audio=[dict(asset='a_19359182fe9a32c8',start=0,seconds=4,volume=.8,fadeOut=1.5,label='brass stab'),
 dict(asset='a_0ed81eb4fd825df8',start=round(drum,3),seconds=round(start('ep_ratings')-drum+.6,2),volume=.6,fadeOut=.4,label='drum loop'),
 dict(asset='sponsor',start=round(sp,3),seconds=2.45,dialogue=True,label="ORCHESTRATOR: No sponsor. No record. (delayed 0.21 s vs the clip's own track)")]
AI={'a_19359182fe9a32c8':0,'a_0ed81eb4fd825df8':1,'sponsor':2}
edit=dict(width=1080,height=1920,fps=24,burn=True,color='0b1020',fit='pad',clips=[{k:v for k,v in c.items() if k!='_n' and k!='_s'} for c in clips],audio=audio,captions=caps)
json.dump(edit,open('edit.json','w'),indent=1)
tl=dict(clips=[],audio=[],captions=caps)
for c in clips:
  d=dict(clip=IDX[c['asset']],**{'in':c['in'],'out':c['out']})
  for k in('speed','zoom'):
    if k in c:d[k]=c[k]
  if c.get('sound') is False:d['sound']=False
  else:d['dialogue']=True
  tl['clips'].append(d)
for a in audio:
  d={k:v for k,v in a.items() if k not in('asset','label')};d['audio']=AI[a['asset']];tl['audio'].append(d)
json.dump(tl,open('/tmp/tl.json','w'))
print(tot,json.dumps(tl))
print([ (c['beat'],c['_s']) for c in clips])
