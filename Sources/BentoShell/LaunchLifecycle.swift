import AppKit

/// Launch requests can arrive before didFinishLaunching, before actions exist.
/// Keep the request (including the complete URL) until this copy can handle it
/// or an older running copy has accepted it.
/// Cocoa event ordering: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ScriptableCocoaApplications/SApps_handle_AEs/SAppsHandleAEs.html
final class LaunchLifecycle {
    enum Request: Equatable {
        case settings
        case url(URL)

        /// Cocoa's open-application event is distinct from a URL launch. Login
        /// and service launches put their reason in the keyAEPropData parameter.
        static func applicationOpen(_ event: NSAppleEventDescriptor?) -> Request? {
            guard let event, event.eventClass == kCoreEventClass,
                  event.eventID == kAEOpenApplication || event.eventID == kAEReopenApplication else { return nil }
            let reason = event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue
            guard reason != keyAELaunchedAsLogInItem, reason != keyAELaunchedAsServiceItem else { return nil }
            // AppleEvents.h documents this Boolean for reopen/document events,
            // not cold oapp events. Do not infer a cold-launch flag from it.
            if event.eventID == kAEReopenApplication,
               event.paramDescriptor(forKeyword: kAEApplicationActivationExpected)?.booleanValue == false { return nil }
            return .settings
        }

        /// Address the selected process, not a bundle URL that could resolve to
        /// this duplicate. Reopen preserves the recipient's selected Settings page.
        func event(to pid: pid_t) -> NSAppleEventDescriptor {
            let event: NSAppleEventDescriptor
            switch self {
            case .settings:
                event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass),
                    eventID: AEEventID(kAEReopenApplication), targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                event.setParam(NSAppleEventDescriptor(boolean: true), forKeyword: kAEApplicationActivationExpected)
            case .url(let url):
                event = NSAppleEventDescriptor(eventClass: AEEventClass(kInternetEventClass),
                    eventID: AEEventID(kAEGetURL), targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
                    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
                event.setParam(NSAppleEventDescriptor(string: url.absoluteString), forKeyword: keyDirectObject)
            }
            return event
        }
    }

    private var ready = false
    private(set) var pending: [Request] = []

    func receive(_ request: Request) -> [Request] {
        if ready { return [request] }
        pending.append(request)
        return []
    }

    func finishLaunching(showSettings: Bool) -> [Request] {
        ready = true
        defer { pending.removeAll() }
        // Keep the existing permission/explicit-environment onboarding behavior;
        // then let a settings URL select its page or an action take foreground.
        return (showSettings && !pending.contains(.settings) ? [.settings] : []) + pending
    }

    func handOff(send: (Request) throws -> Void) rethrows {
        while let request = pending.first {
            try send(request)
            pending.removeFirst()
        }
    }
}

/// A stable order prevents two simultaneous copies from both yielding. This is
/// not a lock: a peer may still quit after accepting a request.
struct LaunchPeer {
    let pid: pid_t
    let launched: Date?

    static func owner(in peers: [LaunchPeer]) -> pid_t? {
        peers.min {
            let a = $0.launched ?? .distantPast, b = $1.launched ?? .distantPast
            return a == b ? $0.pid < $1.pid : a < b
        }?.pid
    }
}
