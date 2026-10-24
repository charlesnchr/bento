import AppKit
import Testing
@testable import BentoShell

@Suite struct LaunchLifecycleTests {
    private func appEvent(_ id: AEEventID = AEEventID(kAEOpenApplication), reason: OSType? = nil,
                          activates: Bool? = nil) -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: id,
            targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        if let reason { event.setParam(NSAppleEventDescriptor(enumCode: reason), forKeyword: keyAEPropData) }
        if let activates { event.setParam(NSAppleEventDescriptor(boolean: activates), forKeyword: kAEApplicationActivationExpected) }
        return event
    }

    @Test func coldExplicitOpenSurvivesInitializationWithPermissionAlreadyGranted() {
        let launch = LaunchLifecycle()
        let request = LaunchLifecycle.Request.applicationOpen(appEvent())
        #expect(request == .settings)
        #expect(launch.receive(request!) == [])
        #expect(launch.finishLaunching(showSettings: false) == [.settings])
        #expect(launch.finishLaunching(showSettings: false) == [])
    }

    @Test func warmReopenRequestsSettingsAgainWithoutResettingItsPage() {
        let launch = LaunchLifecycle()
        _ = launch.finishLaunching(showSettings: false)
        let request = LaunchLifecycle.Request.applicationOpen(appEvent(AEEventID(kAEReopenApplication)))
        #expect(request == .settings)
        #expect(launch.receive(request!) == [.settings])
        let forwarded = request!.event(to: 12345)
        #expect(forwarded.eventID == kAEReopenApplication)
        #expect(forwarded.paramDescriptor(forKeyword: keyDirectObject) == nil)
    }

    @Test func loginServiceAndEventlessLaunchesStayQuiet() {
        for reason in [keyAELaunchedAsLogInItem, keyAELaunchedAsServiceItem] {
            #expect(LaunchLifecycle.Request.applicationOpen(appEvent(reason: reason)) == nil)
        }
        #expect(LaunchLifecycle.Request.applicationOpen(nil) == nil)
        let launch = LaunchLifecycle()
        #expect(launch.finishLaunching(showSettings: false) == [])
    }

    @Test func nativeBackgroundReopenDoesNotRequestSettings() {
        #expect(LaunchLifecycle.Request.applicationOpen(appEvent(AEEventID(kAEReopenApplication), activates: false)) == nil)
        #expect(LaunchLifecycle.Request.applicationOpen(appEvent(AEEventID(kAEReopenApplication), activates: true)) == .settings)
    }

    @Test func otherNativeEventsDoNotBecomeAppOpens() {
        for id in [kAEOpenDocuments, kAEPrintDocuments, kAEOpenContents, kAEQuitApplication] {
            #expect(LaunchLifecycle.Request.applicationOpen(appEvent(AEEventID(id))) == nil)
        }
        let url = LaunchLifecycle.Request.url(URL(string: "bento://action/windows.left-half")!).event(to: 12345)
        #expect(LaunchLifecycle.Request.applicationOpen(url) == nil)
    }

    @Test func coldActionURLWaitsForRegistrationWithoutOpeningSettings() {
        let launch = LaunchLifecycle()
        let action = LaunchLifecycle.Request.url(URL(string: "bento://action/windows.left-half")!)
        #expect(launch.receive(action) == [])
        #expect(launch.finishLaunching(showSettings: false) == [action])
        #expect(launch.receive(action) == [action])
    }

    @Test func explicitOverrideAndPermissionOnboardingKeepURLIntentLast() {
        let page = LaunchLifecycle.Request.url(URL(string: "bento://settings/shortcuts/%2F")!)
        let permissionLaunch = LaunchLifecycle()
        _ = permissionLaunch.receive(page)
        #expect(permissionLaunch.finishLaunching(showSettings: true) == [.settings, page])

        let forcedLaunch = LaunchLifecycle()
        _ = forcedLaunch.receive(.settings)
        #expect(forcedLaunch.finishLaunching(showSettings: true) == [.settings])
    }

    @Test func duplicateForwardsOpenAndCompleteURLsToTheSelectedPID() {
        let urls = ["bento://action/windows.left-half", "bento://settings/shortcuts/%2F", "bento://update/install"]
        let requests: [LaunchLifecycle.Request] = [.settings] + urls.map { .url(URL(string: $0)!) }
        let launch = LaunchLifecycle()
        for request in requests { _ = launch.receive(request) }
        var sent: [NSAppleEventDescriptor] = []
        launch.handOff { sent.append($0.event(to: 12345)) }
        #expect(sent.count == requests.count)
        #expect(launch.pending.isEmpty)
        for event in sent {
            #expect(event.attributeDescriptor(forKeyword: keyAddressAttr)?.data == NSAppleEventDescriptor(processIdentifier: 12345).data)
        }
        #expect(sent[0].eventClass == kCoreEventClass)
        #expect(sent[0].eventID == kAEReopenApplication)
        #expect(sent[0].paramDescriptor(forKeyword: kAEApplicationActivationExpected)?.booleanValue == true)
        for (event, url) in zip(sent.dropFirst(), urls) {
            #expect(event.eventClass == kInternetEventClass)
            #expect(event.eventID == kAEGetURL)
            #expect(event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue == url)
        }
    }

    @Test func failedHandoffRetainsUnacceptedRequestsForLocalHandling() {
        enum Failure: Error { case peerGone }
        let action = LaunchLifecycle.Request.url(URL(string: "bento://action/windows.left-half")!)
        let launch = LaunchLifecycle()
        _ = launch.receive(.settings)
        _ = launch.receive(action)
        var sent: [LaunchLifecycle.Request] = []
        do {
            try launch.handOff {
                if $0 == action { throw Failure.peerGone }
                sent.append($0)
            }
            Issue.record("The handoff should have failed")
        } catch {}
        #expect(sent == [.settings])
        #expect(launch.finishLaunching(showSettings: false) == [action])
    }

    @Test func quietDuplicateDoesNotSendAnActivationOrSettingsRequest() {
        let launch = LaunchLifecycle()
        launch.handOff { _ in Issue.record("Quiet launch must not contact the peer") }
        #expect(launch.pending.isEmpty)
    }

    @Test func requestArrivingDuringHandoffIsAlsoDelivered() {
        let launch = LaunchLifecycle()
        let action = LaunchLifecycle.Request.url(URL(string: "bento://action/windows.left-half")!)
        _ = launch.receive(.settings)
        var sent: [LaunchLifecycle.Request] = []
        launch.handOff { request in
            sent.append(request)
            if request == .settings { #expect(launch.receive(action) == []) }
        }
        #expect(sent == [.settings, action])
        #expect(launch.pending.isEmpty)
    }

    @Test func simultaneousLaunchesChooseTheSameOwnerRegardlessOfEnumerationOrder() {
        let early = LaunchPeer(pid: 800, launched: Date(timeIntervalSince1970: 1))
        let late = LaunchPeer(pid: 100, launched: Date(timeIntervalSince1970: 2))
        #expect(LaunchPeer.owner(in: [early, late]) == early.pid)
        #expect(LaunchPeer.owner(in: [late, early]) == early.pid)
        let tied = LaunchPeer(pid: 700, launched: early.launched)
        #expect(LaunchPeer.owner(in: [early, tied]) == tied.pid)
        #expect(LaunchPeer.owner(in: [tied, early]) == tied.pid)
        #expect(LaunchPeer.owner(in: [LaunchPeer(pid: 20, launched: nil), LaunchPeer(pid: 10, launched: nil)]) == 10)
        #expect(LaunchPeer.owner(in: [late]) == late.pid)
    }
}
