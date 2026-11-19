// Maxbar — menu-bar control for pmset disablesleep + auto-join iPhone hotspot
// + lock-on-lid + Claude routing (Pool/Direct) toggle.
// Pure AppKit (NSStatusItem) — no SwiftUI menu quirks. Build: ./build.sh
import AppKit
import ServiceManagement
import CoreGraphics
import UserNotifications

let kLogPath = NSHomeDirectory() + "/Library/Logs/Maxbar.log"
let kPrefsAutoJoin = "autoJoin"
let kPrefsLockOnLid = "lockOnLid"
let kPrefsHotspotSSID = "hotspotSSID"
let kPollSeconds = 15.0
let kFastPollSeconds = 2.0
let kOfflineChecksBeforeDial = 2   // ~30s without internet before dialing the phone

/// The hotspot name is per-user configuration, never compiled in.
/// Set it in the menu ("Set hotspot name…"), or seed it on first launch with
/// `Maxbar --hotspot-ssid <name>` or the MAXBAR_HOTSPOT_SSID environment
/// variable; either is persisted to UserDefaults and wins only when nothing
/// is saved yet.
func seedHotspotNameFromEnvOrArgs() {
    guard UserDefaults.standard.object(forKey: kPrefsHotspotSSID) == nil else { return }
    var candidate = ""
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--hotspot-ssid"), i + 1 < args.count {
        candidate = args[i + 1]
    } else if let e = ProcessInfo.processInfo.environment["MAXBAR_HOTSPOT_SSID"] {
        candidate = e
    }
    candidate = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
    if !candidate.isEmpty {
        UserDefaults.standard.set(candidate, forKey: kPrefsHotspotSSID)
    }
}

/// Wi-Fi device (usually en0) detected instead of assumed, so the app works
/// on Macs where Wi-Fi is not en0.
let kWiFiDevice: String = {
    let (_, out) = run("/usr/sbin/networksetup", ["-listallhardwareports"], timeout: 10)
    let lines = out.split(separator: "\n").map(String.init)
    for (i, line) in lines.enumerated() where line.contains("Hardware Port: Wi-Fi") {
        for next in lines[(i + 1)...] {
            if next.hasPrefix("Device:"), let dev = next.split(separator: ":").last {
                let name = dev.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { return name }
            }
            if next.contains("Hardware Port:") { break }
        }
    }
    return "en0"
}()

func log(_ msg: String) {
    let line = ISO8601DateFormatter().string(from: Date()) + " " + msg + "\n"
    let data = Data(line.utf8)
    if let fh = FileHandle(forWritingAtPath: kLogPath) {
        fh.seekToEndOfFile(); fh.write(data); fh.closeFile()
    } else {
        try? data.write(to: URL(fileURLWithPath: kLogPath))
    }
}

/// Run a command, return (exitCode, stdout+stderr trimmed). Killed after `timeout`.
/// Output is drained BEFORE waiting for exit: a child that prints more than the
/// 64 KB pipe buffer otherwise blocks forever (this froze the whole app once).
func run(_ path: String, _ args: [String], timeout: TimeInterval = 20) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe; p.standardError = pipe
    do { try p.run() } catch { return (-1, "launch failed: \(error)") }
    let pid = p.processIdentifier
    let killer = DispatchWorkItem { kill(pid, SIGKILL) }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    killer.cancel()
    let out = String(data: data, encoding: .utf8) ?? ""
    return (p.terminationStatus, out.trimmingCharacters(in: .whitespacesAndNewlines))
}

/// Run blocking work off the main thread so the menu never freezes.
func offMain<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
    await Task.detached(priority: .utility) { work() }.value
}

func sleepDisabled() -> Bool? {
    // Real output line: " SleepDisabled\t\t1" — whitespace varies by macOS version.
    let (_, out) = run("/usr/bin/pmset", ["-g"])
    guard let line = out.split(separator: "\n").first(where: { $0.contains("SleepDisabled") })
    else { return nil }
    return line.hasSuffix("1")
}

/// The Mac actually reaches the internet. Having a Wi-Fi address is not enough:
/// a login-page network (airport, hotel) or a dead router still hands one out.
func internetReachable() -> Bool {
    let (code, out) = run("/usr/bin/curl",
                          ["-s", "-m", "5", "http://captive.apple.com/hotspot-detect.html"], timeout: 8)
    return code == 0 && out.contains("Success")
}

