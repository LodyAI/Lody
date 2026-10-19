"""Fixed public synthetic vectors; Python SHA256 and PyNaCl 1.6.2, no core/noble."""
import hashlib
import json
import struct
from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt

genesis = bytes([0x11])*32
previous = bytes([7])*32
current = bytes([8])*32
nonce = bytes([0x22])*24
epoch = struct.pack('>I', 1)
packet = nonce + crypto_aead_xchacha20poly1305_ietf_encrypt(
    previous, b'lody-e2ee/epoch-history/v1\0'+genesis+epoch, nonce, current)
print(json.dumps({
    'source': 'Python hashlib SHA256 and PyNaCl 1.6.2 libsodium XChaCha20-Poly1305; independent ledger v1 encoding',
    'genesis': genesis.hex(), 'previous': previous.hex(), 'current': current.hex(),
    'nonce': nonce.hex(), 'packet': packet.hex(),
    'commitment0': hashlib.sha256(b'lody-e2ee/epoch-key/v1\0'+previous).hexdigest(),
    'commitment1': hashlib.sha256(b'lody-e2ee/epoch-key/v1\0'+genesis+epoch+current).hexdigest(),
}, indent=2))
