package ai.lody.android;

import java.nio.ByteBuffer;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.AEADBadTagException;
import javax.crypto.spec.GCMParameterSpec;

/** Local wrapping only; no authorization, ledger, files, or key export API. */
final class LodyKekCustody {
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }
    static Failure failure(String code) { return new Failure(code); }

    static final class Scope {
        final String accountId, workspaceId, genesisHash, deviceId, installationId;
        private final byte[] genesis, device;
        Scope(String account, String workspace, String genesis, String device, String installation) throws Failure {
            for (String field : new String[]{account, workspace, genesis, device, installation}) {
                if (field == null || field.isEmpty() || field.getBytes(StandardCharsets.UTF_8).length > 256 || field.indexOf('\0') >= 0) {
                    throw failure("INVALID_REQUEST");
                }
            }
            this.genesis = hex32(genesis); this.device = hex32(device); hex32(installation);
            accountId = account; workspaceId = workspace; genesisHash = genesis;
            deviceId = device; installationId = installation;
        }
        String id() throws Exception {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(storageAddressBytes(accountId, workspaceId, genesisHash, deviceId));
            StringBuilder output = new StringBuilder();
            for (byte b : digest) output.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return output.toString();
        }
        String routingId() throws Exception {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(storageAddressBytes(accountId, workspaceId, genesisHash));
            StringBuilder output = new StringBuilder();
            for (byte b : digest) output.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return output.toString();
        }
        byte[] aad(String purpose) throws Failure {
            if (!Arrays.asList(PURPOSES).contains(purpose)) throw failure("INVALID_REQUEST");
            return bindingAAD("lody-e2ee/client-custody/v1\0", purpose);
        }
        byte[] probeAAD() { return bindingAAD("lody-e2ee/client-custody/probe/v1\0", "installation-probe"); }
        private byte[] bindingAAD(String domain, String purpose) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            output.write(0x88);
            appendCbor(output, domain.getBytes(StandardCharsets.UTF_8), 0x60);
            output.write(1);
            appendCbor(output, accountId.getBytes(StandardCharsets.UTF_8), 0x60);
            appendCbor(output, workspaceId.getBytes(StandardCharsets.UTF_8), 0x60);
            appendCbor(output, genesis, 0x40); appendCbor(output, device, 0x40);
            appendCbor(output, installationId.getBytes(StandardCharsets.UTF_8), 0x60);
            appendCbor(output, purpose.getBytes(StandardCharsets.UTF_8), 0x60);
            return output.toByteArray();
        }
    }
    static final String[] PURPOSES = {"signing-private-key", "encryption-private-key", "device-credential", "installed-epoch-key", "rotation-candidate"};
    private static byte[] hex32(String value) throws Failure {
        if (value.length() != 64) throw failure("INVALID_REQUEST");
        byte[] bytes = new byte[32];
        for (int i = 0; i < 64; i++) {
            char c = value.charAt(i);
            if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) throw failure("INVALID_REQUEST");
            int nibble = c <= '9' ? c - '0' : c - 'a' + 10;
            bytes[i / 2] = (byte) ((bytes[i / 2] << 4) | nibble);
        }
        return bytes;
    }
    // Fixed A0 array schema only; no arbitrary CBOR or caller-supplied AAD.
    private static void appendCbor(ByteArrayOutputStream output, byte[] bytes, int major) {
        if (bytes.length < 24) output.write(major | bytes.length);
        else if (bytes.length <= 255) { output.write(major | 24); output.write(bytes.length); }
        else { output.write(major | 25); output.write(bytes.length >> 8); output.write(bytes.length & 255); }
        output.write(bytes, 0, bytes.length);
    }
    // Private storage routing address, retained independently of public wrapping bytes.

    private static byte[] storageAddressBytes(String... fields) {
        byte[] domain = "lody.mobile.kek.v1\0".getBytes(StandardCharsets.UTF_8);
        int length = domain.length;
        for (String field : fields) length += 4 + field.getBytes(StandardCharsets.UTF_8).length;
        ByteBuffer buffer = ByteBuffer.allocate(length).put(domain);
        for (String field : fields) {
            byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
            buffer.putInt(bytes.length).put(bytes);
        }
        return buffer.array();
    }
    static final class Marker {
        final int version;
        final String scopeId, installationId, state;
        final byte[] probe;
        Marker(int version, String scopeId, String installationId, String state, byte[] probe) {
            this.version = version; this.scopeId = scopeId; this.installationId = installationId;
            this.state = state; this.probe = probe;
        }
        boolean same(Marker other) {
            return other != null && version == other.version && scopeId.equals(other.scopeId)
                && installationId.equals(other.installationId) && state.equals(other.state) && Arrays.equals(probe, other.probe);
        }
    }
    interface Storage {
        Marker readMarker(String id) throws Exception;
        void writeMarker(Marker marker) throws Exception;
        SecretKey readKey(String id) throws Exception;
        void createKey(String id) throws Exception;
        void deleteKey(String id) throws Exception;
    }
    private final Storage storage;
    private static final byte[] PROBE = "lody.mobile.kek.installation.v1".getBytes(StandardCharsets.UTF_8);
    LodyKekCustody(Storage storage) { this.storage = storage; }
    private Marker marker(Scope scope, String state, byte[] probe) throws Exception {
        return new Marker(1, scope.id(), scope.installationId, state, probe);
    }
    private SecretKey load(Scope scope) throws Exception {
        Marker saved = storage.readMarker(scope.id());
        if (saved == null || saved.version != 1 || !saved.scopeId.equals(scope.id()) || !saved.installationId.equals(scope.installationId)) {
            throw failure("REAPPROVAL_REQUIRED");
        }
        if (!saved.state.equals("ready") || saved.probe == null) throw failure("INSTALLATION_UNKNOWN");
        SecretKey key = storage.readKey(scope.id());
        if (key == null) throw failure("REAPPROVAL_REQUIRED");
        try {
            if (!Arrays.equals(open(key, scope.probeAAD(), saved.probe), PROBE)) throw failure("REAPPROVAL_REQUIRED");
        } catch (AEADBadTagException | Failure e) { throw failure("REAPPROVAL_REQUIRED"); }
        return key;
    }
    void install(Scope scope) throws Exception {
        Marker saved = storage.readMarker(scope.id());
        if (saved != null) {
            if (!saved.state.equals("ready")) throw failure("REAPPROVAL_REQUIRED");
            load(scope); // Exact settled readback only; never replace key/probe/originals.
            return;
        }
        if (storage.readKey(scope.id()) != null) throw failure("REAPPROVAL_REQUIRED");
        storage.writeMarker(marker(scope, "pending", null));
        storage.createKey(scope.id());
        SecretKey stored = storage.readKey(scope.id());
        if (stored == null) throw failure("INSTALLATION_UNKNOWN");
        byte[] proof = seal(stored, scope.probeAAD(), PROBE);
        if (!Arrays.equals(open(stored, scope.probeAAD(), proof), PROBE)) throw failure("INSTALLATION_UNKNOWN");
        Marker receipt = marker(scope, "ready", proof);
        storage.writeMarker(receipt);
        if (!receipt.same(storage.readMarker(scope.id()))) throw failure("INSTALLATION_UNKNOWN");
        load(scope);
    }
    enum Status { MISSING, READY }
    Status status(Scope scope) throws Exception {
        if (storage.readMarker(scope.id()) == null) {
            if (storage.readKey(scope.id()) != null) throw failure("REAPPROVAL_REQUIRED");
            return Status.MISSING;
        }
        load(scope);
        return Status.READY;
    }
    byte[] wrap(Scope scope, String purpose, byte[] plaintext) throws Exception {
        if (plaintext.length > 4096) throw failure("INVALID_REQUEST");
        return seal(load(scope), scope.aad(purpose), plaintext);
    }
    byte[] unwrap(Scope scope, String purpose, byte[] wrapped) throws Exception {
        if (wrapped.length < 29 || wrapped.length > 4125 || wrapped[0] != 1) throw failure("INVALID_REQUEST");
        try { return open(load(scope), scope.aad(purpose), wrapped); }
        catch (AEADBadTagException e) { throw failure("AUTHENTICATION_FAILED"); }
    }
    void delete(Scope scope) throws Exception {
        Marker saved = storage.readMarker(scope.id());
        if (saved != null) {
            if (saved.version != 1 || !saved.scopeId.equals(scope.id()) || !saved.installationId.equals(scope.installationId)) throw failure("REAPPROVAL_REQUIRED");
        } else if (storage.readKey(scope.id()) != null) {
            // A residual key cannot be assigned to this incarnation without a marker.
            throw failure("REAPPROVAL_REQUIRED");
        }
        storage.writeMarker(marker(scope, "deleted", null));
        storage.deleteKey(scope.id());
        if (storage.readKey(scope.id()) != null) throw failure("INSTALLATION_UNKNOWN");
    }
    private static byte[] seal(SecretKey key, byte[] aad, byte[] bytes) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // Keystore requires randomized encryption. Never accept a caller nonce.
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] nonce = cipher.getIV();
        if (nonce.length != 12) throw failure("PROTECTION_UNAVAILABLE");
        cipher.updateAAD(aad);
        byte[] ciphertext = cipher.doFinal(bytes);
        return frame(nonce, ciphertext);
    }
    // Framing only; production wrap still asks AndroidKeyStore to generate the IV.
    // Fixed-nonce vector encryption uses a synthetic JVM key, never the native bridge.
    static byte[] frame(byte[] nonce, byte[] ciphertextWithTag) {
        return ByteBuffer.allocate(13 + ciphertextWithTag.length).put((byte) 1).put(nonce).put(ciphertextWithTag).array();
    }
    private static byte[] open(SecretKey key, byte[] aad, byte[] wrapped) throws Exception {
        if (wrapped.length < 29 || wrapped.length > 4125 || wrapped[0] != 1) throw failure("INVALID_REQUEST");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(wrapped, 1, 13)));
        cipher.updateAAD(aad);
        return cipher.doFinal(wrapped, 13, wrapped.length - 13);
    }
}
