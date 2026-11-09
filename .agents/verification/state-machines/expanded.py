#!/usr/bin/env python3
"""Check the delivery/output slices of the single Session Inbox verification skill."""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,re,subprocess,sys,tempfile
PROFILES=[('Delivery','delivery-safety'),('Delivery','delivery-progress'),('Delivery','delivery-partition'),('Delivery','delivery-negative-ack'),('Delivery','delivery-durable-control'),('OutputGate','gate-current'),('OutputGate','gate-completing'),('OutputGate','gate-cancel-control'),('OutputGate','gate-deadlock')]
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[3])
 parser.add_argument('--tools',type=Path,default=Path('/tmp/lody-inbox-verification-tools'))
 parser.add_argument('--out',type=Path)
 parser.add_argument('--source-only',action='store_true',help='Run real-source witnesses only; do not claim model verification.')
 parser.add_argument('--safety-only',action='store_true',help='Use TLC DFID at maximum depth 100, omit temporal properties, and report liveness as NOT RUN. Avoids TLC BFS local RMI.')
 args=parser.parse_args();root=args.root.resolve();here=Path(__file__).resolve().parent
 skill=root/'.agents/skills/verify-session-execution'
 # Adjacent staging resources support review before protected files are copied.
 if not (skill/'expanded-coverage.json').exists():skill=here
 coverage=json.loads((skill/'expanded-coverage.json').read_text())
 for entry in coverage['sources']:
  file=root/entry['path'];assert hashlib.sha256(file.read_bytes()).hexdigest()==entry['sha256'],'Stale expanded mapping: '+entry['path']
 check_path=root/'.agents/verification/state-machines/check.py';spec=importlib.util.spec_from_file_location('base_check',check_path);base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
 out=args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix='lody-inbox-expanded-'))
 assert not out.is_relative_to(root),'Keep raw verification output outside repository'
 if args.out:out.mkdir(parents=True,exist_ok=False)
 print('Artifacts:',out,flush=True);results={};blocked=[]
 if not args.source_only:
  java,jar=base.tlc_tools()
  for module,name in PROFILES:
   if args.safety_only and name in ('delivery-progress','gate-current'):continue
   config=(skill/(name+'.cfg')).read_text();folder=out/name;source=(skill/(module+'.tla')).read_text().replace('---- MODULE '+module+' ----','---- MODULE Model ----',1)
   if args.safety_only:
    # Explicitly omit liveness. A finite depth limit alone is not a proof: require
    # TLC's completion message, or a concrete invariant/deadlock counterexample.
    config='\n'.join(line for line in config.splitlines() if not line.startswith(('PROPERTY ','PROPERTIES ','CHECK_DEADLOCK '))).replace('SPECIFICATION FairSpec','SPECIFICATION Spec')+'\n'
    folder.mkdir();(folder/'Model.tla').write_text(source);(folder/'Model.cfg').write_text(config)
    run=subprocess.run([java,'-Xmx512m','-XX:+UseParallelGC','-cp',str(jar),'tlc2.TLC','-dfid','100','-workers','1','-fp','0','-config','Model.cfg','Model.tla'],cwd=folder,capture_output=True,text=True,timeout=60)
    output=run.stdout+run.stderr;(folder/'tlc.out').write_text(output)
    counts=re.findall(r'(\d+) states generated, (\d+) distinct states found',output)
    result={'exit':run.returncode,'distinctStates':int(counts[-1][1]) if counts else None,'output':output}
    if run.returncode==0 and 'Model checking completed. No error has been found.' not in output:result['exit']=255
   else:result=base.run_tlc(java,jar,source,config,folder)
   code=result['exit'];violations=re.findall(r'Error: (Invariant [^\n]+|Deadlock reached\.|Temporal properties were violated\.)',result['output'])
   status='PASS' if code==0 else 'FAIL' if code in (11,12,13) and violations else 'BLOCKED'
   results[name]={'result':status,'distinctStates':result['distinctStates'],'exit':code,'violations':violations,'toolFailure':result['output'][-1600:] if status=='BLOCKED' else None,'temporalRequested':not args.safety_only and ('PROPERTY ' in config or 'PROPERTIES ' in config),'temporalChecked':not args.safety_only and code in (0,13) and status!='BLOCKED' and ('PROPERTY ' in config or 'PROPERTIES ' in config)}
   if status=='BLOCKED':blocked.append(name)
   print(name,{k:results[name][k] for k in ('result','distinctStates','exit','temporalChecked')},flush=True)
 if not args.source_only and not args.safety_only:
  for module,name,exit_code in [('Delivery','delivery-legacy-negative-ack',12),('OutputGate','gate-legacy',11),('OutputGate','gate-late-write-mutant',12)]:
   source=(skill/(module+'.tla')).read_text().replace('---- MODULE '+module+' ----','---- MODULE Model ----',1)
   result=base.run_tlc(java,jar,source,(skill/(name+'.cfg')).read_text(),out/name)
   assert result['exit']==exit_code,'Broken model behavior was not caught: '+name
   results[name]={'result':'CAUGHT','exit':result['exit'],'distinctStates':result['distinctStates']}
 for file,variant in [('sync-replay.mjs','current'),('decision-replay.mjs','current')]:
  run=subprocess.run(['node',str(here/file),str(root),str(args.tools),variant],capture_output=True,text=True,timeout=60)
  key=file.removesuffix('.mjs')+'-'+variant;(out/(key+'.out')).write_text(run.stdout+run.stderr)
  if run.returncode not in (0,1) or not run.stdout.strip().startswith('{'):
   results[key]={'result':'BLOCKED'};blocked.append(key);continue
  data=json.loads(run.stdout);results[key]=data
  if 'sqliteTimelines' in data:
   assert data['sqliteTimelines']['result']=='PASS' and data['sqliteTimelines']['timelines']==336,'SQL timeline regression'
   if variant=='cancel-control':assert data['outputGate']['result']=='PASS','Scratch dispose control failed'
  else:assert data['cancelDecisions']['result']=='PASS' and data['payloadArrivalOrders']['result']=='PASS','Delivery decision regression'
  print(key,'FAIL' if run.returncode else 'PASS',flush=True)
 mutations=[]
 for file,variant,property_name in [('decision-replay.mjs','unsafe-cancel','CancelRequestIdentity'),('decision-replay.mjs','unsafe-negative-ack','NoFailedReplay')]:
  mutation=subprocess.run(['node',str(here/file),str(root),str(args.tools),variant],capture_output=True,text=True,timeout=60)
  (out/(variant+'.out')).write_text(mutation.stdout+mutation.stderr)
  assert mutation.returncode==1 and 'AssertionError' in mutation.stderr and property_name+':' in mutation.stderr,'Source mutation did not fail behaviorally: '+variant
  mutations.append({'property':property_name,'result':'CAUGHT'})
 mutation=subprocess.run(['node',str(here/'sync-replay.mjs'),str(root),str(args.tools),'unsafe-gate'],capture_output=True,text=True,timeout=60)
 (out/'unsafe-gate.out').write_text(mutation.stdout+mutation.stderr)
 assert mutation.returncode==1 and json.loads(mutation.stdout)['outputGate']['result']=='FAIL','Old gate-blocking behavior was not caught'
 mutations.append({'property':'DisposeUnblocks/DeadlineUnblocks','result':'CAUGHT'})
 mutation=subprocess.run(['node',str(here/'sync-replay.mjs'),str(root),str(args.tools),'unsafe-late-write'],capture_output=True,text=True,timeout=60)
 (out/'unsafe-late-write.out').write_text(mutation.stdout+mutation.stderr)
 assert mutation.returncode==1 and 'AssertionError' in mutation.stderr and 'NoLateWrites:' in mutation.stderr,'Actual assistant writer cancellation fence mutation was not caught'
 mutations.append({'property':'NoLateWrites','result':'CAUGHT'})
 results['sourceMutations']=mutations
 failures=[]
 if results.get('sync-replay-current',{}).get('outputGate',{}).get('result')=='FAIL':failures.append('OUTPUT_GATE_DISPOSE_DOES_NOT_RELEASE')
 if results.get('decision-replay-current',{}).get('negativeAck',{}).get('result')=='FAIL':failures.append('MISSING_HISTORY_ACK_REPLACED')
 any_fail=bool(failures) or any(isinstance(r,dict) and r.get('result')=='FAIL' for r in results.values())
 summary={'sourceCommit':coverage['syncCommit'],'system':coverage['system'],'result':'FAIL' if any_fail else 'BLOCKED' if blocked else 'PASS','proofScope':'source-only' if args.source_only else 'safety-only; temporal properties NOT RUN' if args.safety_only else 'finite safety and weak-fairness temporal profiles','blocked':blocked,'findings':failures,'profiles':results,'limits':coverage['limits']}
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print('Result:',summary['result'],flush=True)
 return 2 if blocked else 1 if any_fail else 0
if __name__=='__main__':
 try:sys.exit(main())
 except (OSError,ValueError,AssertionError,subprocess.SubprocessError) as error:
  print('Expanded verification could not complete:',str(error),file=sys.stderr);sys.exit(2)
