"""Independent RFC 9180 Base 0x0020/0x0001/0x0003 reference for test vectors.
Requires cryptography==46.0.5; no production HPKE package or CBOR encoder.
Run: python test/generate-hpke-vector.py > test/hpke-vector.json
"""
import hashlib
import hmac
import json
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305


def extract(salt, ikm):
    return hmac.new(salt or bytes(32), ikm, hashlib.sha256).digest()


def expand(prk, info, size):
    block, output = b"", b""
    for counter in range(1, (size + 31) // 32 + 1):
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        output += block
    return output[:size]


def le(suite, salt, label, ikm):
    return extract(salt, b"HPKE-v1" + suite + label + ikm)


def lx(suite, prk, label, info, size):
    return expand(prk, size.to_bytes(2, "big") + b"HPKE-v1" + suite + label + info, size)


def seal(sk_r, ikm_e, info, aad, plaintext):
    kem = b"KEM\x00\x20"
    dkp = le(kem, b"", b"dkp_prk", ikm_e)
    sk_e = X25519PrivateKey.from_private_bytes(lx(kem, dkp, b"sk", b"", 32))
    enc = sk_e.public_key().public_bytes_raw()
    pk_r = X25519PrivateKey.from_private_bytes(sk_r).public_key().public_bytes_raw()
    dh = sk_e.exchange(X25519PublicKey.from_public_bytes(pk_r))
    eae = le(kem, b"", b"eae_prk", dh)
    shared = lx(kem, eae, b"shared_secret", enc + pk_r, 32)
    suite = b"HPKE\x00\x20\x00\x01\x00\x03"
    ctx = b"\x00" + le(suite, b"", b"psk_id_hash", b"") + le(suite, b"", b"info_hash", info)
    secret = le(suite, shared, b"secret", b"")
    key = lx(suite, secret, b"key", ctx, 32)
    nonce = lx(suite, secret, b"base_nonce", ctx, 12)
    return pk_r, enc, ChaCha20Poly1305(key).encrypt(nonce, plaintext, aad)


rfc = {
    "source": "https://www.rfc-editor.org/rfc/rfc9180.html#appendix-A.2.1",
    "ikmE": "909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b",
    "skR": "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
    "pkR": "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
    "info": "4f6465206f6e2061204772656369616e2055726e",
    "aad": "436f756e742d30",
    "pt": "4265617574792069732074727574682c20747275746820626561757479",
    "enc": "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
    "ct": "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28",
}
assert tuple(x.hex() for x in seal(*(bytes.fromhex(rfc[k]) for k in ["skR", "ikmE", "info", "aad", "pt"]))) == tuple(rfc[k] for k in ["pkR", "enc", "ct"])
genesis = bytes(range(32))
sender = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
recipient = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
epoch = 256
# canonical fixed array [bstr32, uint256, bstr32, bstr32]
aad = b"\x84\x58\x20" + genesis + b"\x19\x01\x00\x58\x20" + sender + b"\x58\x20" + recipient
app = {"genesis": genesis.hex(), "epoch": epoch, "sender": sender.hex(), "recipient": recipient.hex(), "ikmE": rfc["ikmE"], "skR": rfc["skR"], "info": b"lody-e2ee/hpke-epoch/v1\0".hex(), "aad": aad.hex(), "pt": bytes(range(32, 64)).hex()}
app.update(zip(["pkR", "enc", "ct"], (x.hex() for x in seal(*(bytes.fromhex(app[k]) for k in ["skR", "ikmE", "info", "aad", "pt"])))))
print(json.dumps({"rfc": rfc, "epoch": app}, indent=2))
