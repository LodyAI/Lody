"""Frozen ledger v1 recovery-device vector: Python hashlib SHA256 and PyNaCl==1.6.2 Ed25519.

Independent of the production encoder and of generate-ledger-v1-vector.py, whose output
stays unchanged. It fixes the tag 4 kind=2 record, its possess/v2 proof bytes and the
replay state, plus records that ledger v1 must reject. The same freeze rule applies: after
the first production creation (specs/e2ee-foundations.md) never regenerate it.
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


class Wide(int):
    """An unsigned integer written with a one-byte argument even when it is below 24."""


def cbor(value):
    """Deterministic CBOR subset used by ledger v1: uint, bytes, null, arrays."""
    if value is None:
        return b'\xf6'
    if isinstance(value, Wide):
        return bytes([0x18, int(value)])
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


owner, machine, recovery, second_recovery, outsider = (
    Device(1), Device(5), Device(6), Device(9), Device(7))
machine_id = 'machine/é'
owner_membership = filled(10, 16)
genesis = signed([1, owner.pk, filled(10), owner_membership, owner.enc, filled(20)], owner)
anchor = record_hash(genesis)


def possession_bytes(target, genesis_hash=anchor, membership=owner_membership, kind=2):
    return domain('possess/v2') + cbor([genesis_hash, membership, target.pk, target.enc, kind])


def machine_record(parent):
    proof = machine.sign(domain('possess/v2') + cbor([
        anchor, owner_membership, machine.pk, machine.enc, 1, machine_id.encode('utf-8'),
    ]))
    return signed([parent, owner.pk, [4, 1, machine.pk, machine.enc, proof,
                                      machine_id.encode('utf-8'), None]], owner)


def recovery_body(parent, signer_pk, target, proof, kind=2, signing=None, encryption=None):
    return [parent, signer_pk, [4, kind, signing or target.pk, encryption or target.enc, proof]]


records = [genesis]
records.append(machine_record(record_hash(genesis)))
message = possession_bytes(recovery)
proof = recovery.sign(message)
records.append(signed(recovery_body(record_hash(records[-1]), owner.pk, recovery, proof), owner))
valid_parent = record_hash(records[1])


def negative(name, record, code, prefix=2):
    return {'name': name, 'prefixLength': prefix, 'hex': record.hex(), 'code': code}


def recovery_record(**changes):
    body = recovery_body(valid_parent, owner.pk, recovery, changes.pop('proof', proof),
                         kind=changes.pop('kind', 2), signing=changes.pop('signing', None),
                         encryption=changes.pop('encryption', None))
    signer = changes.pop('signer', owner)
    body[1] = changes.pop('signer_pk', signer.pk)
    assert not changes
    return signed(body, signer)


negatives = [
    negative('proof names another genesis', recovery_record(
        proof=recovery.sign(possession_bytes(recovery, genesis_hash=filled(0x55)))), 'bad-proof'),
    negative('proof names another membership', recovery_record(
        proof=recovery.sign(possession_bytes(recovery, membership=filled(11, 16)))), 'bad-proof'),
    negative('proof names a personal device', recovery_record(
        proof=recovery.sign(possession_bytes(recovery, kind=0))), 'bad-proof'),
    negative('record names a personal device', recovery_record(kind=0), 'bad-proof'),
    negative('record names another signing key', recovery_record(signing=outsider.pk),
             'bad-proof'),
    negative('record names another encryption key', recovery_record(encryption=filled(0x66)),
             'bad-proof'),
    negative('approved by a machine device', recovery_record(signer=machine), 'unauthorized'),
    negative('approved by a device outside the ledger', recovery_record(signer=outsider),
             'unauthorized'),
    negative('approval signed by another key', recovery_record(signer=outsider,
                                                               signer_pk=owner.pk),
             'bad-signature'),
    negative('approved by a recovery device', signed(recovery_body(
        record_hash(records[2]), recovery.pk, second_recovery,
        second_recovery.sign(possession_bytes(second_recovery))), recovery), 'unauthorized', 3),
    negative('noncanonical kind integer', recovery_record(kind=Wide(2)), 'canonical'),
    negative('truncated record', records[2][:-1], 'truncated'),
]

print(json.dumps({
    'source': 'Python hashlib SHA256 and PyNaCl 1.6.2 Ed25519; independent ledger v1 encoding',
    'anchor': anchor.hex(),
    'records': [{'hex': record.hex(), 'hash': record_hash(record).hex()} for record in records],
    'recovery': {
        'possessionSigningBytes': message.hex(),
        'possessionSignature': proof.hex(),
    },
    'expected': {
        'verifiedLength': 3,
        'devices': {
            owner.pk.hex(): {'membershipId': owner_membership.hex(), 'kind': 'personal'},
            machine.pk.hex(): {'membershipId': owner_membership.hex(), 'kind': 'machine'},
            recovery.pk.hex(): {'membershipId': owner_membership.hex(), 'kind': 'recovery'},
        },
    },
    'negative': negatives,
}, indent=2))
