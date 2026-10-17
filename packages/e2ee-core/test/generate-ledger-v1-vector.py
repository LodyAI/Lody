"""Frozen ledger v1 vector: Python hashlib SHA256 and PyNaCl==1.6.2 Ed25519.

No production encoder or noble implementation is used here. The output is a
compatibility contract. After the production freeze (the first production
creation, see specs/e2ee-foundations.md) never regenerate it: a failing vector
test then means the change breaks ledgers that already exist. Before the freeze,
regenerate it only in an owner-approved format change.
"""
import hashlib
import json

from nacl.signing import SigningKey


def head(major, length):
    if length < 24:
        return bytes([major << 5 | length])
    for info, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
        if length < 1 << (8 * size):
            return bytes([major << 5 | info]) + length.to_bytes(size, 'big')
    raise ValueError(length)


def cbor(value):
    """Deterministic CBOR subset used by ledger v1: uint, bytes, null, arrays."""
    if value is None:
        return b'\xf6'
    if isinstance(value, int):
        return head(0, value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(cbor(item) for item in value)
    raise TypeError(value)


def domain(name):
    return b'lody-e2ee/' + name.encode() + b'\0'


def filled(n, size=32):
    return bytes([n]) * size


class Device:
    def __init__(self, n):
        self.key = SigningKey(filled(n))
        self.pk = bytes(self.key.verify_key)
        self.enc = filled(n + 100)

    def sign(self, message):
        return self.key.sign(message).signature


def record_hash(record):
    return hashlib.sha256(domain('rec/v1') + record).digest()


def signed(body, signer):
    return cbor([body, signer.sign(domain('sig/v1') + cbor(body))])


owner, bob, carol, phone = Device(1), Device(2), Device(3), Device(4)
membership = {name: filled(n, 16) for name, n in (('owner', 10), ('bob', 11), ('carol', 12))}
genesis = signed([1, owner.pk, filled(10), membership['owner'], owner.enc, filled(20)], owner)
anchor = record_hash(genesis)
records = [genesis]


def append(signer, operation):
    records.append(signed([record_hash(records[-1]), signer.pk, operation], signer))


def join(target, n):
    body = [filled(n, 16), filled(n), target.pk, target.enc, None]
    return body + [target.sign(domain('join/v1') + cbor([anchor] + body))]


append(owner, [1, membership['bob'], join(bob, 2)])
append(owner, [3, membership['bob'], 1])
possession = phone.sign(domain('possess/v2') + cbor([anchor, membership['owner'], phone.pk, phone.enc, 0]))
append(owner, [4, 0, phone.pk, phone.enc, possession])
append(bob, [7, 1, filled(21), filled(0x31, 72)])
append(owner, [5, phone.pk])
append(owner, [8, membership['bob'], 2, filled(22), filled(0x32, 72)])
append(owner, [1, membership['carol'], join(carol, 3)])
append(owner, [6, membership['carol']])
append(carol, [9, [1]])

print(json.dumps({
    'source': 'Python hashlib SHA256 and PyNaCl 1.6.2 Ed25519; independent ledger v1 encoding',
    'anchor': anchor.hex(),
    'records': [{'hex': record.hex(), 'hash': record_hash(record).hex()} for record in records],
    'expected': {
        'verifiedLength': 9,
        'failure': {'code': 'upgrade-required', 'position': 9},
        'owner': membership['carol'].hex(),
        'members': {
            membership['owner'].hex(): {'userId': filled(10).hex(), 'role': 'admin'},
            membership['carol'].hex(): {'userId': filled(3).hex(), 'role': 'owner'},
        },
        'devices': {
            owner.pk.hex(): {'membershipId': membership['owner'].hex(), 'kind': 'personal'},
            carol.pk.hex(): {'membershipId': membership['carol'].hex(), 'kind': 'personal'},
        },
        'epoch': {'number': 2, 'keyCommitment': filled(22).hex(), 'rotationRequired': False},
    },
}, indent=2))
