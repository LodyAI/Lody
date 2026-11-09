// Synthetic, offline benchmark. Usage: node layout-bench.cjs /absolute/path/to/loro-crdt/nodejs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const entry = process.argv[2];
const action = process.argv[3];
const median = a => [...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
if (!action) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loro-memory-layout-'));
  const run = args => {
    const child = spawnSync(process.execPath, ['--expose-gc', __filename, entry, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  try {
    const fixtures = run(['fixtures', dir]);
    const rows = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      for (const history of [0,100]) {
        for (const replicas of [1,100]) {
          // Reverse layout order on alternate rounds to reduce ordering bias.
          for (const layout of repeat % 2 ? ['split','single'] : ['single','split']) {
            rows.push({ repeat, ...run(['measure', dir, layout, String(history), String(replicas)]) });
          }
        }
      }
    }
    const selective=[];
    for(let repeat=0;repeat<5;repeat++)for(const layout of ['single','split'])selective.push({repeat,...run(['one',dir,layout,'0','100'])});
    const summary = [];
    for (const history of [0,100]) for (const replicas of [1,100]) for (const layout of ['single','split']) {
      const group = rows.filter(x=>x.history===history && x.replicas===replicas && x.layout===layout);
      const record={layout,history,replicas};
      for (const key of Object.keys(group[0])) if (key.endsWith('Ms') || key.endsWith('Bytes')) record[key]=median(group.map(x=>x[key]));
      summary.push(record);
    }
    console.log(JSON.stringify({environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0].model,loro:'1.17.0'},protocol:{documentsPerMemory:10,charactersPerDocument:4000,utf8BytesPerDocument:12000,independentProcessesPerCase:5,searchWarmups:10,searchSamples:100,updateRounds:100,updatePerRound:'replace first four characters of all ten documents, commit each physical Doc',history:'100 rounds = 1000 text replacements before snapshot',replicas:'100 independent logical memories for amortized retained-memory measurement'},fixtures,summary,selective,raw:rows},null,2));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  return;
}
const {LoroDoc,LoroMap,LoroText}=require(entry);
// Diagnostic only: reserved WASM linear memory capacity, NOT live allocation bytes.
const wasm=require(path.join(entry,'loro_wasm.js')).__wasm;
function mem(){ global.gc();global.gc();return {rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,wasm:wasm.memory.buffer.byteLength}; }
function textFor(i){let seed=12345+i;let s='';for(let j=0;j<4000;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;s+=String.fromCharCode(0x4e00+seed%1500);}if(i%5===0)s=s.slice(0,2000)+'记忆检索'+s.slice(2004);assert.equal(s.length,4000);assert.equal(Buffer.byteLength(s),12000);return s;}
function create(layout){const docs=Array.from({length:layout==='single'?1:10},()=>new LoroDoc());for(let i=0;i<10;i++){const root=docs[layout==='single'?0:i].getMap('documents');const m=root.setContainer('d'+i,new LoroMap());m.set('path','topics/'+i+'.md');const body=m.setContainer('body',new LoroText());body.insert(0,textFor(i));body.free();m.free();root.free();}for(const d of docs)d.commit();return docs;}
function update(docs,layout,round){for(let i=0;i<10;i++){const root=docs[layout==='single'?0:i].getMap('documents');const m=root.get('d'+i);const body=m.get('body');body.delete(0,4);body.insert(0,round%2?'更新内容':'修改内容');body.free();m.free();root.free();}for(const d of docs)d.commit();}
function search(docs){return docs.flatMap(d=>d.JSONPath('$.documents[?(@.body contains "记忆检索")].path')).sort();}
function readOne(docs){const root=docs[0].getMap('documents');const m=root.get('d0');const body=m.get('body');const s=body.toString();body.free();m.free();root.free();assert.equal(s.length,4000);}
function close(docs){for(const d of docs)d.free();}
const dir=process.argv[4];
if(action==='fixtures'){
 const out=[];
 for(const layout of ['single','split'])for(const history of [0,100]){const docs=create(layout);for(let r=0;r<history;r++)update(docs,layout,r);let bytes=0;for(let i=0;i<docs.length;i++){const snapshot=docs[i].export({mode:'snapshot'});bytes+=snapshot.byteLength;fs.writeFileSync(path.join(dir,`${layout}-${history}-${i}`),snapshot);}out.push({layout,history,snapshotBytes:bytes});close(docs);}
 console.log(JSON.stringify(out));return;
}
const layout=process.argv[5],history=Number(process.argv[6]),replicas=Number(process.argv[7]);
// Input bytes are resident before baseline so import delta excludes snapshot file buffers.
const snapshots=Array.from({length:layout==='single'||action==='one'?1:10},(_,i)=>fs.readFileSync(path.join(dir,`${layout}-${history}-${i}`)));
const baseline=mem();
let collections=[];
let t=performance.now();
for(let r=0;r<replicas;r++)collections.push(snapshots.map(bytes=>{const d=new LoroDoc();d.import(bytes);return d;}));
const importMs=performance.now()-t;
const imported=mem();
t=performance.now();for(const docs of collections)readOne(docs);const readOneMs=performance.now()-t;
const oneRead=mem();
if(action==='one'){console.log(JSON.stringify({layout,replicas,importMs,readOneMs,readRssDeltaBytes:oneRead.rss-baseline.rss,readWasmDeltaBytes:oneRead.wasm-baseline.wasm}));for(const docs of collections)close(docs);return;}
t=performance.now();for(const docs of collections)assert.deepEqual(search(docs),['topics/0.md','topics/5.md']);const firstSearchMs=performance.now()-t;
const searched=mem();
let warmSearchMs=0,updateOneMs=0,updateRoundMs=0,exportMs=0,exportBytes=0;
if(replicas===1){
 const docs=collections[0];for(let i=0;i<10;i++)search(docs);const samples=[];
 for(let i=0;i<100;i++){t=performance.now();search(docs);samples.push(performance.now()-t);}warmSearchMs=median(samples);
 const singles=[];for(let i=0;i<100;i++){t=performance.now();const root=docs[0].getMap('documents');const m=root.get('d0');const body=m.get('body');body.delete(0,4);body.insert(0,i%2?'单篇更新':'单篇修改');body.free();m.free();root.free();docs[0].commit();singles.push(performance.now()-t);}updateOneMs=median(singles);
 const updates=[];for(let i=0;i<100;i++){t=performance.now();update(docs,layout,i);updates.push(performance.now()-t);}updateRoundMs=median(updates);
 assert.deepEqual(search(docs),['topics/0.md','topics/5.md']);
 // Snapshot serialization only; no fsync or remote transport is included.
 t=performance.now();for(const d of docs)exportBytes+=d.export({mode:'snapshot'}).byteLength;exportMs=performance.now()-t;
}
const afterWork=mem();for(const docs of collections)close(docs);collections=[];const released=mem();
const result={layout,history,replicas,importMs,readOneMs,firstSearchMs,warmSearchMs,updateOneMs,updateRoundMs,exportMs,exportBytes,baselineRssBytes:baseline.rss};
for(const [name,snapshot] of Object.entries({imported,oneRead,searched,afterWork,released}))for(const key of ['rss','heap','wasm'])result[name+key[0].toUpperCase()+key.slice(1)+'DeltaBytes']=snapshot[key]-baseline[key];
console.log(JSON.stringify(result));
