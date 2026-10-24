# v6: edit.json (v5) -> v6 edit + the compose timeline. Edit-only, no GPU.
import json
e=json.load(open('edit.json'))
cl=e['clips']
# note 2: lip sync CU, picture 4 frames (0.167 s) earlier against the same voice track
s=[c for c in cl if c['beat']=='orch_sponsor'][0]
s['label']='CU Orchestrator: No sponsor. No record. (lipsync; voice track delayed 0.21 s + 4 frames so the mouth lands on the consonants)'
for a in e['audio']:
  if a['asset'].startswith('blob:db1c'):a['start']=round(a['start']+4/24,3);a['label']='ORCHESTRATOR: No sponsor. No record. (delayed 0.21 s + 4 frames vs the clip own track)'
for c in e['captions']:
  if c['text'].startswith('No sponsor'):c['start']=round(c['start']+4/24,2);c['end']=round(c['end']+4/24,2)
# note 1: stray Kaelen/take fragment in scene B 8.5-10.4 muted; the Orchestrator line starts clean on "Then"
i=[k for k,c in enumerate(cl) if c['beat']=='orch_main_event'][0]
o=cl[i]
cl[i:i+1]=[dict(asset=o['asset'],**{'in':8.5,'out':10.35},beat='kaelen_lands',label='MS Kaelen settles on the cracked floor; Orchestrator steps into frame (sound off: stray voice fragment removed)',sound=False),
           dict(asset=o['asset'],**{'in':10.35,'out':12},beat='orch_main_event',label=o['label'])]
# captions: the line starts at 21.0 s now
for c in e['captions']:
  if c['text'].startswith('Then you'):c['start'],c['end']=21.15,22.8
json.dump(e,open('edit.json','w'),indent=1)
ids=[]
def idx(a):
  if a not in ids:ids.append(a)
  return ids.index(a)
tl=dict(clips=[],audio=[],captions=e['captions'])
for c in cl:
  d=dict(clip=idx(c['asset']),**{'in':c['in'],'out':c['out']})
  for k in('speed','zoom'):
    if k in c:d[k]=c[k]
  if c.get('sound') is False:d['sound']=False
  else:d['dialogue']=True
  tl['clips'].append(d)
aud=[];AI={}
for a in e['audio']:
  AI.setdefault(a['asset'],len(AI))
  d={k:v for k,v in a.items() if k not in('asset','label')};d['audio']=AI[a['asset']];tl['audio'].append(d)
json.dump(dict(clips=ids,audio=list(AI),timeline=tl),open('/tmp/tl6.json','w'))
print(json.dumps(dict(clips=ids,audio=list(AI))));print(json.dumps(tl))
