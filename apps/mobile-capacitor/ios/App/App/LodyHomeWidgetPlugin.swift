import Capacitor
import Foundation
import WidgetKit
import os

private let homeWidgetLog = Logger(subsystem: "ai.lody.mobile", category: "home-widget")

@objc(LodyHomeWidgetPlugin)
public final class LodyHomeWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LodyHomeWidgetPlugin"
    public let jsName = "LodyHomeWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "syncSummary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncTokenUsage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncProviderQuota", returnType: CAPPluginReturnPromise),
    ]

    private func fail(_ call: CAPPluginCall, _ message: String, code: String) {
        homeWidgetLog.error("Widget bridge failed: \(code, privacy: .public)")
        call.reject(message, code)
    }

    private func finishEmpty(_ call: CAPPluginCall, kind: String,
                             retain: (LodyHomeWidgetScope) -> Bool, clear: () -> Void) {
        if call.options["pendingScope"] != nil {
            guard let raw = call.getObject("pendingScope"),
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let scope = try? JSONDecoder().decode(LodyHomeWidgetScope.self, from: data), scope.isValid else {
                fail(call, "Invalid pending widget scope.", code: "invalid_pending_scope")
                return
            }
            if !retain(scope) {
                WidgetCenter.shared.reloadTimelines(ofKind: kind)
            }
        } else {
            clear()
            // A previously rendered timeline can outlive an already-absent key.
            WidgetCenter.shared.reloadTimelines(ofKind: kind)
        }
        call.resolve()
    }

    @objc public func syncSummary(_ call: CAPPluginCall) {
        guard let defaults = LodyHomeWidgetStore.defaults() else {
            fail(call, "Home Screen widget shared container is unavailable.", code: "shared_container_unavailable")
            return
        }
        if call.options["summary"] is NSNull {
            finishEmpty(call, kind: LodyHomeWidgetStore.kind,
                        retain: { LodyHomeWidgetStore.retainIfOwned($0, from: defaults) },
                        clear: { LodyHomeWidgetStore.clear(from: defaults) })
            return
        }
        guard let raw = call.getObject("summary"),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let summary = try? JSONDecoder().decode(LodyHomeWidgetSummary.self, from: data),
              summary.isValid else {
            fail(call, "Invalid Home Screen widget summary.", code: "invalid_summary")
            return
        }
        do {
            try LodyHomeWidgetStore.save(
                summary,
                to: defaults
            )
            WidgetCenter.shared.reloadTimelines(ofKind: LodyHomeWidgetStore.kind)
            call.resolve()
        } catch {
            fail(call, "Failed to save Home Screen widget summary.", code: "save_failed")
        }
    }

    @objc public func syncProviderQuota(_ call: CAPPluginCall) {
        guard let defaults = LodyHomeWidgetStore.defaults() else {
            fail(call, "Home Screen widget shared container is unavailable.", code: "shared_container_unavailable")
            return
        }
        if call.options["summary"] is NSNull {
            finishEmpty(call, kind: LodyProviderQuotaWidgetStore.kind,
                        retain: { LodyProviderQuotaWidgetStore.retainIfOwned($0, from: defaults) },
                        clear: { LodyProviderQuotaWidgetStore.clear(from: defaults) })
            return
        }
        guard let raw = call.getObject("summary"),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              data.count <= LodyProviderQuotaWidgetStore.maximumBytes,
              let summary = try? JSONDecoder().decode(LodyProviderQuotaSummary.self, from: data),
              summary.isValid else {
            fail(call, "Invalid subscription quota widget summary.", code: "invalid_summary")
            return
        }
        do {
            try LodyProviderQuotaWidgetStore.save(summary, to: defaults)
            WidgetCenter.shared.reloadTimelines(ofKind: LodyProviderQuotaWidgetStore.kind)
            call.resolve()
        } catch {
            fail(call, "Failed to save subscription quota widget summary.", code: "save_failed")
        }
    }

    @objc public func syncTokenUsage(_ call: CAPPluginCall) {
        guard let defaults = LodyHomeWidgetStore.defaults() else {
            fail(call, "Home Screen widget shared container is unavailable.", code: "shared_container_unavailable")
            return
        }
        if call.options["summary"] is NSNull {
            LodyTokenUsageWidgetStore.clear(from: defaults)
            WidgetCenter.shared.reloadTimelines(ofKind: LodyTokenUsageWidgetStore.kind)
            call.resolve()
            return
        }
        guard let raw = call.getObject("summary"),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let summary = try? JSONDecoder().decode(LodyTokenWidgetSummary.self, from: data),
              summary.isValid else {
            fail(call, "Invalid Token usage widget summary.", code: "invalid_summary")
            return
        }
        do {
            try LodyTokenUsageWidgetStore.save(summary, to: defaults)
            WidgetCenter.shared.reloadTimelines(ofKind: LodyTokenUsageWidgetStore.kind)
            call.resolve()
        } catch {
            fail(call, "Failed to save Token usage widget summary.", code: "save_failed")
        }
    }
}
