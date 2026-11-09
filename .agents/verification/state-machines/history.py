#!/usr/bin/env python3
"""Rank first-party source change/fix history for the fixed three-month review window."""
from pathlib import Path
from collections import defaultdict
import argparse, json, re, subprocess
ROOT=Path(__file__).resolve().parents[3]
START='2026-08-09T00:00:00+08:00'
END='2026-11-10T00:00:00+08:00'
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--out',type=Path,required=True)
 args=parser.parse_args()
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 text=subprocess.check_output(['git','log','--first-parent','--since-as-filter='+START,'--until='+END,'--numstat','--format=COMMIT%x09%H%x09%cI%x09%s','--','apps','packages'],cwd=ROOT,text=True)
 commits=[]
 for line in text.splitlines():
  if line.startswith('COMMIT\t'):
   _,sha,date,subject=line.split('\t',3);commits.append(dict(sha=sha,date=date,subject=subject,files=[]))
  elif re.match(r'^\d+\t\d+\t',line):
   added,deleted,path=line.split('\t',2)
   path=re.sub(r'\{[^{}]* => ([^{}]*)\}',r'\1',path)
   if ' => ' in path:path=path.split(' => ')[-1]
   commits[-1]['files'].append(dict(path=path,added=int(added),deleted=int(deleted)))
 def owner(p):
  if p.startswith('apps/cli/src/lib/'):return '/'.join(p.split('/')[:5]) if len(p.split('/'))>5 else 'apps/cli/src/lib (root)'
  if p.startswith('apps/cli/src/'):return '/'.join(p.split('/')[:4])
  if p.startswith('packages/components/src/'):return '/'.join(p.split('/')[:4])
  if p.startswith('apps/mobile/'):return '/'.join(p.split('/')[:3])
  if p.startswith('apps/electron/'):return '/'.join(p.split('/')[:4])
  return '/'.join(p.split('/')[:2])
 def production(p):
  if p.startswith('apps/') and not p.startswith(('apps/cli/','apps/electron/','apps/mobile/')):return False
  return re.search(r'\.(?:ts|tsx|mts|mjs|js|swift|kt|rs)$',p) and not re.search(r'/(?:tests?|__tests__|stories|fixtures|vendor|generated|scripts)/|\.(?:test|spec|stories|generated)\.|\.d\.ts$',p) and '/acp-extension-' not in p
 def bucket():return dict(commits=set(),fixCommits=set(),changedLines=0,paths=set(),fixes=[])
 modules=defaultdict(bucket);files=defaultdict(bucket)
 for commit in commits:
  fix=bool(re.match(r'fix(?:\([^)]*\))?!?:',commit['subject'],re.I));touched=set()
  for file in commit['files']:
   p=file['path']
   if not production(p):continue
   group=owner(p);touched.add(group)
   for stats in [modules[group],files[p]]:
    stats['commits'].add(commit['sha']);stats['changedLines']+=file['added']+file['deleted'];stats['paths'].add(p)
    if fix:stats['fixCommits'].add(commit['sha'])
   if fix:files[p]['fixes'].append({k:commit[k] for k in ['sha','date','subject']})
  if fix:
   for group in touched:modules[group]['fixes'].append({k:commit[k] for k in ['sha','date','subject']})
 def row(name,value):return dict(name=name,commits=len(value['commits']),fixCommits=len(value['fixCommits']),changedLines=value['changedLines'],sourceFiles=len(value['paths']))
 ranked=sorted([row(n,s) for n,s in modules.items()],key=lambda x:(x['fixCommits'],x['commits'],x['changedLines']),reverse=True)
 ranked_files=sorted([row(n,s) for n,s in files.items()],key=lambda x:(x['fixCommits'],x['commits']),reverse=True)
 selected='apps/cli/src/session/session-execution-service.ts'
 examples=[f for f in files[selected]['fixes'] if re.search(r'Stop|Inbox|input|release|cancel|interrupt|replay|handoff',f['subject'],re.I)][:14]
 oldest=subprocess.check_output(['git','log','--reverse','--first-parent','--format=%H %cI','HEAD'],cwd=ROOT,text=True).splitlines()[0]
 result=dict(sourceCommit=head,window=dict(startInclusive=START,endExclusive=END,timezone='Asia/Shanghai',dateField='committer date'),localHistory=dict(shallow=subprocess.check_output(['git','rev-parse','--is-shallow-repository'],cwd=ROOT,text=True).strip()=='true',oldestFirstParent=oldest,windowCovered='Local first-parent chain starts before the requested window; this is not a claim about all remote branch history.'),method='Reachable first-parent commits; fix: or fix(scope): subject prefix; first-party production source extensions; tests/stories/generated/vendor/adapters excluded. A commit counts once per owner. Added+deleted is churn. Fix titles and folder size are selection signals, not measured defect rates.',publicSourceCommits=sum(any(production(f['path']) for f in c['files']) for c in commits),topOwnerGroups=ranked[:18],topFiles=ranked_files[:12],selectedSystem='Session Inbox admission, submission and continuation scheduling',selectedCore=row(selected,files[selected]),selectedSupporting=[row(n,modules[n]) for n in ['apps/cli/src/session','apps/cli/src/orchestration']],recurringFixExamples=examples,selectionReason='Choose a frequently repaired execution system whose failures can duplicate input, lose queued work or block unrelated conversations. The modeled boundary is the Inbox service/owner/SQLite scheduler, not the whole UI or every Session feature.')
 args.out.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result['selectedCore']))
if __name__=='__main__':main()
