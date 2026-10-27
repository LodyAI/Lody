"""Synthetic existing-content-v0 vectors; Python HMAC + PyNaCl, no TS imports.

These opaque payloads specify no application RPC/presence schema or authority.
The Ed25519 seed is RFC 8032 section 7.1's public test input, never a real key.
"""
import hmac
import json
import struct

from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt
from nacl.signing import SigningKey

seed = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
signer = SigningKey(seed)
public_key = bytes(signer.verify_key)
epoch_key = bytes([7]) * 32
nonce = bytes([0x22]) * 24
genesis = bytes([0x11]) * 32
epoch = 0x01020304
resource = b'realtime-target-a'
plaintext = b'synthetic realtime content v0'
document_context = genesis + struct.pack('>IHH', epoch, 0, len(resource)) + resource
header = bytes([0]) + struct.pack('>IH', epoch, 0) + public_key
prk = hmac.digest(b'lody-content-hkdf/v0\0', epoch_key, 'sha256')
cases = []
for purpose, code in [('presence', 7), ('rpc-request', 8), ('rpc-response', 9)]:
    context = document_context + bytes([code])
    info = b'lody-content-key/v0\0' + context
    key = hmac.digest(prk, info + b'\x01', 'sha256')
    for binding in [b'', bytes.fromhex('abcd')]:
        length_binding = struct.pack('>H', len(binding)) + binding
        aad_prefix = (b'lody-content-aad-bound/v0\0' + context + length_binding
                      if binding else b'lody-content-aad/v0\0' + context)
        ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(
            plaintext, aad_prefix + header, nonce, key)
        unsigned = header + nonce + ciphertext
        signature_prefix = (b'lody-content-signature-bound/v0\0' + context + length_binding
                            if binding else b'lody-content-signature/v0\0' + context)
        signature = signer.sign(signature_prefix + unsigned).signature
        cases.append(dict(purpose=purpose, binding=binding.hex(),
                          frame=(unsigned + signature).hex()))
print(json.dumps(dict(
    source='Python stdlib RFC5869 HMAC-SHA256; PyNaCl libsodium XChaCha20-Poly1305 and Ed25519; independently encoded existing content-v0 bytes',
    genesis=genesis.hex(), epoch=epoch, resource=resource.decode('ascii'),
    seed=seed.hex(), publicKey=public_key.hex(), epochKey=epoch_key.hex(),
    nonce=nonce.hex(), plaintext=plaintext.hex(), cases=cases,
), indent=2))
