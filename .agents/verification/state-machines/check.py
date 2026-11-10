#!/usr/bin/env python3
"""Check the single Session Inbox model and replay its current progress finding."""
from pathlib import Path
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, urllib.request
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
SKILL=ROOT/'.agents/skills/verify-session-execution'
TLC_SHA='936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
TLC_URL='https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar'
def require(condition,message):
 if not condition:raise RuntimeError(message)
def tlc_tools():
 java=os.environ.get('JAVA') or ('/opt/homebrew/opt/openjdk@21/bin/java' if Path('/opt/homebrew/opt/openjdk@21/bin/java').exists() else shutil.which('java'))
 require(java,'Set JAVA to a Java 11+ executable.')
 jar=Path(os.environ.get('TLA2TOOLS',str(Path(tempfile.gettempdir())/'lody-tlc-1.7.4.jar')))
 if not jar.exists():
  require('TLA2TOOLS' not in os.environ,'TLA2TOOLS does not exist.')
  with urllib.request.urlopen(TLC_URL,timeout=60) as response:data=response.read()
  require(hashlib.sha256(data).hexdigest()==TLC_SHA,'TLC download checksum mismatch.')
  with tempfile.NamedTemporaryFile(dir=jar.parent,delete=False) as out:out.write(data);stage=Path(out.name)
  stage.replace(jar)
 require(hashlib.sha256(jar.read_bytes()).hexdigest()==TLC_SHA,'Expected pinned TLC 1.7.4 distribution.')
 return java,jar

def run_tlc(java,jar,source,config,folder):
 folder.mkdir(parents=True,exist_ok=False)
 (folder/'Model.tla').write_text(source);(folder/'Model.cfg').write_text(config)
 result=subprocess.run([java,'-Xmx512m','-XX:+UseParallelGC','-cp',str(jar),'tlc2.TLC','-workers','1','-fp','0','-lncheck','final','-config','Model.cfg','Model.tla'],cwd=folder,capture_output=True,text=True,timeout=60)
 output=result.stdout+result.stderr;(folder/'tlc.out').write_text(output)
 match=re.search(r'(\d+) states generated, (\d+) distinct states found',output)
 return {'exit':result.returncode,'distinctStates':int(match[2]) if match else None,'output':output}
