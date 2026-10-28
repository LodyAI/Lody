"""Independent candidate M5 v0 body vectors. Run from any directory with Python 3."""
import hashlib
import json
from pathlib import Path
import struct


def text(value):
    raw = value.encode('ascii')
    return struct.pack('>H', len(raw)) + raw


def blob(raw):
    return struct.pack('>I', len(raw)) + raw


request_id = bytes(range(16))
request = b'\0' + request_id + struct.pack('>Q', 0x0102030405) + text('session/dispatch-turn') + blob(b'{ "sessionId": "synthetic" }')
digest = hashlib.sha256(bytes([0, 1, 2, 3])).digest()
error = text('permission_denied') + blob(b'{"reason":"synthetic"}')
prefix = b'\0' + request_id + digest
vectors = {
    'request': request.hex(),
    'progress': (prefix + b'\0' + struct.pack('>I', 0) + blob(b'{"accepted":true}')).hex(),
    'success': (prefix + b'\1' + struct.pack('>I', 0xffffffff) + blob(b'null')).hex(),
    'error': (prefix + b'\2' + struct.pack('>I', 0x01020304) + blob(error)).hex(),
    'errorPayload': error.hex(),
    'presence': (b'\0' + bytes(range(16, 32)) + struct.pack('>IQQ', 0x01020304, 0x0102030405, 0x0102030405 + 60_000) + blob(bytes([0, 255]))).hex(),
    'digest': digest.hex(),
}
Path(__file__).with_name('e2ee-wire-v0.json').write_text(json.dumps(vectors, indent=2) + '\n')
