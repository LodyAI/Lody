import { createServer } from 'node:http';
import { RTCPeerConnection } from 'werift';
import { WebSocketServer } from 'ws';

// Loopback-only synthetic CLI gateway and fallback endpoint. `/native/` answers
// with werift, the CLI gateway's WebRTC stack, over real DTLS/SCTP. No Simulator,
// account, credentials, tunnel or external service is contacted by these checks.
const stats = {
  sockets: [],
  controls: [],
  inputs: [],
  redirects: 0,
  hanging: 0,
  rtcCommands: 0,
};
const waiting = [];
const FRAME = Buffer.from(Array.from({ length: 40_000 }, (_, i) => i % 251));

function chunk(bytes, total, offset) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(total, 0);
  header.writeUInt32BE(offset, 4);
  return Buffer.concat([header, bytes]);
}

async function answer(offer) {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const channels = {};
  let ready = false;
  let framesSent = false;
  const send = (object) => channels.control.send(JSON.stringify(object));
  const opened = () => {
    if (ready || channels.media?.readyState !== 'open') return;
    if (channels.control?.readyState !== 'open') return;
    ready = true;
    send({ type: 'rtc-ready' });
  };
  peer.onDataChannel.subscribe((channel) => {
    channels[channel.label] = channel;
    channel.stateChanged.subscribe(opened);
    opened();
    channel.onMessage.subscribe((data) => {
      const object = JSON.parse(data.toString());
      if (object.type === 'heartbeat' && !framesSent) {
        framesSent = true;
        for (let offset = 0; offset < FRAME.length; offset += 12_000) {
          const part = FRAME.subarray(offset, offset + 12_000);
          channels.media.send(chunk(part, FRAME.length, offset));
        }
      }
      if (object.requestId) {
        stats.rtcCommands++;
        // Executed, but its reply is lost. The client must not replay on fallback.
        if (object.control.button === 'lock') peer.close();
        else
          send({
            type: 'rtc-control-result',
            requestId: object.requestId,
            success: true,
          });
      }
    });
  });
  await peer.setRemoteDescription({ type: 'offer', sdp: offer });
  await peer.setLocalDescription(await peer.createAnswer());
  if (peer.iceGatheringState !== 'complete') {
    await new Promise((resolve) =>
      peer.iceGatheringStateChange.subscribe(
        (state) => state === 'complete' && resolve(),
      ),
    );
  }
  return peer.localDescription.sdp;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/stats') return res.end(JSON.stringify(stats));
  if (url.pathname.startsWith('/native/')) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (
      url.searchParams.get('token') !== 'synthetic' ||
      req.headers.origin !== origin
    ) {
      res.writeHead(403);
      return res.end('{}');
    }
    if (url.pathname === '/native/rtc-config')
      return res.end('{"iceServers":[]}');
    if (url.pathname === '/native/rtc' && req.method === 'POST') {
      let body = '';
      for await (const part of req) body += part;
      const offer = JSON.parse(body);
      if (offer.codec !== 'h264') {
        res.writeHead(400);
        return res.end('{}');
      }
      return res.end(JSON.stringify({ sdp: await answer(offer.sdp) }));
    }
  }
  if (url.pathname.endsWith('/control')) {
    stats.controls.push(url.pathname);
    return res.end('{"success":true}');
  }
  if (url.pathname === '/leak') stats.redirects++;
  if (url.pathname.startsWith('/hanging/')) {
    stats.hanging++;
    waiting.splice(0).forEach((response) => response.end('{}'));
    return;
  }
  if (url.pathname === '/await-hanging') {
    if (stats.hanging) return res.end('{}');
    waiting.push(res);
    return;
  }
  if (url.pathname.startsWith('/redirect/')) {
    res.writeHead(302, { Location: '/leak' });
    return res.end();
  }
  if (url.pathname.startsWith('/malformed/')) {
    return res.end('{"iceServers":[{"urls":["https://invalid.example"]}]}');
  }
  res.writeHead(404);
  res.end('{}');
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('token') !== 'synthetic') {
    socket.close(1008);
    return;
  }
  stats.sockets.push(url.pathname);
  socket.send('fallback-ready');
  socket.on('message', (data) => {
    stats.inputs.push(JSON.parse(data.toString()));
    socket.send(data, { binary: false });
  });
});
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
