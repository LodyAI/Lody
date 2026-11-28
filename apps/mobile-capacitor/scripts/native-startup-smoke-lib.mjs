import http from 'node:http';

export const FATAL_STARTUP_MARKERS = [
  'Lody is taking too long to open',
  'Lody could not start',
  'Something went wrong!',
];

export const DEFAULT_PLACEHOLDER_ENV = {
  LODY_ENV: 'production',
  LODY_PLATFORM: 'cloud',
  VITE_LODY_PLATFORM: 'cloud',
  VITE_CONVEX_SITE_URL: 'https://placeholder.convex.site',
  VITE_CONVEX_DEPLOY_URL: 'https://placeholder.convex.cloud',
  VITE_SERVER_URL: 'https://placeholder.lody.ai',
  VITE_SITE_URL: 'https://placeholder.lody.ai',
};

const DEFAULT_REDIRECT_ORIGINS = [
  'https://placeholder.convex.site',
  'https://placeholder.convex.cloud',
  'https://placeholder.lody.ai',
];

function tryExtractOrigin(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

export function collectRedirectOrigins(env = process.env) {
  const origins = new Set(DEFAULT_REDIRECT_ORIGINS);
  for (const key of [
    'VITE_CONVEX_SITE_URL',
    'VITE_CONVEX_DEPLOY_URL',
    'VITE_SERVER_URL',
    'VITE_SITE_URL',
    'LODY_AUTH_SITE_URL',
    'LODY_AUTH_URL',
    'LODY_SERVER_URL',
  ]) {
    const origin = tryExtractOrigin(env[key]);
    if (origin) origins.add(origin);
  }
  return Array.from(origins);
}

export function buildPlaceholderBuildEnv(env = process.env) {
  const next = { ...env };
  for (const [key, fallback] of Object.entries(DEFAULT_PLACEHOLDER_ENV)) {
    if (!next[key] || String(next[key]).trim().length === 0) {
      next[key] = fallback;
    }
  }
  return next;
}

export function buildSmokeProbeScript({ stubOrigin, redirectOrigins = [] }) {
  const configJson = JSON.stringify({ stubOrigin, redirectOrigins });
  return `(function(){
var cfg=${configJson};
var stubOrigin=cfg.stubOrigin;
var redirectSet=new Set(cfg.redirectOrigins||[]);
var origFetch=typeof window.fetch==='function'?window.fetch.bind(window):null;
var lastSnapshotKey='';
var settledSent=false;
function describeErr(val){
  if(!val)return 'Unknown error';
  if(typeof val==='string')return val;
  var head=val.message?(val.name?val.name+': '+val.message:String(val.message)):'';
  var stack=val.stack?String(val.stack):'';
  if(head&&stack)return stack.indexOf(val.message)!==-1?stack:head+'\\n'+stack;
  if(head)return head;
  if(stack)return stack;
  try{return JSON.stringify(val);}catch(e){return String(val);}
}
function sendEvent(payload){
  if(!origFetch)return;
  try{
    origFetch(stubOrigin+'/__smoke__/event',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload),
    }).catch(function(){});
  }catch(e){}
}
function shouldRedirect(url){
  if(url.origin===stubOrigin)return false;
  if(url.pathname.indexOf('/api/auth/')===0||url.pathname==='/api/time')return true;
  if(redirectSet.has(url.origin))return true;
  if(url.protocol==='https:'&&url.hostname.slice(-12)==='.convex.site')return true;
  return false;
}
if(origFetch){
  window.fetch=function(input,init){
    try{
      var rawUrl=typeof input==='string'?input:(input&&typeof input.url==='string'?input.url:String(input));
      var parsed=new URL(rawUrl,window.location.href);
      if(shouldRedirect(parsed)){
        var targetUrl=stubOrigin+parsed.pathname+parsed.search;
        if(typeof Request!=='undefined'&&input instanceof Request){
          return origFetch(new Request(targetUrl,input),init);
        }
        return origFetch(targetUrl,init);
      }
    }catch(e){}
    return origFetch(input,init);
  };
}
window.addEventListener('error',function(ev){
  sendEvent({
    type:'error',
    message:ev&&(ev.error?describeErr(ev.error):ev.message)||'Window error',
    filename:ev&&ev.filename||'',
    lineno:ev&&ev.lineno||0,
  });
});
window.addEventListener('unhandledrejection',function(ev){
  sendEvent({
    type:'unhandledrejection',
    message:describeErr(ev&&ev.reason),
  });
});
function hookBootGuard(){
  var guard=window.__LODY_BOOT__;
  if(!guard||guard.__smokeHooked||typeof guard.fail!=='function')return;
  guard.__smokeHooked=true;
  var origFail=guard.fail.bind(guard);
  guard.fail=function(err){
    sendEvent({type:'boot_failed',message:describeErr(err)});
    return origFail(err);
  };
}
hookBootGuard();
function emitSnapshot(kind){
  hookBootGuard();
  var cap=window.Capacitor;
  var isNative=Boolean(cap&&typeof cap.isNativePlatform==='function'&&cap.isNativePlatform());
  var platform=cap&&typeof cap.getPlatform==='function'?String(cap.getPlatform()):'unknown';
  var booted=Boolean(window.__LODY_BOOT__&&window.__LODY_BOOT__.booted);
  var pathname=window.location&&window.location.pathname?String(window.location.pathname):'';
  var bodyText=document.body&&typeof document.body.innerText==='string'?document.body.innerText.trim().slice(0,1200):'';
  var interactiveCount=document.querySelectorAll('button, input, a').length;
  var key=[kind,isNative,platform,booted,pathname,interactiveCount,bodyText.slice(0,180)].join('|');
  if(kind==='snapshot'&&key===lastSnapshotKey)return;
  lastSnapshotKey=key;
  sendEvent({
    type:kind,
    isNative:isNative,
    platform:platform,
    booted:booted,
    pathname:pathname,
    interactiveCount:interactiveCount,
    bodyText:bodyText,
  });
  if(!settledSent&&kind==='snapshot'&&booted&&pathname.indexOf('/login')===0&&interactiveCount>=1&&bodyText.length>=20){
    settledSent=true;
    var rAF=typeof window.requestAnimationFrame==='function'?window.requestAnimationFrame.bind(window):function(cb){setTimeout(cb,16);};
    rAF(function(){
      setTimeout(function(){emitSnapshot('settled');},250);
    });
  }
}
sendEvent({type:'probe_loaded',href:String(window.location&&window.location.href||'')});
var observer=new MutationObserver(function(){emitSnapshot('snapshot');});
if(document.documentElement){
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
}
window.addEventListener('load',function(){emitSnapshot('snapshot');});
window.addEventListener('popstate',function(){emitSnapshot('snapshot');});
window.addEventListener('hashchange',function(){emitSnapshot('snapshot');});
setInterval(function(){emitSnapshot('snapshot');},250);
})();`;
}

export function injectSmokeProbeHtml(html, probeScript) {
  const tag = `<script data-lody-smoke-probe="1">${probeScript}</script>`;
  const headCloseIdx = html.indexOf('</head>');
  if (headCloseIdx !== -1) {
    return `${html.slice(0, headCloseIdx)}${tag}\n${html.slice(headCloseIdx)}`;
  }
  const moduleScriptIdx = html.indexOf('<script type="module"');
  if (moduleScriptIdx !== -1) {
    return `${html.slice(0, moduleScriptIdx)}${tag}\n${html.slice(moduleScriptIdx)}`;
  }
  throw new Error(
    'Could not find </head> or module script tag in index.html for smoke probe injection'
  );
}

export function findFatalStartupMarker(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) return null;
  for (const marker of FATAL_STARTUP_MARKERS) {
    if (bodyText.includes(marker)) return marker;
  }
  return null;
}

