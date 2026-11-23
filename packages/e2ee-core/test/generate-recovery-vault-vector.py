"""Frozen recovery vault vault-v1 vector: Python hashlib/hmac SHA256 and PyNaCl==1.6.2.

Independent of the production encoder (@ipld/dag-cbor, noble). It fixes the recovery
file, the file-wrap, prf-wrap, workspace-entry and index ciphertexts, the
formatVersion 1 package and the passkey index, plus inputs vault-v1 must reject.
Nonces are fixed here only so the bytes are reproducible; production draws fresh
random nonces. After the recovery vault ships, never regenerate it.
"""
import hashlib
import hmac
import json

from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt as xchacha
from nacl.bindings import crypto_scalarmult_base
from nacl.signing import SigningKey


def head(major, length):
    if length < 24:
        return bytes([major << 5 | length])
    for info, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
        if length < 1 << (8 * size):
            return bytes([major << 5 | info]) + length.to_bytes(size, 'big')
    raise ValueError(length)


class Raw(bytes):
    """Already encoded CBOR, used to build noncanonical negative inputs."""


def cbor(value):
    """DAG-CBOR subset: uint, negative int, bytes, text, bool, null, arrays, text-keyed maps
    sorted by encoded key length, then bytewise."""
    if isinstance(value, Raw):
        return bytes(value)
    if value is None:
        return b'\xf6'
    if value is True:
        return b'\xf5'
    if value is False:
        return b'\xf4'
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode('utf-8')
        return head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return head(4, len(value)) + b''.join(cbor(item) for item in value)
    if isinstance(value, dict):
        keys = sorted((cbor(key), key) for key in value)
        keys.sort(key=lambda pair: (len(pair[0]), pair[0]))
        return head(5, len(value)) + b''.join(encoded + cbor(value[key]) for encoded, key in keys)
    raise TypeError(value)


def unsorted_map(value):
    """A map whose keys keep insertion order: noncanonical when that order is not sorted."""
    return Raw(head(5, len(value)) + b''.join(cbor(k) + cbor(v) for k, v in value.items()))


