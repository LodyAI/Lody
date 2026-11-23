package ai.lody.android;

import android.content.Context;
import android.os.UserManager;
import android.system.Os;
import android.system.OsConstants;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import org.json.JSONObject;

/** Android API 24+: CE + isUserUnlocked gives after-first-unlock availability. */
final class LodyAndroidKekStorage implements LodyKekCustody.Storage {
    private final Context context;
    private final File directory;
    private final KeyStore keys;
    private static final String PREFIX = "ai.lody.mobile.e2ee.kek.v1.";

    LodyAndroidKekStorage(Context context) throws Exception {
        this.context = context.getApplicationContext();
        guardUnlocked();
        directory = new File(this.context.getNoBackupFilesDir(), "lody-e2ee-custody");
        if (!directory.isDirectory() && !directory.mkdirs()) throw LodyKekCustody.failure("PROTECTION_UNAVAILABLE");
        keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
    }
    private void guardUnlocked() throws Exception {
        if (context.isDeviceProtectedStorage()) throw LodyKekCustody.failure("PROTECTION_UNAVAILABLE");
        UserManager users = context.getSystemService(UserManager.class);
        if (users == null) throw LodyKekCustody.failure("PROTECTION_UNAVAILABLE");
        if (!users.isUserUnlocked()) throw LodyKekCustody.failure("LOCKED");
    }
    private AtomicFile markerFile(String id) { return new AtomicFile(new File(directory, id + ".json")); }
    public LodyKekCustody.Marker readMarker(String id) throws Exception {
        guardUnlocked();
        AtomicFile file = markerFile(id);
        // AtomicFile.openRead restores an interrupted write's .bak receipt.
        if (!file.getBaseFile().exists() && !new File(file.getBaseFile().getPath() + ".bak").exists()) return null;
        try (FileInputStream input = file.openRead(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int size;
            while ((size = input.read(buffer)) != -1) {
                if (bytes.size() + size > 8192) throw LodyKekCustody.failure("INSTALLATION_UNKNOWN");
                bytes.write(buffer, 0, size);
            }
            JSONObject saved = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            return new LodyKekCustody.Marker(saved.getInt("version"), saved.getString("scopeId"),
                saved.getString("installationId"), saved.getString("state"),
                saved.isNull("probe") ? null : Base64.decode(saved.getString("probe"), Base64.NO_WRAP));
        } catch (Exception error) { throw LodyKekCustody.failure("INSTALLATION_UNKNOWN"); }
    }
    public void writeMarker(LodyKekCustody.Marker marker) throws Exception {
        guardUnlocked();
        JSONObject saved = new JSONObject();
        saved.put("version", marker.version); saved.put("scopeId", marker.scopeId);
        saved.put("installationId", marker.installationId); saved.put("state", marker.state);
        saved.put("probe", marker.probe == null ? JSONObject.NULL : Base64.encodeToString(marker.probe, Base64.NO_WRAP));
        AtomicFile file = markerFile(marker.scopeId);
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(saved.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
            file.finishWrite(output);
            output = null;
            java.io.FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
            try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
            if (!marker.same(readMarker(marker.scopeId))) throw LodyKekCustody.failure("INSTALLATION_UNKNOWN");
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw LodyKekCustody.failure("INSTALLATION_UNKNOWN");
        }
    }
    public SecretKey readKey(String id) throws Exception {
        guardUnlocked();
        if (!keys.containsAlias(PREFIX + id)) return null;
        java.security.Key raw = keys.getKey(PREFIX + id, null);
        if (!(raw instanceof SecretKey)) throw LodyKekCustody.failure("REAPPROVAL_REQUIRED");
        SecretKey key = (SecretKey) raw;
        KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance("AES", "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
        if (key.getEncoded() != null || !"AES".equals(key.getAlgorithm()) || info.getKeySize() != 256
            || info.getOrigin() != KeyProperties.ORIGIN_GENERATED || info.isUserAuthenticationRequired()
            || info.getPurposes() != (KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            || !java.util.Arrays.equals(info.getBlockModes(), new String[]{KeyProperties.BLOCK_MODE_GCM})
            || !java.util.Arrays.equals(info.getEncryptionPaddings(), new String[]{KeyProperties.ENCRYPTION_PADDING_NONE})) {
            throw LodyKekCustody.failure("PROTECTION_UNAVAILABLE");
        }
        return key;
    }
    public void createKey(String id) throws Exception {
        guardUnlocked();
        if (keys.containsAlias(PREFIX + id)) throw LodyKekCustody.failure("REAPPROVAL_REQUIRED");
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(PREFIX + id, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build());
        generator.generateKey();
    }
    public void deleteKey(String id) throws Exception {
        guardUnlocked();
        keys.deleteEntry(PREFIX + id);
    }
}
