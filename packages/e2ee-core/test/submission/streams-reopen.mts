import {Effect, Result} from 'effect';
import {StreamsClient} from '@loro-dev/streams-client';
import {Bytes} from '@lody/e2ee-core/protocol';
import {makeStreamsLedgerLog} from '@lody/e2ee-core/adapters/loro-streams';
import { LedgerLog } from '@lody/e2ee-core/services';
import { resumeSubmission } from './fixture';
import {sqliteSubmissionJournal} from '@lody/e2ee-core/adapters/node-sqlite';
const input=JSON.parse(process.argv[2]!);
const anchor=Result.getOrThrow(Bytes.genesisHash(Buffer.from(input.genesis,'hex')));
const result=await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const remote=yield*makeStreamsLedgerLog({genesis:anchor,stream:new StreamsClient({url:input.url,retry:{maxAttempts:1}}),checkpoint:()=>Effect.succeed({head:Result.getOrThrow(Bytes.recordHash(Buffer.from(input.head,'hex'))),length:input.count}),budget:{maxRecords:100,maxBytes:100000}});
 return yield*resumeSubmission(anchor).pipe(Effect.provideService(LedgerLog,remote),Effect.provide(sqliteSubmissionJournal({ path: input.path })));
})));
console.log(JSON.stringify({pid:process.pid,outcome:result?.outcome,record:result?Buffer.from(result.record).toString('hex'):null}));