def filled(n, size=32):
    return bytes([n]) * size


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def hkdf(secret, salt, info, length=32):
    prk = hmac.new(salt, secret, hashlib.sha256).digest()
    out, block = b'', b''
    for counter in range(1, -(-length // 32) + 1):
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
    return out[:length]


def derive(secret, vault_id, purpose):
    return hkdf(secret, bytes.fromhex(vault_id), f'lody-e2ee/vault-v1/{purpose}\0'.encode())


nonces = iter(range(1, 256))


def nonce():
    return filled(next(nonces), 24)


def seal(secret, vault_id, entry_id, revision, previous, purpose, plaintext, hidden=None):
    """vault-v1 ciphertext: outerNonce || XChaCha(outerKey, hidden header)."""
    inner_nonce = nonce()
    aad = cbor(['vault-v1', vault_id, entry_id, revision, previous, purpose])
    inner = xchacha(plaintext, aad, inner_nonce, derive(secret, vault_id, purpose))
    hidden_value = hidden or [previous, purpose, inner_nonce, inner]
    outer_nonce = nonce()
    outer_aad = cbor(['vault-v1', vault_id, entry_id, revision, 'encrypted-header'])
    sealed = xchacha(cbor(hidden_value), outer_aad, outer_nonce,
                     derive(secret, vault_id, 'encrypted-header'))
    return {'entryId': entry_id, 'revision': revision, 'body': (outer_nonce + sealed).hex()}


def digest_of(entry):
    return sha256_hex(cbor([entry['entryId'], entry['revision'], bytes.fromhex(entry['body'])]))


def pkcs8(oid, seed):
    return bytes([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid,
                  0x04, 0x22, 0x04, 0x20]) + seed


vault_id = filled(0xab).hex()
locator = 'https://vault.example.invalid/v1'
unlock, master, prf = filled(0x22), filled(0x33), filled(0x44)
credential_id = 'Y3JlZGVudGlhbC0x'
signing_seed, encryption_seed = filled(0x55), filled(0x66)
genesis, membership = filled(0x77).hex(), filled(0x88, 16).hex()

recovery_file = cbor(['vault-v1', 1, vault_id, locator, unlock])
file_wrap = seal(unlock, vault_id, vault_id, 0, None, 'file-wrap', master)
prf_entry_id = sha256_hex(cbor(['vault-v1', vault_id, credential_id]))
prf_wrap = seal(prf, vault_id, prf_entry_id, 0, None, 'prf-wrap', master)

package = {
    'formatVersion': 1,
    'genesis': genesis,
    'membershipId': membership,
    'signingPublic': bytes(SigningKey(signing_seed).verify_key),
    'encryptionPublic': crypto_scalarmult_base(encryption_seed),
    'signingPrivate': pkcs8(0x70, signing_seed),
    'encryptionPrivate': pkcs8(0x6e, encryption_seed),
    'generation': 0,
    'trust': {
        'source': 'https://ledger.example.invalid/workspace',
        'genesisRecord': filled(0x99, 40),
        'head': filled(0xaa).hex(),
        'length': 3,
    },
}
package_plain = cbor(package)
workspace_entry_id = filled(0xbb).hex()
workspace_entry = seal(master, vault_id, workspace_entry_id, 0, None, 'workspace-entry',
                       package_plain)
reference = {
    'genesis': genesis, 'membershipId': membership, 'entryId': workspace_entry_id,
    'digest': digest_of(workspace_entry), 'generation': 0, 'retired': False,
}
passkey = {'entryId': prf_entry_id, 'credentialId': credential_id, 'label': 'Laptop'}
index_id = sha256_hex(cbor(['vault-v1', vault_id, 'index']))
index_plain_first = cbor({'entries': [reference]})
index_first = seal(master, vault_id, index_id, 0, None, 'index', index_plain_first)
index_plain = cbor({'entries': [reference], 'passkeys': [passkey]})
index = seal(master, vault_id, index_id, 1, digest_of(index_first), 'index', index_plain)


def recovery_file_case(name, value):
    return {'name': name, 'hex': (value if isinstance(value, bytes) else cbor(value)).hex()}


files = [
    recovery_file_case('noncanonical version integer',
                       cbor(['vault-v1', Raw(b'\x18\x01'), vault_id, locator, unlock])),
    recovery_file_case('another scheme', ['vault-v2', 1, vault_id, locator, unlock]),
    recovery_file_case('another version', ['vault-v1', 2, vault_id, locator, unlock]),
    recovery_file_case('short unlock secret', ['vault-v1', 1, vault_id, locator, unlock[:31]]),
    recovery_file_case('empty locator', ['vault-v1', 1, vault_id, '', unlock]),
    recovery_file_case('uppercase vault id', ['vault-v1', 1, vault_id.upper(), locator, unlock]),
    recovery_file_case('extra element', ['vault-v1', 1, vault_id, locator, unlock, 0]),
]


def ciphertext_case(name, entry, open_with):
    return {'name': name, 'entry': entry, **open_with}


file_open = {'secret': unlock.hex(), 'vaultId': vault_id, 'purpose': 'file-wrap'}
tampered = dict(file_wrap, body=file_wrap['body'][:-2] + format(
    int(file_wrap['body'][-2:], 16) ^ 1, '02x'))
ciphertexts = [
    ciphertext_case('changed body byte', tampered, file_open),
    ciphertext_case('another vault id', file_wrap, dict(file_open, vaultId=filled(0x12).hex())),
    ciphertext_case('another revision', dict(file_wrap, revision=1), file_open),
    ciphertext_case('another entry id', dict(file_wrap, entryId=filled(0x13).hex()), file_open),
    ciphertext_case('another purpose', file_wrap, dict(file_open, purpose='prf-wrap')),
    ciphertext_case('another key', file_wrap, dict(file_open, secret=filled(0x23).hex())),
    ciphertext_case('malformed predecessor', seal(
        unlock, vault_id, vault_id, 0, None, 'file-wrap', master,
        hidden=['not-a-digest', 'file-wrap', filled(0xcc, 24), b'\0' * 48]), file_open),
    ciphertext_case('unknown purpose', seal(
        unlock, vault_id, vault_id, 0, None, 'file-wrap', master,
        hidden=[None, 'backup', filled(0xcd, 24), b'\0' * 48]), file_open),
]


def changed(**fields):
    value = dict(package)
    for key, item in fields.items():
        if item is None:
            value.pop(key)
        else:
            value[key] = item
    return value


packages = [
    {'name': name, 'hex': (value if isinstance(value, bytes) else cbor(value)).hex()}
    for name, value in [
        ('another format version', changed(formatVersion=2)),
        ('no format version', changed(formatVersion=None)),
        ('signing key with the X25519 algorithm', changed(
            signingPrivate=pkcs8(0x6e, signing_seed))),
        ('short encryption key', changed(encryptionPrivate=pkcs8(0x6e, encryption_seed)[:47])),
        ('negative generation', changed(generation=-1)),
        ('empty trusted ledger', changed(trust=dict(package['trust'], length=0))),
        ('unsorted keys', unsorted_map(dict(reversed(list(package.items()))))),
    ]
]


def index_case(name, plain, code):
    return {'name': name, 'entry': seal(master, vault_id, index_id, 0, None, 'index', plain),
            'code': code}


indexes = [
    index_case('passkey entry id for another credential', cbor({'entries': [], 'passkeys': [
        dict(passkey, credentialId='b3RoZXI')]}), 'invalid-input'),
    index_case('empty passkey label', cbor({'entries': [], 'passkeys': [
        dict(passkey, label='')]}), 'invalid-input'),
    index_case('nine passkeys', cbor({'entries': [], 'passkeys': [
        {'entryId': sha256_hex(cbor(['vault-v1', vault_id, f'Y3JlZC0{n}'])),
         'credentialId': f'Y3JlZC0{n}', 'label': 'Key'} for n in range(9)]}),
               'invalid-input'),
    index_case('two active entries for one membership', cbor({'entries': [
        reference, dict(reference, entryId=filled(0xbc).hex())]}), 'conflict'),
    index_case('unsorted keys', unsorted_map({'passkeys': [passkey], 'entries': []}),
               'invalid-input'),
]

print(json.dumps({
    'source': 'Python hashlib/hmac SHA256 and PyNaCl 1.6.2; independent vault-v1 encoding',
    'vaultId': vault_id,
    'locator': locator,
    'unlock': unlock.hex(),
    'master': master.hex(),
    'prfOutput': prf.hex(),
    'credentialId': credential_id,
    'prfInput': 'lody-e2ee/vault-v1/prf-input\0'.encode().hex(),
    'recoveryFile': recovery_file.hex(),
    'fileWrap': dict(file_wrap, digest=digest_of(file_wrap)),
    'prfWrap': dict(prf_wrap, digest=digest_of(prf_wrap)),
    'workspaceEntry': dict(workspace_entry, digest=digest_of(workspace_entry),
                           plaintext=package_plain.hex()),
    'package': {**{k: (v.hex() if isinstance(v, bytes) else v) for k, v in package.items()
                   if k != 'trust'},
                'trust': {**package['trust'], 'genesisRecord': package['trust']['genesisRecord'].hex()}},
    'indexFirst': dict(index_first, digest=digest_of(index_first),
                       plaintext=index_plain_first.hex()),
    'index': dict(index, digest=digest_of(index), plaintext=index_plain.hex()),
    'expectedIndex': {'entries': [reference], 'passkeys': [passkey]},
    'negative': {
        'recoveryFiles': files,
        'ciphertexts': ciphertexts,
        'packages': packages,
        'indexes': indexes,
    },
}, indent=2))