/// Session is currently showing the lock screen.
func sessionLocked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

/// The Mac is riding the iPhone hotspot. Detected by gateway address, not SSID:
/// iOS always uses 172.20.10.x for tethering, while macOS redacts the SSID
/// everywhere unless the caller has Location permission.
func onPhoneHotspot() -> Bool {
    let (_, out) = run("/sbin/route", ["-n", "get", "default"], timeout: 5)
    return out.contains("gateway: 172.20.10.")
}

func wifiRadioOn() -> Bool {
    let (_, out) = run("/usr/sbin/networksetup", ["-getairportpower", kWiFiDevice], timeout: 5)
    return out.contains(": On")
}

func setWifiRadio(_ on: Bool) {
    _ = run("/usr/sbin/networksetup", ["-setairportpower", kWiFiDevice, on ? "on" : "off"], timeout: 10)
}

// MARK: - Claude routing (~/.claude/settings.json env)

let kClaudeSettings = NSHomeDirectory() + "/.claude/settings.json"
let kPoolProxy = "http://127.0.0.1:3457"
let kPoolCA = NSHomeDirectory() + "/Library/Application Support/mkcert/rootCA.pem"

/// Pool = settings.json env carries the maxpool proxy; Direct = neither key present.
/// A missing settings.json is Direct (fresh install); an unparseable one is nil.
func claudeRoutingIsPool() -> Bool? {
    guard FileManager.default.fileExists(atPath: kClaudeSettings) else { return false }
    guard let data = FileManager.default.contents(atPath: kClaudeSettings),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    let env = root["env"] as? [String: Any] ?? [:]
    return env["HTTPS_PROXY"] as? String == kPoolProxy
}

/// Read-modify-write via python so every other key keeps its order and formatting
/// (the file round-trips byte-exact through json indent=2, ensure_ascii=False).
/// Atomic: write a sibling temp file with the same mode, then rename over.
func setClaudeRouting(pool: Bool) -> String? {
    let script = """
    import json, os, sys, tempfile
    path, mode, proxy, ca = sys.argv[1:5]
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        perm = os.stat(path).st_mode & 0o777
    else:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        raw, perm = "{}\\n", 0o600
    d = json.loads(raw)
    env = d.setdefault("env", {})
    if mode == "pool":
        env["HTTPS_PROXY"] = proxy
        env["NODE_EXTRA_CA_CERTS"] = ca
    else:
        env.pop("HTTPS_PROXY", None)
        env.pop("NODE_EXTRA_CA_CERTS", None)
    out = json.dumps(d, indent=2, ensure_ascii=False) + ("\\n" if raw.endswith("\\n") else "")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".settings.json.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(out)
        os.chmod(tmp, perm)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise
    """
    let (code, out) = run("/usr/bin/python3",
                          ["-c", script, kClaudeSettings, pool ? "pool" : "direct", kPoolProxy, kPoolCA],
                          timeout: 10)
    return code == 0 ? nil : (out.isEmpty ? "exit \(code)" : out)
}

/// Pool mode is only safe when this machine has the rc-gate proxy: its mkcert
/// root CA on disk AND something listening on the gate port. Otherwise flipping
/// to Pool would leave the Claude app unable to connect after its next restart.
/// Returns nil when ready, else a human-readable reason.
func poolPrerequisiteProblem() -> String? {
    guard FileManager.default.fileExists(atPath: kPoolCA) else {
        return "no mkcert root CA — set up tools/rc-gate first"
    }
    // Any HTTP answer (even an error status) means the gate is listening;
    // curl exit 7 = connection refused.
    let (code, _) = run("/usr/bin/curl", ["-s", "-o", "/dev/null", "-m", "2", kPoolProxy + "/"], timeout: 4)
    if code == 7 || code == 28 { return "pool proxy not running on \(kPoolProxy)" }
    return nil
}

/// Lid is physically closed (clamshell sensor).
func lidClosed() -> Bool {
    let (_, out) = run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"], timeout: 5)
    return out.contains("\"AppleClamshellState\" = Yes")
}

/// An external monitor is active (lid closed on purpose to work on a big screen).
func externalDisplayActive() -> Bool {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return false }
    return ids.prefix(Int(count)).contains { CGDisplayIsBuiltin($0) == 0 }
}

