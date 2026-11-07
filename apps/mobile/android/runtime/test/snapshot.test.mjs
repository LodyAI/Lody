import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { verifySnapshot } from '../snapshot.mjs';
test('source snapshot remains unchanged and detects modified or extra files', async()=>{
  const manifest=JSON.parse(await readFile(new URL('../vendor/SHA256.json',import.meta.url),'utf8'));
  assert.equal(await verifySnapshot(),Object.keys(manifest).length);
  const directory=await mkdtemp(path.join(tmpdir(),'lody-snapshot-'));
  try {
    await cp(new URL('../vendor/cloud-runtime',import.meta.url),directory,{recursive:true});
    await writeFile(path.join(directory,'unexpected.txt'),'drift');
    await assert.rejects(verifySnapshot(directory),/snapshot drift/);
    await rm(path.join(directory,'unexpected.txt'));
    await writeFile(path.join(directory,'LICENSE'),'modified');
    await assert.rejects(verifySnapshot(directory),/snapshot drift/);
  } finally {await rm(directory,{recursive:true,force:true});}
});
