import type { LookupFunction } from 'node:net';

// Browser engines resolve *.localhost to loopback; Node's OS resolver may not.
// Test clients use this lookup without changing target-side DNS behavior.
export const previewTestLookup: LookupFunction = (hostname, options, callback) => {
  if (hostname !== 'localhost' && !/^lody-[0-9a-f]{32}\.localhost$/.test(hostname)) {
    callback(new Error(`Unexpected test hostname: ${hostname}`), []);
    return;
  }
  callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
};
