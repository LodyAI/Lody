#!/usr/bin/env python3
"""Independent generator for test/pairing-vector.json.

Uses only the Python standard library: its own minimal deterministic CBOR
encoder, Crockford base32, HKDF-SHA256 and HMAC-SHA256, so the vector does not
come from the TypeScript implementation it checks. Synthetic inputs only.
"""
import hashlib
import hmac
import json
import pathlib

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def cbor_head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([(major << 5) | value])
    for size, marker in ((1, 24), (2, 25), (4, 26), (8, 27)):
        if value < 1 << (8 * size):
            return bytes([(major << 5) | marker]) + value.to_bytes(size, "big")
    raise ValueError("too large")


def cbor(value) -> bytes:
    if isinstance(value, bool):
        raise TypeError("no booleans")
    if isinstance(value, int):
        if value < 0:
            raise ValueError("no negatives")
        return cbor_head(0, value)
    if isinstance(value, bytes):
        return cbor_head(2, len(value)) + value
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return cbor_head(3, len(raw)) + raw
    if isinstance(value, list):
        return cbor_head(4, len(value)) + b"".join(cbor(item) for item in value)
    raise TypeError(type(value))


def hkdf(ikm: bytes, salt: bytes, info: bytes, length: int) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


def encode_secret(secret: bytes) -> str:
    value = int.from_bytes(secret, "big")  # version 0 occupies the top two bits
    body = "".join(ALPHABET[(value >> (5 * (25 - i))) & 31] for i in range(26))
    check = hashlib.sha256(b"lody-e2ee/pair-check/v1\0" + b"\x00" + secret).digest()
    bits = (check[0] << 2) | (check[1] >> 6)
    return body + ALPHABET[bits >> 5] + ALPHABET[bits & 31]


secret = bytes(range(0xA0, 0xB0))
salt = b"lody-e2ee/pair/v1\0"
lookup = hkdf(secret, salt, b"lookup", 16)
request_key = hkdf(secret, salt, b"request-mac", 32)
approval_key = hkdf(secret, salt, b"approval-mac", 32)

rows = sorted(
    [
        [bytes([0x22]) * 32, bytes([0x23]) * 32, bytes([0x24]) * 32, bytes([0x25]) * 64, bytes([0x26]) * 32],
        [bytes([0x11]) * 32, bytes([0x12]) * 32, bytes([0x13]) * 32, bytes([0x14]) * 64, bytes([0x15]) * 32],
    ],
    key=lambda row: row[0],
)
request = cbor(
    [
        "lody-e2ee/pair-request/v1",
        "synthetic-account",
        lookup,
        "requester-shows",
        "Synthetic laptop",
        1_800_000_600_000,
        rows,
    ]
)
request_digest = hashlib.sha256(request).digest()
request_tag = hmac.new(request_key, request, hashlib.sha256).digest()
approval_rows = sorted(
    [
        [bytes([0x22]) * 32, bytes([0x27]) * 32, bytes([0x28]) * 32],
        [bytes([0x11]) * 32, bytes([0x16]) * 32, bytes([0x17]) * 32],
    ],
    key=lambda row: row[0],
)
approval = cbor(
    ["lody-e2ee/pair-approval/v1", request_digest, bytes([0x33]) * 32, approval_rows]
)
approval_tag = hmac.new(approval_key, approval, hashlib.sha256).digest()

vector = {
    "secret": secret.hex(),
    "string": encode_secret(secret),
    "lookupId": lookup.hex(),
    "requestKey": request_key.hex(),
    "approvalKey": approval_key.hex(),
    "requestBytes": request.hex(),
    "requestDigest": request_digest.hex(),
    "requestTag": request_tag.hex(),
    "approvalBytes": approval.hex(),
    "approvalTag": approval_tag.hex(),
}
path = pathlib.Path(__file__).with_name("pairing-vector.json")
path.write_text(json.dumps(vector, indent=2) + "\n")
print(json.dumps(vector, indent=2))
