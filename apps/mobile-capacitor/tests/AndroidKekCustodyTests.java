package ai.lody.android;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashMap;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;

public final class AndroidKekCustodyTests {
    static int assertions;
    static void check(boolean value) { if (!value) throw new AssertionError("custody assertion failed"); assertions++; }
    interface Action { void run() throws Exception; }
    static void rejects(String code, Action action) throws Exception {
        try { action.run(); throw new AssertionError("expected rejection"); }
        catch (LodyKekCustody.Failure error) { check(error.code.equals(code)); }
    }
    static LodyKekCustody.Scope scope() throws Exception { return scope("account", "workspace", "01".repeat(32), "02".repeat(32), "03".repeat(32)); }
    static LodyKekCustody.Scope scope(String account, String workspace, String genesis, String device, String installation) throws Exception {
        return new LodyKekCustody.Scope(account, workspace, genesis, device, installation);
    }
    static final class Memory implements LodyKekCustody.Storage {
        final HashMap<String, LodyKekCustody.Marker> markers = new HashMap<>();
        final HashMap<String, SecretKey> keys = new HashMap<>();
        int writes, failWrite;
        boolean unknownCreate, failDelete;
        String readError;
        public LodyKekCustody.Marker readMarker(String id) { return markers.get(id); }
        public void writeMarker(LodyKekCustody.Marker marker) throws Exception {
            if (++writes == failWrite) throw LodyKekCustody.failure("INSTALLATION_UNKNOWN");
            markers.put(marker.scopeId, marker);
        }
        public SecretKey readKey(String id) throws Exception {
            if (readError != null) throw LodyKekCustody.failure(readError);
            return keys.get(id);
        }
        public void createKey(String id) throws Exception {
            if (keys.containsKey(id)) throw LodyKekCustody.failure("REAPPROVAL_REQUIRED");
            KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
            keys.put(id, generator.generateKey());
            if (unknownCreate) throw LodyKekCustody.failure("INSTALLATION_UNKNOWN");
        }
        public void deleteKey(String id) throws Exception {
            if (failDelete) throw LodyKekCustody.failure("PROTECTION_UNAVAILABLE");
            keys.remove(id);
        }
    }
    static void nativeQueue() throws Exception {
        java.util.concurrent.ExecutorService workers = java.util.concurrent.Executors.newCachedThreadPool(work -> {
            Thread thread = new Thread(work, "KekQueueTest"); thread.setDaemon(true); return thread;
        });
        try {
            LodyKekCallQueue queue = new LodyKekCallQueue(workers);
            java.util.concurrent.CountDownLatch started = new java.util.concurrent.CountDownLatch(1), release = new java.util.concurrent.CountDownLatch(1);
            java.util.concurrent.CountDownLatch independent = new java.util.concurrent.CountDownLatch(1), next = new java.util.concurrent.CountDownLatch(1);
            java.util.List<String> order = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
            java.util.concurrent.CompletableFuture<Void> observer = new java.util.concurrent.CompletableFuture<>();
            queue.enqueue("same-routing-scope", () -> {
                order.add("old-entered"); started.countDown();
                try { release.await(); } catch (InterruptedException e) { throw new AssertionError(e); }
                order.add("old-settled"); observer.complete(null);
            });
            if (!started.await(30, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("native start signal missing");
            observer.cancel(true); // Cancels only the observer; no physical native cancellation exists.
            queue.enqueue("same-routing-scope", () -> { order.add("replacement-entered"); next.countDown(); });
            queue.enqueue("independent-workspace", () -> { order.add("independent-settled"); independent.countDown(); });
            if (!independent.await(30, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("unrelated route blocked");
            check(order.equals(java.util.List.of("old-entered", "independent-settled")));
            release.countDown();
            if (!next.await(30, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("retained native route did not settle");
            check(order.equals(java.util.List.of("old-entered", "independent-settled", "old-settled", "replacement-entered")));
            java.util.concurrent.CountDownLatch reused = new java.util.concurrent.CountDownLatch(1);
            queue.enqueue("same-routing-scope", reused::countDown);
            if (!reused.await(30, java.util.concurrent.TimeUnit.SECONDS)) throw new AssertionError("settled route did not reopen");
        } finally { workers.shutdown(); }
        java.util.concurrent.atomic.AtomicBoolean rejectFirst = new java.util.concurrent.atomic.AtomicBoolean(true);
        LodyKekCallQueue queue = new LodyKekCallQueue(work -> {
            if (rejectFirst.getAndSet(false)) throw new java.util.concurrent.RejectedExecutionException();
            work.run();
        });
        java.util.concurrent.CompletableFuture<String> result = new java.util.concurrent.CompletableFuture<>();
        java.util.List<String> effects = new java.util.ArrayList<>();
        queue.enqueue("refused-before-entry", () -> effects.add("must-never-run"), () -> result.complete("unavailable"));
        check(result.join().equals("unavailable") && effects.isEmpty());
        queue.enqueue("refused-before-entry", () -> effects.add("fresh-work"));
        check(effects.equals(java.util.List.of("fresh-work"))); // No delayed rejected capture or leaked route.
    }
    public static void main(String[] args) throws Exception {
        nativeQueue();
        LodyKekCustody.Scope scope = scope();
        byte[] bytes = new byte[32]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        Memory store = new Memory();
        LodyKekCustody host = new LodyKekCustody(store);
        check(host.status(scope) == LodyKekCustody.Status.MISSING);
        rejects("REAPPROVAL_REQUIRED", () -> host.wrap(scope, "installed-epoch-key", bytes));
        host.install(scope); host.status(scope);
        byte[] wrapped = host.wrap(scope, "installed-epoch-key", bytes);
        check(wrapped.length == 61 && wrapped[0] == 1);
        String[] purposes = {"signing-private-key", "encryption-private-key", "device-credential", "installed-epoch-key", "rotation-candidate"};
        for (String purpose : purposes) {
            byte[] blob = host.wrap(scope, purpose, bytes);
            check(Arrays.equals(host.unwrap(scope, purpose, blob), bytes));
            for (String other : purposes) if (!purpose.equals(other)) {
                rejects("AUTHENTICATION_FAILED", () -> host.unwrap(scope, other, blob));
            }
        }
        rejects("INVALID_REQUEST", () -> host.wrap(scope, "epoch-key", bytes));
        byte[] wrongVersion = wrapped.clone(); wrongVersion[0] = 2;
        rejects("INVALID_REQUEST", () -> host.unwrap(scope, "installed-epoch-key", wrongVersion));
        for (int length : new int[]{0, 1, 12, 28, 4126}) {
            rejects("INVALID_REQUEST", () -> host.unwrap(scope, "installed-epoch-key", new byte[length]));
        }
        for (int length : new int[]{0, 4096}) {
            byte[] input = new byte[length];
            byte[] blob = host.wrap(scope, "device-credential", input);
            check(blob.length == length + 29);
            check(Arrays.equals(host.unwrap(scope, "device-credential", blob), input));
        }
        for (String invalid : new String[]{"", "a", "ab".repeat(31), "AB".repeat(32), "gg".repeat(32)}) {
            rejects("INVALID_REQUEST", () -> scope("account", "workspace", invalid, "02".repeat(32), "03".repeat(32)));
            rejects("INVALID_REQUEST", () -> scope("account", "workspace", "01".repeat(32), invalid, "03".repeat(32)));
            rejects("INVALID_REQUEST", () -> scope("account", "workspace", "01".repeat(32), "02".repeat(32), invalid));
        }
        LodyKekCustody reopened = new LodyKekCustody(store);
        check(Arrays.equals(reopened.unwrap(scope, "installed-epoch-key", wrapped), bytes));
        check(!Arrays.equals(reopened.wrap(scope, "installed-epoch-key", bytes), wrapped));
        SecretKey retainedKey = store.keys.get(scope.id());
        LodyKekCustody.Marker retainedReceipt = store.markers.get(scope.id());
        reopened.install(scope); // Exact settled installation retry reconciles without replacement.
        check(store.keys.get(scope.id()) == retainedKey && store.markers.get(scope.id()).same(retainedReceipt));
        rejects("AUTHENTICATION_FAILED", () -> reopened.unwrap(scope, "signing-private-key", wrapped));
        byte[] tampered = wrapped.clone(); tampered[15] ^= 1;
        rejects("AUTHENTICATION_FAILED", () -> reopened.unwrap(scope, "installed-epoch-key", tampered));
        rejects("INVALID_REQUEST", () -> reopened.wrap(scope, "installation-probe", bytes));
        rejects("INVALID_REQUEST", () -> reopened.wrap(scope, "unknown", bytes));
        rejects("INVALID_REQUEST", () -> reopened.wrap(scope, "installed-epoch-key", new byte[4097]));
        for (LodyKekCustody.Scope other : new LodyKekCustody.Scope[]{scope("other", "workspace", "01".repeat(32), "02".repeat(32), "03".repeat(32)),
            scope("account", "other", "01".repeat(32), "02".repeat(32), "03".repeat(32)), scope("account", "workspace", "04".repeat(32), "02".repeat(32), "03".repeat(32)),
            scope("account", "workspace", "01".repeat(32), "04".repeat(32), "03".repeat(32)), scope("account", "workspace", "01".repeat(32), "02".repeat(32), "04".repeat(32))}) {
            rejects("REAPPROVAL_REQUIRED", () -> reopened.unwrap(other, "installed-epoch-key", wrapped));
        }
        for (String error : new String[]{"LOCKED", "PROTECTION_UNAVAILABLE", "REAPPROVAL_REQUIRED"}) {
            store.readError = error;
            rejects(error, () -> reopened.status(scope));
            rejects(error, () -> reopened.unwrap(scope, "installed-epoch-key", wrapped));
        }
        store.readError = null;
        LodyKekCustody.Marker marker = store.markers.remove(scope.id());
        rejects("REAPPROVAL_REQUIRED", () -> reopened.status(scope));
        rejects("REAPPROVAL_REQUIRED", () -> reopened.install(scope));
        rejects("REAPPROVAL_REQUIRED", () -> reopened.delete(scope));
        check(store.keys.size() == 1);
        store.markers.put(scope.id(), marker);
        SecretKey key = store.keys.remove(scope.id());
        rejects("REAPPROVAL_REQUIRED", () -> reopened.status(scope));
        rejects("REAPPROVAL_REQUIRED", () -> reopened.install(scope));
        store.keys.put(scope.id(), new SecretKeySpec(new byte[32], "AES"));
        rejects("REAPPROVAL_REQUIRED", () -> reopened.status(scope));
        store.keys.put(scope.id(), key);
        store.failDelete = true;
        rejects("PROTECTION_UNAVAILABLE", () -> reopened.delete(scope));
        rejects("INSTALLATION_UNKNOWN", () -> reopened.status(scope));
        store.failDelete = false;
        reopened.delete(scope); reopened.delete(scope); check(store.keys.isEmpty());
        rejects("INSTALLATION_UNKNOWN", () -> reopened.status(scope));
        rejects("REAPPROVAL_REQUIRED", () -> reopened.install(scope));
        for (int failure : new int[]{1, 2}) {
            Memory failed = new Memory(); failed.failWrite = failure;
            LodyKekCustody interrupted = new LodyKekCustody(failed);
            rejects("INSTALLATION_UNKNOWN", () -> interrupted.install(scope));
            if (failure == 1) check(failed.keys.isEmpty());
            else {
                rejects("INSTALLATION_UNKNOWN", () -> interrupted.status(scope));
                rejects("REAPPROVAL_REQUIRED", () -> interrupted.install(scope));
                check(failed.keys.size() == 1);
            }
        }
        Memory unknown = new Memory(); unknown.unknownCreate = true;
        LodyKekCustody interrupted = new LodyKekCustody(unknown);
        rejects("INSTALLATION_UNKNOWN", () -> interrupted.install(scope));
        rejects("INSTALLATION_UNKNOWN", () -> interrupted.status(scope));
        rejects("REAPPROVAL_REQUIRED", () -> interrupted.install(scope));
        check(unknown.keys.size() == 1);
        for (LodyKekCustody.Marker invalid : new LodyKekCustody.Marker[]{
            new LodyKekCustody.Marker(2, scope.id(), scope.installationId, "ready", marker.probe),
            new LodyKekCustody.Marker(1, "wrong", scope.installationId, "ready", marker.probe)}) {
            store.markers.put(scope.id(), invalid);
            rejects("REAPPROVAL_REQUIRED", () -> reopened.status(scope));
            rejects("REAPPROVAL_REQUIRED", () -> reopened.delete(scope));
        }
        Memory isolated = new Memory();
        LodyKekCustody.Scope newBinding = scope("account", "workspace", "01".repeat(32), "06".repeat(32), "05".repeat(32));
        LodyKekCustody.Scope separate = scope("other-account", "workspace", "01".repeat(32), "02".repeat(32), "03".repeat(32));
        LodyKekCustody lifecycle = new LodyKekCustody(isolated);
        lifecycle.install(scope); lifecycle.install(newBinding); lifecycle.install(separate);
        byte[] newPacket = lifecycle.wrap(newBinding, "device-credential", bytes);
        check(scope.routingId().equals(newBinding.routingId()) && !scope.id().equals(newBinding.id()));
        check(!scope.routingId().equals(separate.routingId()));
        lifecycle.delete(scope);
        LodyKekCustody reopenedNew = new LodyKekCustody(isolated);
        check(reopenedNew.status(newBinding) == LodyKekCustody.Status.READY && reopenedNew.status(separate) == LodyKekCustody.Status.READY);
        check(Arrays.equals(reopenedNew.unwrap(newBinding, "device-credential", newPacket), bytes));

        // Synthetic JS WebCrypto fixture; no AndroidKeyStore is accessed on the JVM.
        for (String row : Files.readAllLines(Path.of(args[0], "aad-cases.tsv"))) {
            String[] parts = row.split("\t");
            LodyKekCustody.Scope binding = scope(parts[0], parts[1], "01".repeat(32), "02".repeat(32), "03".repeat(32));
            check(Arrays.equals(binding.aad("rotation-candidate"), java.util.HexFormat.of().parseHex(parts[2])));
        }
        Memory interop = new Memory();
        interop.keys.put(scope.id(), new SecretKeySpec(bytes, "AES"));
        interop.markers.put(scope.id(), new LodyKekCustody.Marker(1, scope.id(), scope.installationId, "ready", Files.readAllBytes(Path.of(args[0], "probe.bin"))));
        LodyKekCustody nativeHost = new LodyKekCustody(interop);
        check(Arrays.equals(nativeHost.unwrap(scope, "installed-epoch-key", Files.readAllBytes(Path.of(args[0], "wrapped.bin"))), bytes));
        // Alternate bindings are locally ready under the same synthetic KEK:
        // failure must be AAD authentication, not absence/identity lookup.
        for (LodyKekCustody.Scope other : new LodyKekCustody.Scope[]{scope("other", "workspace", "01".repeat(32), "02".repeat(32), "03".repeat(32)),
            scope("account", "other", "01".repeat(32), "02".repeat(32), "03".repeat(32)), scope("account", "workspace", "04".repeat(32), "02".repeat(32), "03".repeat(32)),
            scope("account", "workspace", "01".repeat(32), "04".repeat(32), "03".repeat(32)), scope("account", "workspace", "01".repeat(32), "02".repeat(32), "04".repeat(32))}) {
            Memory alternate = new Memory();
            SecretKey knownKey = new SecretKeySpec(bytes, "AES");
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, knownKey); cipher.updateAAD(other.probeAAD());
            byte[] ciphertext = cipher.doFinal("lody.mobile.kek.installation.v1".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            byte[] proof = java.nio.ByteBuffer.allocate(13 + ciphertext.length).put((byte) 1).put(cipher.getIV()).put(ciphertext).array();
            alternate.keys.put(other.id(), knownKey);
            alternate.markers.put(other.id(), new LodyKekCustody.Marker(1, other.id(), other.installationId, "ready", proof));
            LodyKekCustody candidate = new LodyKekCustody(alternate);
            candidate.status(other);
            rejects("AUTHENTICATION_FAILED", () -> candidate.unwrap(other, "installed-epoch-key", Files.readAllBytes(Path.of(args[0], "wrapped.bin"))));
        }
        Files.write(Path.of(args[0], "java-wrapped.bin"), nativeHost.wrap(scope, "installed-epoch-key", bytes));
        // Frozen A0 JSON e1e3b5a10f65d94655d097cd262f008a35c2688e; TSV is a lossless projection.
        // Fixed nonces apply only to synthetic JCE keys, never AndroidKeyStore/bridge calls.
        for (String row : Files.readAllLines(Path.of(args[0], "shared-vectors.tsv"))) {
            String[] v = row.split("\t", -1);
            LodyKekCustody.Scope bound = scope(v[0], v[1], v[2], v[3], v[4]);
            String purpose = v[5];
            java.util.HexFormat hex = java.util.HexFormat.of();
            byte[] nonce = hex.parseHex(v[6]), plaintext = hex.parseHex(v[7]), aad = hex.parseHex(v[8]);
            SecretKey sharedKey = new SecretKeySpec(hex.parseHex(v[9]), "AES");
            byte[] expectedBlob = hex.parseHex(v[10]);
            check(Arrays.equals(bound.aad(purpose), aad));
            javax.crypto.Cipher fixed = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            fixed.init(javax.crypto.Cipher.ENCRYPT_MODE, sharedKey, new javax.crypto.spec.GCMParameterSpec(128, nonce));
            fixed.updateAAD(bound.aad(purpose));
            check(Arrays.equals(LodyKekCustody.frame(nonce, fixed.doFinal(plaintext)), expectedBlob));
            Memory sharedStore = new Memory();
            sharedStore.keys.put(bound.id(), sharedKey);
            javax.crypto.Cipher probeCipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            probeCipher.init(javax.crypto.Cipher.ENCRYPT_MODE, sharedKey); probeCipher.updateAAD(bound.probeAAD());
            byte[] probeBytes = probeCipher.doFinal("lody.mobile.kek.installation.v1".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            sharedStore.markers.put(bound.id(), new LodyKekCustody.Marker(1, bound.id(), bound.installationId, "ready", LodyKekCustody.frame(probeCipher.getIV(), probeBytes)));
            LodyKekCustody sharedHost = new LodyKekCustody(sharedStore);
            check(Arrays.equals(sharedHost.unwrap(bound, purpose, expectedBlob), plaintext));
            byte[] generated = sharedHost.wrap(bound, purpose, plaintext);
            byte[] nativeNonce = Arrays.copyOfRange(generated, 1, 13);
            javax.crypto.Cipher expectedFresh = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            expectedFresh.init(javax.crypto.Cipher.ENCRYPT_MODE, sharedKey, new javax.crypto.spec.GCMParameterSpec(128, nativeNonce));
            expectedFresh.updateAAD(aad);
            check(Arrays.equals(generated, LodyKekCustody.frame(nativeNonce, expectedFresh.doFinal(plaintext))));
            byte[] badTag = expectedBlob.clone(); badTag[badTag.length - 1] ^= 1;
            rejects("AUTHENTICATION_FAILED", () -> sharedHost.unwrap(bound, purpose, badTag));
            byte[] badVersion = expectedBlob.clone(); badVersion[0] = 2;
            rejects("INVALID_REQUEST", () -> sharedHost.unwrap(bound, purpose, badVersion));
        }
        System.out.println("Android custody: " + assertions + " assertions passed (JVM/injected storage; no Android API/hardware claim)");
    }
}
