use ed25519_dalek::{Signature, Verifier, VerifyingKey};

#[no_mangle]
pub extern "C" fn verify(pk: *const u8, sig: *const u8, msg: *const u8, msg_len: u32) -> i32 {
    let pk = unsafe { std::slice::from_raw_parts(pk, 32) };
    let sig = unsafe { std::slice::from_raw_parts(sig, 64) };
    let msg = unsafe { std::slice::from_raw_parts(msg, msg_len as usize) };
    let Ok(key) = VerifyingKey::from_bytes(pk.try_into().ok().unwrap_or(&[0u8; 32])) else {
        return 0;
    };
    let Ok(signature) = Signature::from_slice(sig) else {
        return 0;
    };
    if key.verify(msg, &signature).is_ok() {
        1
    } else {
        0
    }
}
