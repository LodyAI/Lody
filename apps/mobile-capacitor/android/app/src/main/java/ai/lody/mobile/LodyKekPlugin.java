package ai.lody.android;

import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LodyKek")
public final class LodyKekPlugin extends Plugin {
    private interface Operation { JSObject run(LodyKekCustody custody, LodyKekCustody.Scope scope) throws Exception; }
    private void reject(PluginCall call, Exception error) {
        String code = "PROTECTION_UNAVAILABLE";
        if (error instanceof LodyKekCustody.Failure) code = ((LodyKekCustody.Failure) error).code;
        else if (error instanceof KeyPermanentlyInvalidatedException || error instanceof java.security.UnrecoverableKeyException) code = "REAPPROVAL_REQUIRED";
        else if (error instanceof UserNotAuthenticatedException) code = "LOCKED";
        call.reject(code, code); // No raw exception messages or borrowed secret material.
    }
    private void perform(PluginCall call, Operation operation) {
        try {
            LodyKekCustody.Scope scope = new LodyKekCustody.Scope(call.getString("accountId"), call.getString("workspaceId"),
                call.getString("genesisHash"), call.getString("deviceId"), call.getString("installationId"));
            LodyKekCallQueue.SHARED.enqueue(scope.routingId(), () -> {
                // Never block Capacitor's handler, infer native termination from cancellation,
                // or allow a new incarnation to overtake old native work on this route.
                try { call.resolve(operation.run(new LodyKekCustody(new LodyAndroidKekStorage(getContext())), scope)); }
                catch (Exception error) { reject(call, error); }
            }, () -> call.reject("PROTECTION_UNAVAILABLE", "PROTECTION_UNAVAILABLE"));
        } catch (Exception error) { reject(call, error); }
    }
    private byte[] decode(PluginCall call, String name, int limit) throws LodyKekCustody.Failure {
        String encoded = call.getString(name);
        if (encoded == null || encoded.length() > limit) throw LodyKekCustody.failure("INVALID_REQUEST");
        try {
            byte[] decoded = Base64.decode(encoded, Base64.NO_WRAP);
            if (!Base64.encodeToString(decoded, Base64.NO_WRAP).equals(encoded)) throw LodyKekCustody.failure("INVALID_REQUEST");
            return decoded;
        } catch (IllegalArgumentException error) { throw LodyKekCustody.failure("INVALID_REQUEST"); }
    }
    private JSObject ready(LodyKekCustody.Scope scope) {
        JSObject result = new JSObject(); result.put("state", "ready"); result.put("version", 1);
        result.put("installationId", scope.installationId); return result;
    }
    @PluginMethod public void install(PluginCall call) {
        perform(call, (custody, scope) -> { custody.install(scope); return ready(scope); });
    }
    @PluginMethod public void status(PluginCall call) {
        perform(call, (custody, scope) -> {
            LodyKekCustody.Status state = custody.status(scope);
            JSObject result = ready(scope);
            result.put("state", state == LodyKekCustody.Status.MISSING ? "missing" : "ready");
            return result;
        });
    }
    @PluginMethod public void wrap(PluginCall call) {
        perform(call, (custody, scope) -> {
            byte[] wrapped = custody.wrap(scope, call.getString("purpose"), decode(call, "plaintext", 5464));
            JSObject result = new JSObject(); result.put("wrapped", Base64.encodeToString(wrapped, Base64.NO_WRAP)); return result;
        });
    }
    @PluginMethod public void unwrap(PluginCall call) {
        perform(call, (custody, scope) -> {
            byte[] plaintext = custody.unwrap(scope, call.getString("purpose"), decode(call, "wrapped", 5500));
            JSObject result = new JSObject(); result.put("plaintext", Base64.encodeToString(plaintext, Base64.NO_WRAP)); return result;
        });
    }
    @PluginMethod public void delete(PluginCall call) {
        perform(call, (custody, scope) -> { custody.delete(scope); JSObject result = new JSObject(); result.put("state", "deleted"); return result; });
    }
}
