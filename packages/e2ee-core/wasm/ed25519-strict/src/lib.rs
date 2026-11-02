//! Strict Ed25519 for `@lody/e2ee-core`, with exactly the core's acceptance rules:
//! A and R are canonical encodings of nonzero points in the prime-order subgroup,
//! S < L, and the cofactored equation [8](R + kA - SB) = 0 holds with
//! k = SHA-512(R || A || M) mod L. A must also not be of small order.
//!
//! No wasm-bindgen: the host writes inputs into the buffer returned by `input`
//! and calls `key_ok` or `verify`. Results are 1 (accept) or 0 (reject).

use curve25519_dalek::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::traits::IsIdentity;
use sha2::{Digest, Sha512};

/// [L]P = [L - 1]P + P with L - 1 = -1 mod L, so a variable-time multiplication
/// can do it. Every input here is public; constant time protects nothing.

/// [L]P == identity: P lies in the prime-order subgroup (same as `is_torsion_free`).
fn torsion_free(point: &EdwardsPoint) -> bool {
    (EdwardsPoint::vartime_double_scalar_mul_basepoint(&-Scalar::ONE, point, &Scalar::ZERO) + point)
        .is_identity()
}

/// Decodes only canonical encodings: re-encoding must give the same bytes
/// (rejects y >= p and a set sign bit with x = 0, like noble's strict branch).
pub fn decode_canonical(bytes: &[u8; 32]) -> Option<EdwardsPoint> {
    let point = CompressedEdwardsY(*bytes).decompress()?;
    (point.compress().as_bytes() == bytes).then_some(point)
}

/// A valid signing public key: canonical, not of small order, prime-order subgroup.
pub fn public_key(bytes: &[u8; 32]) -> Option<EdwardsPoint> {
    let point = decode_canonical(bytes)?;
    (!point.is_small_order() && torsion_free(&point)).then_some(point)
}

/// Full strict verification of a 64-byte signature over `message` by `key`.
pub fn verify_strict(key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    public_key(key).is_some_and(|a| verify_with(&a, key, message, signature))
}

/// Strict verification for a key the caller already accepted with `public_key`
/// (the subgroup check of A is the costliest step; core caches it per key).
/// The key is still decoded canonically, so a wrong key can only be rejected.
pub fn verify_checked_key(key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    decode_canonical(key).is_some_and(|a| verify_with(&a, key, message, signature))
}

fn verify_with(a: &EdwardsPoint, key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    let r_bytes: [u8; 32] = signature[..32].try_into().unwrap();
    let s_bytes: [u8; 32] = signature[32..].try_into().unwrap();
    let Some(s) = Option::<Scalar>::from(Scalar::from_canonical_bytes(s_bytes)) else {
        return false;
    };
    let Some(r) = decode_canonical(&r_bytes) else { return false };
    if r.is_identity() || !torsion_free(&r) {
        return false;
    }
    let mut hash = Sha512::new();
    hash.update(r_bytes);
    hash.update(key);
    hash.update(message);
    let k = Scalar::from_bytes_mod_order_wide(&hash.finalize().into());
    // kA - SB in one variable-time double multiplication.
    let check = r + EdwardsPoint::vartime_double_scalar_mul_basepoint(&k, a, &-s);
    check.mul_by_cofactor().is_identity()
}

static mut BUFFER: Vec<u8> = Vec::new();

/// Returns a pointer to at least `len` writable bytes for the next call.
#[no_mangle]
pub extern "C" fn input(len: usize) -> *mut u8 {
    #[allow(static_mut_refs)]
    unsafe {
        BUFFER.clear();
        BUFFER.resize(len, 0);
        BUFFER.as_mut_ptr()
    }
}

/// Buffer: key (32). 1 when it is a valid signing public key.
#[no_mangle]
pub extern "C" fn key_ok() -> u32 {
    #[allow(static_mut_refs)]
    let buffer = unsafe { &BUFFER };
    match buffer.get(..32) {
        Some(key) => public_key(key.try_into().unwrap()).is_some() as u32,
        None => 0,
    }
}

/// Buffer: key (32) || signature (64) || message (message_len). With `key_checked`
/// nonzero the caller vouches that `key_ok` already accepted the key.
#[no_mangle]
pub extern "C" fn verify(message_len: usize, key_checked: u32) -> u32 {
    #[allow(static_mut_refs)]
    let buffer = unsafe { &BUFFER };
    if buffer.len() != 96 + message_len {
        return 0;
    }
    let key: &[u8; 32] = buffer[..32].try_into().unwrap();
    let signature: &[u8; 64] = buffer[32..96].try_into().unwrap();
    if key_checked != 0 {
        verify_checked_key(key, &buffer[96..], signature) as u32
    } else {
        verify_strict(key, &buffer[96..], signature) as u32
    }
}
