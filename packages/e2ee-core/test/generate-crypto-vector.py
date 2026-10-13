"""Regenerate synthetic v0 vectors with Python HMAC and PyNaCl==1.6.2.

No production encoder or noble implementation is used here.
"""
import hmac
import json
import struct

from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt

secret = bytes([7]) * 32
nonce = bytes([0x22]) * 24
context = bytes([0x11]) * 32 + struct.pack('>IHH', 0x01020304, 0, 3) + b'doc'
prefix = bytes([0]) + struct.pack('>IH', 0x01020304, 0) + bytes.fromhex(
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'
)
prk = hmac.digest(b'lody-content-hkdf/v0\0', secret, 'sha256')
cases = []
for purpose, code in [('doc-update', 1), ('doc-snapshot', 2), ('blob', 5), ('presence', 7)]:
    for binding in [b'', bytes.fromhex('abcd')]:
        authenticated_context = context + bytes([code])
        info = (b'lody-document-key/v0\0' + context if code <= 4
                else b'lody-content-key/v0\0' + authenticated_context)
        # RFC5869 extract above; 32-byte output uses exactly one expand block.
        key = hmac.digest(prk, info + b'\x01', 'sha256')
        aad = (b'lody-content-aad-bound/v0\0' + authenticated_context
               + struct.pack('>H', len(binding)) + binding if binding
               else b'lody-content-aad/v0\0' + authenticated_context) + prefix
        plaintext = b'synthetic content v0'
        ciphertext = crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, nonce, key)
        cases.append(dict(purpose=purpose, binding=binding.hex(), key=key.hex(),
                          plaintext=plaintext.hex(), ciphertext=ciphertext.hex()))
print(json.dumps(dict(
    source='Python stdlib HMAC-SHA256 RFC5869 extract/one-block expand; PyNaCl 1.6.2 libsodium XChaCha20-Poly1305; independently encoded v0 context/header/AAD',
    nonce=nonce.hex(), cases=cases,
), indent=2))