export function evaluateAuthRequest(headers) {
  const capacitorOrigin = headers['capacitor-origin'] ?? null;
  const betterAuthCookie = headers['better-auth-cookie'] ?? null;
  if (capacitorOrigin !== 'lody://') {
    return {
      ok: false,
      reason: `Expected capacitor-origin: lody:// on /api/auth/get-session, got ${JSON.stringify(capacitorOrigin)}`,
    };
  }
  if (betterAuthCookie !== null) {
    return {
      ok: false,
      reason: `Unexpected better-auth-cookie header on native /api/auth/get-session (crossDomainClient leaked into native runtime)`,
    };
  }
  return { ok: true, reason: null };
}

export function isSnapshotLoginReady(snapshot, expectedPlatform) {
  if (!snapshot) return false;
  if (snapshot.isNative !== true) return false;
  if (expectedPlatform && snapshot.platform !== expectedPlatform) return false;
  if (snapshot.booted !== true) return false;
  if (typeof snapshot.pathname !== 'string' || !snapshot.pathname.startsWith('/login'))
    return false;
  if (typeof snapshot.bodyText !== 'string' || snapshot.bodyText.trim().length < 20) return false;
  if (findFatalStartupMarker(snapshot.bodyText)) return false;
  if (snapshot.bodyText.includes('Signing you in')) return false;
  if (Number(snapshot.interactiveCount ?? 0) < 1) return false;
  return true;
}