/// Lock the session with the same call as Apple menu → Lock Screen.
/// Falls back to sleeping the display ("require password immediately" is set).
func lockSession() -> String? {
    typealias LockFn = @convention(c) () -> Int32
    if let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
       let sym = dlsym(h, "SACLockScreenImmediate") {
        _ = unsafeBitCast(sym, to: LockFn.self)()
        return "system lock"
    }
    let (code, out) = run("/usr/bin/pmset", ["displaysleepnow"], timeout: 5)
    if code != 0 { log("displaysleepnow failed (code \(code)): \(out.prefix(120))"); return nil }
    return "display sleep"
}

/// Menu-bar notification; falls back to the in-menu error line if the user
/// hasn't granted notification permission (we never steal focus).
func notify(_ title: String, _ body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(identifier: "maxbar-\(UUID().uuidString)",
                                        content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
}

/// Wake an idle iPhone hotspot over Bluetooth — the same private Sharing.framework
/// call the Wi-Fi menu's "Personal Hotspot" entry makes. An idle phone stops
/// accepting joins (networksetup: "Could not find network" / -3900 tmpErr); this
/// brings the hotspot up and hands back its live password, which can differ from
/// the one saved in the keychain. Blocking; call off the main thread.
/// The password is never logged.
enum WakeResult: Sendable {
    case awake(password: String?)
    case failed(String)
}

final class HotspotWaker: NSObject, @unchecked Sendable {
    private let ssid: String
    private let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var session: NSObject?
    private var fired = false
    private var result: WakeResult = .failed("phone not seen over Bluetooth")

    static func wake(ssid: String, timeout: TimeInterval = 15) -> WakeResult {
        guard dlopen("/System/Library/PrivateFrameworks/Sharing.framework/Versions/A/Sharing", RTLD_LAZY) != nil,
              let cls = NSClassFromString("SFRemoteHotspotSession") as? NSObject.Type,
              let proto = objc_getProtocol("SFRemoteHotspotClient")
        else { return .failed("Sharing.framework unavailable") }
        class_addProtocol(HotspotWaker.self, proto)
        let w = HotspotWaker(ssid: ssid)
        let s = cls.init()
        w.session = s
        s.setValue(w, forKey: "delegate")
        s.perform(NSSelectorFromString("startBrowsing"))
        _ = w.done.wait(timeout: .now() + timeout)
        s.perform(NSSelectorFromString("stopBrowsing"))
        w.lock.lock(); defer { w.lock.unlock() }
        if w.fired, case .failed("phone not seen over Bluetooth") = w.result { return .failed("phone didn't answer the wake") }
        return w.result
    }

    private init(ssid: String) {
        self.ssid = ssid
        super.init()
    }

    @objc(session:updatedFoundDevices:) func updated(_ s: Any, _ list: Any) {
        lock.lock()
        guard !fired, let session,
              let dev = (list as? [NSObject])?.first(where: { ($0.value(forKey: "deviceName") as? String) == ssid })
        else { lock.unlock(); return }
        fired = true
        lock.unlock()
        // Completion block is (ssid, password, error) — verified on macOS 26 / iPhone 17 Pro Max.
        typealias Enable = @convention(c) (NSObject, Selector, NSObject,
                                           @escaping @convention(block) (AnyObject?, AnyObject?, AnyObject?) -> Void) -> Void
        let sel = NSSelectorFromString("enableHotspotForDevice:withCompletionHandler:")
        guard let imp = session.method(for: sel) else { finish(.failed("enable call missing")); return }
        unsafeBitCast(imp, to: Enable.self)(session, sel, dev) { [self] _, password, error in
            if let e = error as? NSError {
                finish(.failed("wake error \(e.code): \(e.localizedDescription)"))
            } else {
                finish(.awake(password: password as? String))
            }
        }
    }

    private func finish(_ r: WakeResult) {
        lock.lock(); result = r; lock.unlock()
        done.signal()
    }
}

enum DialResult: Sendable {
    case joined
    case radioRestored      // Wi-Fi was switched off; switched it on, dial next round
    case radioOff           // Wi-Fi is switched off and we were told to leave it
    case failed(String)
}

func dialHotspot(ssid: String, restoreRadio: Bool) -> DialResult {
    let (_, power) = run("/usr/sbin/networksetup", ["-getairportpower", kWiFiDevice])
    if power.contains("Off") {
        guard restoreRadio else { return .radioOff }
        _ = run("/usr/sbin/networksetup", ["-setairportpower", kWiFiDevice, "on"])
        return .radioRestored
    }
    // An idle phone won't accept a plain join; wake it over Bluetooth first and
    // join with the password it hands back. Falls back to the saved password.
    var args = ["-setairportnetwork", kWiFiDevice, ssid]
    switch HotspotWaker.wake(ssid: ssid) {
    case .awake(let password):
        if let password, !password.isEmpty { args.append(password) }
        Thread.sleep(forTimeInterval: 3)    // let the phone's Wi-Fi come up
    case .failed(let why):
        log("Bluetooth wake of \(ssid) failed: \(why)")
    }
    // networksetup exits 0 even on failure; it prints text only when the join failed.
    // Right after a wake the phone's Wi-Fi can lag a few seconds: retry transient errors.
    var out = ""
    for attempt in 1...3 {
        out = run("/usr/sbin/networksetup", args, timeout: 40).1
        if out.isEmpty { return .joined }
        let transient = out.contains("Could not find network") || out.contains("-3900")
        guard transient, attempt < 3 else { break }
        Thread.sleep(forTimeInterval: 4)
    }
    return .failed(out)
}

@MainActor
final class MaxbarController: NSObject, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var fastTimer: Timer?

    private var awake = true            // pmset disablesleep == 1
    private var online = true           // internet reachable
    private var offlineChecks = 0       // consecutive polls without internet
    private var joinAttempts = 0
    private var lastError: String?
    private var polling = false
    private var lidWasClosed = false
    private var checkingLid = false
    private var weKilledRadio = false   // we turned Wi-Fi off for lid-closed battery saving

    /// The user's Personal Hotspot name (UserDefaults; set from the menu).
    /// Empty = auto-join and manual join are inert until a name is set.
    private var hotspot: String {
        get { UserDefaults.standard.string(forKey: kPrefsHotspotSSID) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: kPrefsHotspotSSID) }
    }

    private var autoJoin: Bool {
        get {
            UserDefaults.standard.object(forKey: kPrefsAutoJoin) == nil
                ? true
                : UserDefaults.standard.bool(forKey: kPrefsAutoJoin)
        }
        set { UserDefaults.standard.set(newValue, forKey: kPrefsAutoJoin) }
    }

    private var lockOnLid: Bool {
        get {
            UserDefaults.standard.object(forKey: kPrefsLockOnLid) == nil
                ? true
                : UserDefaults.standard.bool(forKey: kPrefsLockOnLid)
        }
        set { UserDefaults.standard.set(newValue, forKey: kPrefsLockOnLid) }
    }

    override init() {
        super.init()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        menu.items = [
            stateItem, .separator(),
            toggleSleepItem, .separator(),
            setHotspotItem, autoJoinItem, joinNowItem, wifiStatusItem, errorItem,
            .separator(),
            screenLockItem,
            .separator(),
            claudeRoutingItem, claudeNoteItem,
            .separator(),
            loginItem, quitItem,
        ].compactMap { $0 }
        // Without an explicit target the actions go up the responder chain and never reach us.
        for item in [toggleSleepItem, setHotspotItem, autoJoinItem, joinNowItem, screenLockItem, claudeRoutingItem, loginItem, quitItem] {
            item.target = self
        }
        statusItem.menu = menu
        awake = sleepDisabled() ?? true
        renderMenu()
        log("Maxbar started (sleep \(awake ? "off" : "normal"), auto-join \(autoJoin ? "on" : "off"), hotspot \"\(hotspot)\")")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, err in
            log("Notification permission: \(granted ? "granted" : "denied")\(err.map { " (\($0.localizedDescription))" } ?? "")")
        }

        timer = Timer.scheduledTimer(withTimeInterval: kPollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
        // Lid watcher: with sleep off, closing the lid no longer triggers the system
        // lock (that lock rides on sleep). Check the lid every 2s and lock on close.
        fastTimer = Timer.scheduledTimer(withTimeInterval: kFastPollSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkLid() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in log("Mac woke up") }
        Task { await poll() }
    }

    // MARK: - Menu items

    private lazy var stateItem: NSMenuItem = {
        let i = NSMenuItem(title: "…", action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }()

    private lazy var toggleSleepItem = NSMenuItem(
        title: "Stay awake (sleepoff)", action: #selector(toggleSleep), keyEquivalent: "s")

    private lazy var setHotspotItem = NSMenuItem(
        title: "Set hotspot name…", action: #selector(setHotspot), keyEquivalent: "")

    private lazy var autoJoinItem = NSMenuItem(
        title: "Auto-join hotspot on Wi-Fi loss", action: #selector(toggleAutoJoin), keyEquivalent: "")

    private lazy var joinNowItem = NSMenuItem(
        title: "Join hotspot now", action: #selector(joinNow), keyEquivalent: "")

    private lazy var wifiStatusItem: NSMenuItem = {
        let i = NSMenuItem(title: "Internet: …", action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }()

    private lazy var errorItem: NSMenuItem = {
        let i = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        i.isEnabled = false; i.isHidden = true
        return i
    }()

    private lazy var screenLockItem = NSMenuItem(
        title: "Lock when lid closes (while awake)", action: #selector(toggleScreenLock), keyEquivalent: "")

    private lazy var claudeRoutingItem = NSMenuItem(
        title: "Claude routing: …", action: #selector(toggleClaudeRouting), keyEquivalent: "")

    private lazy var claudeNoteItem: NSMenuItem = {
        let i = NSMenuItem(title: "Takes effect when the Claude app is next restarted", action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }()

    private lazy var loginItem = NSMenuItem(
        title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")

    private lazy var quitItem = NSMenuItem(
        title: "Quit Maxbar", action: #selector(quit), keyEquivalent: "q")

    // MARK: - Actions

    @objc private func toggleSleep() {
        // Exact sudoers match in /etc/sudoers.d/sleep-control: /usr/bin/pmset -a disablesleep 0|1
        // (see sudoers-example next to this file for the one-time setup).
        let value = awake ? "0" : "1"
        Task {
            let (code, out) = await offMain {
                run("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-a", "disablesleep", value])
            }
            if code != 0 {
                lastError = "pmset failed: \(out)"
                log("pmset toggle failed (code \(code)): \(out)")
            } else {
                log("Sleep toggled to \(value) via menu bar")
            }
            awake = await offMain { sleepDisabled() } ?? awake
            renderMenu()
        }
    }

    @objc private func setHotspot() {
        let alert = NSAlert()
        alert.messageText = "Personal Hotspot name"
        alert.informativeText = "Your iPhone's hotspot name (iPhone Settings → Personal Hotspot →\n" +
            "Allow Others to Join shows it). Same Apple Account and Bluetooth on are needed\n" +
            "for the wake-before-join. Clear the field to turn dialing off."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = hotspot
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        // A menu-bar-only app is never frontmost; without this the dialog opens
        // behind whatever window is active.
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        hotspot = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        offlineChecks = 0
        lastError = nil
        log("Hotspot name set to \"\(hotspot)\"")
        renderMenu()
    }

    @objc private func toggleAutoJoin() {
        autoJoin.toggle()
        log("Auto-join \(autoJoin ? "enabled" : "disabled")")
        renderMenu()
    }

    private var manualJoining = false
    private var manualAttempt = 0

    @objc private func joinNow() {
        guard !manualJoining else { return }
        let ssid = hotspot
        guard !ssid.isEmpty else {
            lastError = "set the hotspot name first (Set hotspot name…)"
            renderMenu()
            return
        }
        manualJoining = true
        Task {
            defer { manualJoining = false; statusItem.button?.title = ""; renderMenu() }
            // The phone often stops accepting joins when idle; a single networksetup
            // call fails the moment the user taps it. A join can succeed up to
            // ~3 min later (user wakes the phone, taps Allow Others to Join).
            for attempt in 1...4 {
                manualAttempt = attempt
                switch await offMain({ dialHotspot(ssid: ssid, restoreRadio: true) }) {
                case .joined:
                    lastError = nil
                    log("Manual join OK (attempt \(attempt))")
                    notify("Joined \(ssid)", "Hotspot connected")
                    return
                case .radioRestored:
                    lastError = "Wi-Fi was off — switched it on, retrying…"
                    log("Manual join: Wi-Fi was off, switched it on")
                case .radioOff:
                    lastError = "Wi-Fi is switched off"
                    log("Manual join aborted: Wi-Fi radio is off")
                    return
                case .failed(let why):
                    lastError = why
                    log("Manual join attempt \(attempt) failed: \(why.prefix(160))")
                }
                if attempt < 4 {
                    statusItem.button?.title = " ⏳"
                    try? await Task.sleep(for: .seconds(8))
                }
            }
            notify("Couldn't join \(ssid)",
                   "The phone isn't accepting. Wake the iPhone and keep Personal Hotspot on, then click Join again.")
            log("Manual join: gave up after 4 attempts — phone not broadcasting")
        }
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            log("Launch at login now \(SMAppService.mainApp.status == .enabled ? "on" : "off")")
        } catch {
            lastError = "login item failed: \(error.localizedDescription)"
            log("login item failed: \(error)")
        }
        renderMenu()
    }

    @objc private func toggleScreenLock() {
        lockOnLid.toggle()
        log("Lock on lid close \(lockOnLid ? "enabled" : "disabled")")
        renderMenu()
    }

    @objc private func toggleClaudeRouting() {
        guard let isPool = claudeRoutingIsPool() else {
            lastError = "can't read ~/.claude/settings.json"
            renderMenu()
            return
        }
        Task {
            // Switching back to Direct is always allowed; switching to Pool only
            // when the proxy is actually there (probe runs off the main thread).
            if !isPool, let why = await offMain({ poolPrerequisiteProblem() }) {
                lastError = "Pool not available: \(why)"
                log("Claude routing: refused Pool — \(why)")
                renderMenu()
                return
            }
            if let err = await offMain({ setClaudeRouting(pool: !isPool) }) {
                lastError = "Claude routing change failed: \(err.prefix(100))"
                log("Claude routing change failed: \(err)")
            } else {
                lastError = nil
                log("Claude routing set to \(isPool ? "Direct" : "Pool")")
            }
            renderMenu()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - State

    /// Lid watcher: every 2s.
    /// - Sleep off: closing the lid no longer triggers the system lock (that lock
    ///   rides on sleep) — lock it ourselves.
    /// - Sleep on + riding the phone hotspot: a closed lid sleeps the Mac, but
    ///   maintenance wakes keep re-associating to the hotspot all night, waking
    ///   the phone's hotspot too. Turn the radio off; restore it on lid open.
    func checkLid() async {
        guard !checkingLid else { return }
        checkingLid = true
        defer { checkingLid = false }

        let closed = await offMain { lidClosed() }
        defer { lidWasClosed = closed }

        if closed, !lidWasClosed, lockOnLid, awake, !sessionLocked() {
            if externalDisplayActive() {
                log("Lid closed with external monitor — not locking")
            } else if let how = lockSession() {
                try? await Task.sleep(for: .seconds(1))
                log("Lid closed — locked via \(how), lock screen up: \(sessionLocked() ? "yes" : "NO")")
            }
            return
        }

        if closed, !awake {
            if !weKilledRadio, await offMain({ onPhoneHotspot() && wifiRadioOn() }) {
                await offMain { setWifiRadio(false) }
                weKilledRadio = true
                log("Lid closed (sleep-on) while on phone hotspot — Wi-Fi off to save both batteries")
            }
        } else if !closed, weKilledRadio {
            await offMain { setWifiRadio(true) }
            weKilledRadio = false
            log("Lid opened — Wi-Fi back on")
        }
    }

    /// Poll world state, drive the watchdog, refresh the icon.
    func poll() async {
        guard !polling else { return }
        polling = true
        defer { polling = false }

        let prevAwake = awake
        let prevOnline = online
        let (nowAwake, nowOnline) = await offMain { (sleepDisabled(), internetReachable()) }
        awake = nowAwake ?? awake
        online = nowOnline

        if prevAwake != awake { log("pmset state changed: \(awake ? "awake (sleepoff)" : "normal (sleepon)")") }
        if prevOnline != online { log(online ? "Internet back" : "Internet lost") }

        // Watchdog: no internet for a couple of checks + autoJoin on + a hotspot
        // name configured -> dial the phone. A Wi-Fi radio that was switched off
        // is only switched back on in sleep-off mode (unattended); otherwise
        // switching it off is the user's call.
        if online {
            offlineChecks = 0
            joinAttempts = 0
            lastError = nil
        } else {
            offlineChecks += 1
            // Don't dial from the watchdog while a manual "Join now" burst runs —
            // two joiners fight and the radio cycle can kill the manual attempt.
            let ssid = hotspot
            if !manualJoining, !ssid.isEmpty, autoJoin && awake && offlineChecks >= kOfflineChecksBeforeDial {
                let restoreRadio = awake
                switch await offMain({ dialHotspot(ssid: ssid, restoreRadio: restoreRadio) }) {
                case .joined:
                    log("Joined \(ssid) after \(joinAttempts + 1) attempt(s)")
                    joinAttempts = 0
                    offlineChecks = 0       // give the new link time before re-dialing
                    lastError = nil
                case .radioRestored:
                    log("Wi-Fi radio was off — turned it back on")
                    lastError = nil
                case .radioOff:
                    lastError = "Wi-Fi is switched off"
                case .failed(let why):
                    joinAttempts += 1
                    if joinAttempts % 4 == 1 { log("Join attempt \(joinAttempts) failed: \(why.prefix(120))") }
                    lastError = why
                    // Every ~2 min of failures, cycle the radio: airportd's scan
                    // can go stale exactly when an idle iPhone hotspot half-wakes.
                    if joinAttempts % 8 == 0, await offMain({ wifiRadioOn() }) {
                        log("Still unreachable after \(joinAttempts) tries — cycling Wi-Fi radio for a fresh scan")
                        await offMain {
                            setWifiRadio(false)
                            Thread.sleep(forTimeInterval: 2)
                            setWifiRadio(true)
                        }
                    }
                }
            }
        }
        renderMenu()
    }

    private func renderMenu() {
        let ssid = hotspot
        statusItem.button?.image = NSImage(
            systemSymbolName: awake ? "cup.and.saucer.fill" : "zzz",
            accessibilityDescription: awake ? "Staying awake" : "Normal sleep")

        stateItem.title = awake ? "Staying awake — lid-safe" : "Normal sleep"
        toggleSleepItem.title = awake ? "Allow sleep (sleepon)" : "Stay awake (sleepoff)"
        setHotspotItem.title = ssid.isEmpty ? "Set hotspot name… (required for auto-join)" : "Set hotspot name… (\(ssid))"
        autoJoinItem.state = autoJoin ? .on : .off
        joinNowItem.isHidden = !autoJoin || ssid.isEmpty
        wifiStatusItem.isHidden = !autoJoin
        if manualJoining {
            wifiStatusItem.title = "Joining \(ssid)… (attempt \(manualAttempt)/4)"
        } else if ssid.isEmpty {
            wifiStatusItem.title = "Hotspot name not set — use Set hotspot name…"
        } else if online {
            wifiStatusItem.title = "Internet: connected"
        } else if !awake {
            wifiStatusItem.title = "No internet (dials only in stay-awake mode)"
        } else if offlineChecks < kOfflineChecksBeforeDial {
            wifiStatusItem.title = "Internet: checking…"
        } else {
            wifiStatusItem.title = "No internet — dialing \(ssid) (attempt \(joinAttempts + 1))"
        }
        errorItem.isHidden = lastError == nil
        if let err = lastError { errorItem.title = "! \(err)" }
        screenLockItem.state = lockOnLid ? .on : .off
        switch claudeRoutingIsPool() {
        case .some(true):  claudeRoutingItem.title = "Claude routing: Pool (click for Direct)"
        case .some(false): claudeRoutingItem.title = "Claude routing: Direct (click for Pool)"
        case .none:        claudeRoutingItem.title = "Claude routing: settings unreadable"
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    // MARK: - NSMenuDelegate — show fresh sleep state every time the menu opens

    func menuNeedsUpdate(_ menu: NSMenu) {
        awake = sleepDisabled() ?? awake
        renderMenu()
    }
}

@main
enum MaxbarApp {
    static func main() {
        seedHotspotNameFromEnvOrArgs()
        let app = NSApplication.shared
        let controller = MaxbarController()   // strong ref for the app lifetime
        app.run()
        _ = controller
    }
}