def model_mutations(source,config):
 for prop,key in [('AtMostOnce','PermitReplay'),('NoStartAfterStop','PermitReplay'),('RetryEvidenceRetained','DropRetryEvidence'),('OldReleaseCannotFreeSuccessor','StaleRelease')]:
  mutated=config.replace(key+' = FALSE',key+' = TRUE')
  mutated=re.sub(r'(?m)^INVARIANTS .*$',f'INVARIANTS TypeOK {prop}',mutated)
  yield prop,source,mutated
 prop='ConsumedOnlyAfterStart'
 start=source.index('PrepareBatch ==');end=source.index('\n\n',start)
 part=source[start:end]
 part=part.replace('    /\\ UNCHANGED <<','    /\\ bConsumed\' = TRUE\n    /\\ UNCHANGED <<')
 prefix,unchanged=part.split('UNCHANGED <<',1)
 fields=unchanged.removesuffix('>>').split(', ')
 require('bConsumed' in fields,'Preparation mutation mapping moved.')
 part=prefix+'UNCHANGED <<'+', '.join(x for x in fields if x!='bConsumed')+'>>'
 mutated_source=source[:start]+part+source[end:]
 mutated_config=re.sub(r'(?m)^INVARIANTS .*$',f'INVARIANTS TypeOK {prop}',config)
 yield prop,mutated_source,mutated_config

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 candidates=[Path(tempfile.gettempdir())/'lody-inbox-verification-tools',Path('/tmp/lody-inbox-verification-tools')]
 default_tools=next((p for p in candidates if (p/'node_modules/effect/package.json').exists()),candidates[0])
 parser.add_argument('--tools',type=Path,default=default_tools)
 parser.add_argument('--prepare-tools',action='store_true',help='Install the locked verifier dependencies into the external tools directory.')
 parser.add_argument('--out',type=Path)
 args=parser.parse_args()
 coverage=json.loads((SKILL/'coverage.json').read_text())
 for entry in coverage['sources']:
  file=ROOT/entry['path'];require(file.is_file(),f'Missing source: {file}')
  require(hashlib.sha256(file.read_bytes()).hexdigest()==entry['sha256'],f'Stale mapping: {entry["path"]}. Review code/model before updating coverage.')
 tools=args.tools.resolve()
 require(not tools.is_relative_to(ROOT),'Keep verification dependencies outside the repository.')
 if args.prepare_tools:
  tools.mkdir(parents=True,exist_ok=True)
  for old,new in [('toolchain.package.json','package.json'),('toolchain.lock.json','package-lock.json')]:shutil.copyfile(SKILL/old,tools/new)
  subprocess.run(['npm','ci','--no-audit','--no-fund','--prefix',str(tools),'--workspaces=false'],check=True,timeout=300,cwd=tools)
 require((tools/'node_modules/effect/package.json').exists(),'Verifier dependencies missing. Run this command with --prepare-tools once, or pass --tools with the locked dependencies.')
 out=args.out.resolve() if args.out else Path(tempfile.mkdtemp(prefix='lody-inbox-check-'))
 require(not out.is_relative_to(ROOT),'Keep raw check output outside the repository.')
 if args.out:out.mkdir(parents=True,exist_ok=False)
 print('Artifacts:',out,flush=True)
 java,jar=tlc_tools();source=(SKILL/'Model.tla').read_text();results={}
 for profile in ['safety','progress']:
  result=run_tlc(java,jar,source,(SKILL/(profile+'.cfg')).read_text(),out/profile)
  require(result['exit'] in (0,12,13),f'TLC tool/spec error in {profile}; inspect its tlc.out')
  require(result['distinctStates'] is not None,f'TLC did not finish {profile}')
  results[profile]={'result':'PASS' if result['exit']==0 else 'FAIL','distinctStates':result['distinctStates'],'exit':result['exit']}
  print(profile,results[profile],flush=True)
 require(results['safety']['result']=='PASS','Current safety profile failed; inspect counterexample.')
 legacy=run_tlc(java,jar,source,(SKILL/'legacy-progress.cfg').read_text(),out/'legacy-progress')
 require(legacy['exit']==13 and 'Temporal properties were violated' in legacy['output'],'Old scanner failure was not caught.')
 results['legacyProgressMutation']={'result':'CAUGHT','distinctStates':legacy['distinctStates']}
 mutations=[]
 for prop,body,config in model_mutations(source,(SKILL/'safety.cfg').read_text()):
  result=run_tlc(java,jar,body,config,out/'model-mutations'/prop)
  require(result['exit']==12 and f'Invariant {prop} is violated' in result['output'],f'Model mutation missed {prop}')
  mutations.append({'property':prop,'result':'CAUGHT'})
 results['modelMutations']=mutations
 cases=[('busy-amplification','trigger'),('current','trigger'),('blocked-scan','trigger'),('current','sqlite-full'),('blocked-scan','sqlite-full'),('unsafe-submit','trigger'),('stale-release','trigger'),('drop-retry','trigger')]
 for variant,fault_mode in cases:
  key=variant+('-sqlite-full' if fault_mode=='sqlite-full' else '')
  result=subprocess.run(['node',str(HERE/'replay.mjs'),str(ROOT),str(tools),variant,fault_mode],capture_output=True,text=True,timeout=60)
  (out/(key+'-replay.out')).write_text(result.stdout+result.stderr)
  if variant in ('current','blocked-scan'):
   require(result.returncode in (0,1) and result.stdout.strip().startswith('{'),f'Replay tool error for {variant}; inspect output.')
   data=json.loads(result.stdout);results['source-'+key]=data
   require(all(x['result']=='PASS' for x in data['safety']),f'Source safety failure in {variant}')
   require((result.returncode==0)==(data['progress']['result']=='PASS'),'Source result/exit mismatch.')
   print('source-'+key,data['progress'],flush=True)
  else:
   property_name={'unsafe-submit':'NoStartAfterStop','stale-release':'OldReleaseCannotFreeSuccessor','drop-retry':'RetryEvidenceRetained','busy-amplification':'NativeBusyWaitBound'}[variant]
   require(result.returncode==1 and 'AssertionError' in result.stderr and property_name+':' in result.stderr,f'Source mutation not behaviorally caught: {variant}')
   results['source-'+key]={'result':'CAUGHT','property':property_name}
 require(results['source-current']['progress']['result']=='PASS','Current code must preserve independent progress.')
 require(results['source-blocked-scan']['progress']['result']=='FAIL','Old scan blocking mutation was not caught.')
 require(results['source-current-sqlite-full']['progress']['result']=='PASS','Current native SQLITE_FULL replay failed.')
 require(results['source-blocked-scan-sqlite-full']['progress']['result']=='FAIL','Native capacity blocking mutation missed.')
 require(results['source-current-sqlite-full']['progress']['result']==results['progress']['result'],'Model/native SQLITE_FULL replay disagree.')
 require(results['progress']['result']==results['source-current']['progress']['result'],'Model/source progress results disagree; investigate mapping.')
 status=results['progress']['result']
 expanded_run=subprocess.run([sys.executable,str(HERE/'expanded.py'),'--tools',str(tools),'--out',str(out/'expanded')],text=True)
 require(expanded_run.returncode in (0,1,2),'Expanded verifier crashed.')
 expanded_summary=out/'expanded'/'summary.json'
 require(expanded_summary.exists(),'Expanded verifier did not produce evidence.')
 results['expanded']=json.loads(expanded_summary.read_text())
 if results['expanded']['result']=='FAIL':status='FAIL'
 summary={'sourceCommit':coverage['syncCommit'],'system':coverage['system'],'result':status,'finding':'INBOX_RETRY_BLOCKS_OTHER_SESSION' if results['progress']['result']=='FAIL' else None,'expandedFindings':results['expanded']['findings'],'profiles':results,'limits':coverage['limits']}
 (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 print('Overall verification:',status,'— current-code findings remain open.' if status=='FAIL' else '',flush=True)
 return 2 if expanded_run.returncode==2 else 1 if status=='FAIL' else 0
if __name__=='__main__':
 try:sys.exit(main())
 except (RuntimeError,subprocess.SubprocessError,OSError,ValueError) as error:
  print('Verification could not complete:',str(error),file=sys.stderr);sys.exit(2)
