import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/dispatch.mjs';

test('dispatch returns real runtime result and preserves the request id', async () => {
  const events = [];
  await createDispatcher({ping: () => true}, e => events.push(e))({id:'a',method:'ping'});
  assert.deepEqual(events, [{type:'reply',id:'a',value:true}]);
});
test('unknown commands cannot invoke writes or inherited properties', async () => {
  let writes = 0;
  const events = [];
  const dispatch = createDispatcher({sendTurn: () => writes++}, e => events.push(e));
  await dispatch({id:'a',method:'sendTurn'});
  await dispatch({id:'b',method:'constructor'});
  assert.equal(writes, 0);
  assert.deepEqual(events.map(e => e.error), ['unsupported_command','unsupported_command']);
});
test('JS rejection becomes a bounded error without leaking exception text', async () => {
  const events = [];
  await createDispatcher({ping: () => { throw Error('private token'); }}, e => events.push(e))({id:'a',method:'ping'});
  assert.deepEqual(events,[{type:'reply',id:'a',error:'runtime_command_failed'}]);
});
test('diagnostic commands are absent without a debug provider', async () => {
  const events = [];
  await createDispatcher({}, e => events.push(e))({id:'a',method:'compatibility'});
  assert.equal(events[0].error,'unsupported_command');
});

test('cancellation suppresses a late reply and aborts a cooperative operation', async () => {
  const events=[]; let finish; let signal;
  const dispatch=createDispatcher({},e=>events.push(e),{slow: s=>{signal=s;return new Promise(r=>finish=r)}});
  const operation=dispatch({id:'slow-1',method:'slow'});
  await dispatch({id:'cancel-1',method:'$cancel',args:['slow-1']});
  finish('late'); await operation;
  assert.deepEqual(events,[]);
  assert.equal(signal.aborted,true);
});
test('malformed arguments cannot call the runtime', async () => {
  let calls=0;const events=[];
  const dispatch=createDispatcher({ping:()=>{calls++;return true}},e=>events.push(e));
  await dispatch({id:'bad',method:'ping',args:['unexpected']});
  assert.equal(calls,0);
  assert.equal(events[0].error,'invalid_arguments');
});

test('saturated queries leave control capacity for heartbeat and suspension', async()=>{
  const events=[];const pending=[];
  const dispatch=createDispatcher({ping:()=>true,setActive:()=>true},e=>events.push(e),{wait:()=>new Promise(r=>pending.push(r))});
  const calls=Array.from({length:32},(_,i)=>dispatch({id:`q-${i}`,method:'wait'}));
  await dispatch({id:'health',method:'ping'});
  await dispatch({id:'background',method:'setActive',args:[false]});
  assert.equal(events.find(e=>e.id==='health')?.value,true);
  assert.equal(events.find(e=>e.id==='background')?.value,true);
  assert.equal(events.filter(e=>e.error==='too_many_commands').length,2);
  pending.forEach(r=>r(true));await Promise.all(calls);
});