function parseVersionNumbers(text) {
  const match = String(text ?? '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersionDesc(a, b) {
  const va = parseVersionNumbers(a);
  const vb = parseVersionNumbers(b);
  for (let i = 0; i < 3; i += 1) {
    if (vb[i] !== va[i]) return vb[i] - va[i];
  }
  return 0;
}

function scoreIphoneDeviceType(deviceType) {
  const name = String(deviceType.name ?? '');
  if (!name.startsWith('iPhone')) return -1;
  if (name.includes('Duo')) return 10;
  if (name.includes('SE')) return 20;
  const genMatch = name.match(/iPhone\s+(\d+)/);
  const generation = genMatch ? Number(genMatch[1]) : 1;
  const variantBonus = name.endsWith('Pro') ? 3 : name.includes('Pro Max') ? 2 : 4;
  return 100 + generation * 10 + variantBonus;
}

export function selectIosSimulatorTarget(simctlData) {
  const runtimes = (simctlData?.runtimes ?? [])
    .filter(
      (rt) => rt.isAvailable !== false && String(rt.identifier ?? '').includes('SimRuntime.iOS-')
    )
    .sort((a, b) => compareVersionDesc(a.version || a.name, b.version || b.name));

  if (runtimes.length === 0) {
    throw new Error('No available iOS Simulator runtime found in `xcrun simctl list`');
  }

  const allDeviceTypes = simctlData?.devicetypes ?? [];
  for (const runtime of runtimes) {
    const candidates =
      Array.isArray(runtime.supportedDeviceTypes) && runtime.supportedDeviceTypes.length > 0
        ? runtime.supportedDeviceTypes
        : allDeviceTypes;
    const iphones = candidates
      .filter((dt) => String(dt.name ?? '').startsWith('iPhone'))
      .sort((a, b) => scoreIphoneDeviceType(b) - scoreIphoneDeviceType(a));
    if (iphones.length > 0) {
      return {
        runtimeId: runtime.identifier,
        runtimeName: runtime.name,
        deviceTypeId: iphones[0].identifier,
        deviceTypeName: iphones[0].name,
      };
    }
  }

  throw new Error('No compatible iPhone Simulator device type found for installed iOS runtimes');
}

export function parseSmokeCliArgs(argv) {
  const options = {
    skipBuild: false,
    skipSync: false,
    udid: null,
    serial: null,
    avd: null,
    apk: null,
    derivedData: null,
    configuration: 'Debug',
    timeoutMs: Number(process.env.LODY_MOBILE_SMOKE_TIMEOUT_MS || 60_000),
    artifactDir: process.env.LODY_MOBILE_SMOKE_ARTIFACT_DIR || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--skip-sync') options.skipSync = true;
    else if (arg === '--udid') options.udid = argv[++i] ?? null;
    else if (arg === '--serial') options.serial = argv[++i] ?? null;
    else if (arg === '--avd') options.avd = argv[++i] ?? null;
    else if (arg === '--apk') options.apk = argv[++i] ?? null;
    else if (arg === '--derived-data') options.derivedData = argv[++i] ?? null;
    else if (arg === '--configuration') options.configuration = argv[++i] ?? 'Debug';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--artifact-dir') options.artifactDir = argv[++i] ?? null;
    else throw new Error(`Unknown smoke CLI argument: ${arg}`);
  }
  return options;
}

export async function startSmokeStubServer({ expectedPlatform, timeoutMs = 60_000 } = {}) {
  const diagnostics = {
    expectedPlatform,
    probeLoaded: false,
    authRequests: [],
    otherRequests: [],
    snapshots: [],
    errors: [],
    unhandledRejections: [],
    bootFailures: [],
  };

  let settled = false;
  let resolveResult;
  let rejectResult;
  let timeoutTimer = null;

  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  function finishPass(snapshot) {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    resolveResult({
      ok: true,
      snapshot,
      diagnostics,
    });
  }

  function finishFail(reason) {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const error = new Error(reason);
    error.diagnostics = diagnostics;
    rejectResult(error);
  }

  function checkCompletion(eventType) {
    if (settled) return;
    if (diagnostics.errors.length > 0) {
      finishFail(
        `Uncaught WebView error during ${expectedPlatform} startup: ${diagnostics.errors[0].message}`
      );
      return;
    }
    if (diagnostics.unhandledRejections.length > 0) {
      finishFail(
        `Unhandled promise rejection during ${expectedPlatform} startup: ${diagnostics.unhandledRejections[0].message}`
      );
      return;
    }
    if (diagnostics.bootFailures.length > 0) {
      finishFail(
        `Boot guard reported startup failure on ${expectedPlatform}: ${diagnostics.bootFailures[0].message}`
      );
      return;
    }

    const latest = diagnostics.snapshots[diagnostics.snapshots.length - 1];
    if (latest) {
      const fatalMarker = findFatalStartupMarker(latest.bodyText);
      if (fatalMarker) {
        finishFail(
          `Rendered fatal startup error marker "${fatalMarker}" on ${expectedPlatform} at route ${latest.pathname}`
        );
        return;
      }
    }

    if (
      eventType === 'settled' &&
      diagnostics.authRequests.length >= 1 &&
      isSnapshotLoginReady(latest, expectedPlatform)
    ) {
      finishPass(latest);
    }
  }

  const server = http.createServer((req, res) => {
    const reqOrigin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, Better-Auth-Cookie, capacitor-origin, x-skip-oauth-proxy'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (parsedUrl.pathname === '/__smoke__/event' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        try {
          const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (event.type === 'probe_loaded') {
            diagnostics.probeLoaded = true;
          } else if (event.type === 'error') {
            diagnostics.errors.push(event);
          } else if (event.type === 'unhandledrejection') {
            diagnostics.unhandledRejections.push(event);
          } else if (event.type === 'boot_failed') {
            diagnostics.bootFailures.push(event);
          } else if (event.type === 'snapshot' || event.type === 'settled') {
            diagnostics.snapshots.push(event);
          }
          checkCompletion(event.type);
        } catch {
          return;
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/api/auth/get-session') {
      const check = evaluateAuthRequest(req.headers);
      diagnostics.authRequests.push({
        method: req.method,
        url: req.url,
        origin: req.headers.origin ?? null,
        capacitorOrigin: req.headers['capacitor-origin'] ?? null,
        betterAuthCookie: req.headers['better-auth-cookie'] ?? null,
        ok: check.ok,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('null');
      if (!check.ok) {
        finishFail(check.reason);
        return;
      }
      const latest = diagnostics.snapshots[diagnostics.snapshots.length - 1];
      if (latest?.type === 'settled') {
        checkCompletion('settled');
      }
      return;
    }

    if (parsedUrl.pathname === '/api/time') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ serverTime: Date.now() }));
      return;
    }

    diagnostics.otherRequests.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    getDiagnostics: () => diagnostics,
    waitForResult() {
      if (!timeoutTimer && !settled) {
        timeoutTimer = setTimeout(() => {
          const latest = diagnostics.snapshots[diagnostics.snapshots.length - 1];
          const detail = latest
            ? `last snapshot: platform=${latest.platform} isNative=${latest.isNative} booted=${latest.booted} route=${latest.pathname} authRequests=${diagnostics.authRequests.length} body=${JSON.stringify(latest.bodyText?.slice(0, 200))}`
            : `probeLoaded=${diagnostics.probeLoaded} authRequests=${diagnostics.authRequests.length} (no snapshots received)`;
          finishFail(
            `Timed out after ${timeoutMs}ms waiting for ${expectedPlatform} startup (${detail})`
          );
        }, timeoutMs);
      }
      return resultPromise;
    },
    async close() {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
