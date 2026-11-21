// Maxbar — menu-bar control for pmset disablesleep + auto-join iPhone hotspot
// + lock-on-lid + Claude and Codex routing switches.
// Pure AppKit (NSStatusItem) — no SwiftUI menu quirks. Build: ./build.sh
import AppKit
import ServiceManagement
import CoreGraphics
import UserNotifications
import CoreWLAN

let kLogPath = NSHomeDirectory() + "/Library/Logs/Maxbar.log"
let kPrefsAutoJoin = "autoJoin"
let kPrefsLockOnLid = "lockOnLid"
let kPrefsHotspotSSID = "hotspotSSID"
let kPollSeconds = 15.0
let kFastPollSeconds = 2.0
let kOfflineChecksBeforeDial = 2        // ~30s without internet before dialing the phone
let kOfflineChecksWhenAssociated = 4    // ~60s when Wi-Fi is still associated to SOME network
                                        // (false-dial fix: transient probe failures at screen
                                        // lock must not switch the Mac to the phone)
let kHotspotLookbackChecks = 4          // on the phone: look for remembered Wi-Fi every ~60s
let kWiFiTrialSeconds = 45.0            // a newly joined Wi-Fi must show internet within this
let kWiFiCooldownSeconds = 600.0        // a Wi-Fi with no internet sits out 10 min, doubling
let kWiFiCooldownMaxSeconds = 7200.0    // per repeat failure, capped at 2 h (car Wi-Fi etc.)
let kDeadPhoneRedialChecks = 8          // on the phone with no internet: re-dial every ~2-4 min

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

/// The saved Personal Hotspot name ("" = not set yet).
func hotspotName() -> String {
    (UserDefaults.standard.string(forKey: kPrefsHotspotSSID) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
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

/// Test switch to rehearse the screen-lock hiccup: makes both checks fail.
/// `defaults write com.maxpool.maxbar simulateProbeFailureUntil -date "$(date -u -v+60S '+%Y-%m-%d %H:%M:%S +0000')"`
/// It always expires (capped at 15 min from now) and the menu shows it while on.
func simulatedOutageActive() -> Bool {
    guard let until = UserDefaults.standard.object(forKey: "simulateProbeFailureUntil") as? Date else { return false }
    return Date() < until && until.timeIntervalSinceNow <= 900
}

/// The Mac actually reaches the internet. Having a Wi-Fi address is not enough:
/// a login-page network (airport, hotel) or a dead router still hands one out.
/// Two real web checks from two companies (Apple, then Google) — either passing
/// counts as online. One endpoint fails transiently (especially right after display
/// sleep at screen lock), which used to make the app dial the phone over healthy
/// Wi-Fi. Both are page fetches, not DNS lookups: a hotel login page answers DNS
/// but serves its own page, and must still read as offline.
func internetReachable() -> Bool {
    if simulatedOutageActive() { return false }
    let (code, out) = run("/usr/bin/curl",
                          ["-s", "-m", "5", "http://captive.apple.com/hotspot-detect.html"], timeout: 8)
    if code == 0 && out.contains("Success") { return true }
    let (gCode, gOut) = run("/usr/bin/curl",
                            ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}",
                             "http://connectivitycheck.gstatic.com/generate_204"], timeout: 8)
    return gCode == 0 && gOut == "204"
}

/// Wi-Fi is associated to SOME network (any SSID, ours or not). Used by the
/// watchdog to tell "Wi-Fi link lost" (dial fast) from "link fine but probes
/// failing" (wait longer — the network usually recovers on its own).
/// NOTE: `networksetup -getairportnetwork` LIES on this Mac ("not associated"
/// while fully connected) because macOS redacts Wi-Fi info without Location
/// permission — the same redaction the README notes for SSID. `ipconfig
/// getsummary` prints an SSID key (value redacted) only while associated.
/// A failed or empty read counts as associated: when unsure, take the slower,
/// safer path (wait longer) rather than dial the phone early.
func wifiAssociated() -> Bool {
    let (code, out) = run("/usr/sbin/ipconfig", ["getsummary", kWiFiDevice], timeout: 5)
    if code != 0 || out.isEmpty { return true }
    return out.split(separator: "\n").contains {
        $0.trimmingCharacters(in: .whitespaces).hasPrefix("SSID :")   // not "BSSID :"
    }
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

/// Which network the Mac is on, without its (hidden) name: default gateway + Wi-Fi
/// channel. nil when there is no Wi-Fi link or no default route.
func wifiLinkFingerprint() -> String? {
    let (_, out) = run("/sbin/route", ["-n", "get", "default"], timeout: 5)
    guard out.contains("interface: \(kWiFiDevice)"),
          let gw = out.split(separator: "\n").first(where: { $0.contains("gateway:") })?
              .split(separator: ":").last?.trimmingCharacters(in: .whitespaces),
          let ch = CWWiFiClient.shared().interface()?.wlanChannel()
    else { return nil }
    return "\(gw)/\(ch.channelNumber)/\(ch.channelBand.rawValue)"
}

func wifiRadioOn() -> Bool {
    let (_, out) = run("/usr/sbin/networksetup", ["-getairportpower", kWiFiDevice], timeout: 5)
    return out.contains(": On")
}

/// Remembered Wi-Fi networks, highest priority first (the Wi-Fi menu's order),
/// minus the phone hotspot. This list prints names even without Location permission.
func preferredWiFiNetworks() -> [String] {
    let phone = hotspotName()
    let (_, out) = run("/usr/sbin/networksetup",
                       ["-listpreferredwirelessnetworks", kWiFiDevice], timeout: 8)
    return out.split(separator: "\n").dropFirst().compactMap { line in
        let s = line.trimmingCharacters(in: .whitespaces)
        // "DIRECT-" is the Wi-Fi Direct prefix (printers, cars): device links, never internet.
        if s.isEmpty || s == phone || s.hasPrefix("DIRECT-") { return nil }
        return s
    }
}

/// Which remembered Wi-Fi networks are in range (best first), and which one we're on.
/// Works with Location Services OFF: macOS hides names in scan results, but a scan
/// ASKED FOR one name returns only that network — verified 2026-11-10 on this Mac
/// (a home network → found, a made-up name → nothing). One real scan (~12s) refreshes
/// macOS's scan cache; the by-name lookups then answer from it (~30ms each,
/// 244 remembered networks ≈ 7s). Blocking: call off the main thread.
/// The network we're on = the only in-range one on our radio channel (current name
/// is hidden too); ambiguous or on the phone → nil.
struct WiFiSurvey: Sendable {
    let inRange: [String]
    let current: String?
}

let kSurveyBudgetSeconds = 25.0   // locked-screen scans measured ~70s for all 244 names (2026-11-10)

func surveyKnownWiFi(onPhone: Bool) -> WiFiSurvey {
    guard let iface = CWWiFiClient.shared().interface() else { return WiFiSurvey(inRange: [], current: nil) }
    _ = try? iface.scanForNetworks(withName: nil)
    let mine = onPhone ? nil : iface.wlanChannel()
    var inRange: [String] = []
    var onMyChannel: [(name: String, rssiGap: Int)] = []
    // Best-first, time-boxed: with the screen locked macOS scans far slower, so stop
    // looking after the budget — the networks you use most are checked first.
    let deadline = Date() + kSurveyBudgetSeconds
    var cutShort = false
    // Excluded names are scanned on purpose: spotting the network we are on (the lone
    // on-channel match) needs them, and skipping an excluded current network would let
    // a neighbour on our channel be mistaken for it and benched. They are filtered out
    // of the join candidates afterwards (eligibleWiFiCandidates), never from the scan.
    for name in preferredWiFiNetworks() {
        if Date() > deadline { cutShort = true; break }
        guard let hits = try? iface.scanForNetworks(withName: name), !hits.isEmpty else { continue }
        inRange.append(name)
        if let mine, let hit = hits.first(where: {
            $0.wlanChannel?.channelNumber == mine.channelNumber && $0.wlanChannel?.channelBand == mine.channelBand
        }) { onMyChannel.append((name, abs(hit.rssiValue - iface.rssiValue()))) }
    }
    // Two remembered networks on our channel: the one whose signal matches ours is us.
    let ranked = onMyChannel.sorted { $0.rssiGap < $1.rssiGap }
    // A search cut short may have skipped the network we're really on, so a lone
    // match could be a neighbour on our channel — only trust it on a full search.
    let current: String? = (ranked.count == 1 && !cutShort) || (ranked.count > 1 && ranked[1].rssiGap - ranked[0].rssiGap >= 10)
        ? ranked.first?.name : nil
    if cutShort { log("Wi-Fi search cut at \(Int(kSurveyBudgetSeconds))s after \(inRange.count) in-range match(es)") }
    return WiFiSurvey(inRange: inRange, current: current)
}

/// Join a remembered network with its saved password. nil = joined.
/// networksetup exits 0 even on failure and prints text only when the join failed;
/// a join killed at the timeout exits non-zero with no text — that is a failure too.
func joinWiFi(_ ssid: String) -> String? {
    let (code, out) = run("/usr/sbin/networksetup", ["-setairportnetwork", kWiFiDevice, ssid], timeout: 40)
    if code == 0 && out.isEmpty { return nil }
    return out.isEmpty ? "join timed out (exit \(code))" : out
}

func setWifiRadio(_ on: Bool) {
    _ = run("/usr/sbin/networksetup", ["-setairportpower", kWiFiDevice, on ? "on" : "off"], timeout: 10)
}

// MARK: - Claude routing (~/.claude/settings.json env)

let kClaudeSettings = NSHomeDirectory() + "/.claude/settings.json"
var kPoolProxy: String {
    let configured = UserDefaults.standard.object(forKey: "claudeGatePort") as? Int
    let port = configured.flatMap { (1024...65535).contains($0) ? $0 : nil } ?? 3457
    return "http://127.0.0.1:\(port)"
}
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
    guard let helper = Bundle.main.path(forResource: "claude-routing", ofType: "py") else {
        return "Claude routing helper is missing"
    }
    let (code, out) = run("/usr/bin/python3",
                          [helper, kClaudeSettings, pool ? "pool" : "direct", kPoolProxy, kPoolCA],
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

func changeCodexRouting(_ action: String) -> (Int32, String) {
    guard let helper = Bundle.main.path(forResource: "codex-routing", ofType: "py") else {
        return (1, "Codex routing helper is missing")
    }
    return run("/usr/bin/python3", [helper, action], timeout: 25)
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
        let (code, text) = run("/usr/sbin/networksetup", args, timeout: 40)
        out = text.isEmpty && code != 0 ? "join timed out (exit \(code))" : text
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
    private var codexRoutingMode: String?
    private var codexRoutingBusy = false
    private var codexRoutingReadID: UUID?
    private var polling = false
    private var lidWasClosed = false
    private var checkingLid = false
    private var weKilledRadio = false   // we turned Wi-Fi off for lid-closed battery saving
    private var hotspotOutageLogged = false  // one "not re-dialing" line per hotspot outage
    private var hotspotOnlineChecks = 0      // polls on the phone with internet (Wi-Fi look-back pacing)
    private var trialWiFi: (ssid: String, at: Date, fromPhone: Bool)?  // just joined; must show internet
    private var renderedExclusions: [String]?               // list the exclusion submenu was built from
    private var addingExclusion = false                     // "Add network…" is loading names or showing its dialog
    private var wifiCooldown: [String: Date] = [:]          // Wi-Fi that had no internet → retry after
    private var wifiFailures: [String: Int] = [:]           // repeat failures → longer cooldown
    private var handJoined = false          // "Join hotspot now" chose the phone: stay until the Mac leaves it
    private var offPhonePolls = 0           // consecutive polls off the phone (ends a hand-join)
    private var outageSawAssociation = false  // Wi-Fi looked associated at any point this outage
    private var onHotspotNow = false          // last poll's reading, for the menu text
    private var returningToPhone = false      // left a working phone and lost the Wi-Fi: get back
    private var benchedCurrent: String?   // the Wi-Fi we were on when it lost internet
    // A closed lid weakens the Mac's Wi-Fi (the antennas sit in the display): the
    // office Wi-Fi drops and every search comes up empty (seen 2026-11-14). Anything
    // judged while the lid was closed is forgiven on open, and the open triggers an
    // immediate look for remembered Wi-Fi instead of waiting for the next ~60s round.
    private var benchedWhileLidClosed: Set<String> = []
    private var lookForWiFiNow = false
    // macOS joining a different Wi-Fi on its own mid-outage (seen 2026-11-14 11:04:
    // the app then swapped it for the phone a minute later): a new link gets a fresh
    // outage clock. Fingerprint = gateway + radio channel (names are hidden).
    private var linkFingerprint: String?
    private var outageClockReset = false   // once per outage, so constant hopping can't block the phone

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
            setHotspotItem, autoJoinItem, joinNowItem, excludedWiFiItem, wifiStatusItem, errorItem,
            .separator(),
            screenLockItem,
            .separator(),
            claudeRoutingItem, claudeNoteItem,
            codexRoutingItem, codexNoteItem,
            .separator(),
            loginItem, quitItem,
        ].compactMap { $0 }
        // Without an explicit target the actions go up the responder chain and never reach us.
        for item in [toggleSleepItem, setHotspotItem, autoJoinItem, joinNowItem, screenLockItem, claudeRoutingItem, codexRoutingItem, loginItem, quitItem] {
            item.target = self
        }
        statusItem.menu = menu
        awake = sleepDisabled() ?? true
        renderMenu()
        refreshCodexRouting()
        if simulatedOutageActive() { log("TEST: simulated outage is ON (expires by itself)") }
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

    private lazy var excludedWiFiItem = NSMenuItem(
        title: "Excluded Wi-Fi networks", action: nil, keyEquivalent: "")

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

    private lazy var codexRoutingItem = NSMenuItem(
        title: "Codex routing: …", action: #selector(toggleCodexRouting), keyEquivalent: "")

    private lazy var codexNoteItem: NSMenuItem = {
        let item = NSMenuItem(title: "Restart Codex, then start a new chat", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
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
        // The hotspot is dialed by its own path and cannot be excluded: drop a stale entry.
        var droppedExclusion = false
        if !hotspot.isEmpty, WiFiExclusionStore().remove(hotspot) {
            droppedExclusion = true
            log("Wi-Fi exclusion dropped: it is now the hotspot name")
        }
        offlineChecks = 0
        lastError = nil
        log("Hotspot name set to \"\(hotspot)\"")
        renderMenu()
        if droppedExclusion {
            showInfo("Exclusion removed",
                     "\(displaySSID(hotspot)) is your hotspot now. Maxbar dials the hotspot on its own, " +
                     "so it can't be on the excluded list; the exclusion was removed.")
        }
    }

    /// A plain "FYI" dialog for outcomes that are neither errors nor worth a banner.
    private func showInfo(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
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
                    handJoined = true   // you chose the phone (owner 2026-11-10): no time limit
                    trialWiFi = nil
                    returningToPhone = false
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

    private func refreshCodexRouting() {
        guard !codexRoutingBusy, codexRoutingReadID == nil else { return }
        let readID = UUID()
        codexRoutingReadID = readID
        Task {
            let (code, mode) = await offMain { changeCodexRouting("status") }
            guard codexRoutingReadID == readID else { return }
            codexRoutingReadID = nil
            codexRoutingMode = code == 0 ? mode : nil
            renderMenu()
        }
    }

    @objc private func toggleCodexRouting() {
        guard !codexRoutingBusy, let mode = codexRoutingMode else { return }
        let action = mode == "Pool" ? "direct" : "pool"
        codexRoutingReadID = nil
        codexRoutingBusy = true
        renderMenu()
        Task {
            let (code, result) = await offMain { changeCodexRouting(action) }
            if code == 0 {
                codexRoutingMode = result
                lastError = nil
                log("Codex routing set to \(result)")
            } else {
                lastError = "Codex routing: \(result.prefix(110))"
                log("Codex routing change failed: \(result)")
            }
            codexRoutingBusy = false
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
        let wasClosed = lidWasClosed
        defer { lidWasClosed = closed }

        if !closed, wasClosed {
            if !benchedWhileLidClosed.isEmpty {
                for ssid in benchedWhileLidClosed { wifiCooldown[ssid] = nil; wifiFailures[ssid] = nil }
                log("Lid opened — giving \(benchedWhileLidClosed.sorted().joined(separator: ", ")) another chance")
                benchedWhileLidClosed = []
            }
            lookForWiFiNow = true
            // Let the radio re-hear the networks for a few seconds, then look.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(5))
                await self?.poll()
            }
        }

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

    /// Bench a Wi-Fi that showed no internet: 10 min, doubling per repeat failure,
    /// capped (a car Wi-Fi with no uplink stays in range for hours). A pass resets it.
    private func bench(_ ssid: String, now: Date, why: String = "has no internet") {
        let n = (wifiFailures[ssid] ?? 0) + 1
        wifiFailures[ssid] = n
        let secs = min(kWiFiCooldownSeconds * pow(2, Double(n - 1)), kWiFiCooldownMaxSeconds)
        wifiCooldown[ssid] = now + secs
        if lidWasClosed { benchedWhileLidClosed.insert(ssid) }
        log("\(ssid) \(why) — not trying it again for \(Int(secs / 60)) min\(lidWasClosed ? " (or until the lid opens)" : "")")
    }

    /// Join the best remembered Wi-Fi in range, trying each candidate in order.
    /// true = joined; the join then gets a trial period before the watchdog trusts it.
    @discardableResult
    private func tryKnownWiFi(reason: String, fromPhone: Bool, benchCurrent: Bool = false) async -> Bool {
        let onPhone = fromPhone || onHotspotNow   // on the phone, our channel is the phone's
        let survey = await offMain { surveyKnownWiFi(onPhone: onPhone) }
        // The search takes up to ~25s; the internet may have come back meanwhile
        // (seen 2026-11-10: a hiccup ended mid-search and the app still benched
        // a healthy home Wi-Fi). Re-check before calling the Wi-Fi we're on dead.
        if benchCurrent, await offMain({ internetReachable() }) {
            log("Internet came back during the Wi-Fi search — staying put")
            offlineChecks = 0
            return false
        }
        // The Wi-Fi we're on just failed: bench it once so it isn't picked again.
        if benchCurrent, let current = survey.current, wifiCooldown[current] == nil {
            bench(current, now: Date())
            benchedCurrent = current
        }
        let stored = WiFiExclusionStore().read()
        if stored.dropped > 0 { log("Wi-Fi exclusion list: \(stored.dropped) unreadable entr(ies) ignored") }
        let excluded = stored.names
        let candidates = eligibleWiFiCandidates(
            inRange: survey.inRange, current: survey.current,
            cooldown: Set(wifiCooldown.keys), excluded: excluded)
        let heldBack = excludedInRange(inRange: survey.inRange, excluded: excluded)
        if !heldBack.isEmpty {
            log("Not joining \(heldBack.count) excluded Wi-Fi network(s) in range (\(reason))")
        }
        for ssid in candidates {
            if manualJoining { return false }          // "Join now" started meanwhile
            // The list can change during the ~25s search: look again right before joining.
            if WiFiExclusionStore().contains(ssid) { continue }
            if let err = await offMain({ joinWiFi(ssid) }) {
                log("Known Wi-Fi \(ssid) in range (\(reason)) but join failed: \(err.prefix(120))")
                bench(ssid, now: Date(), why: "didn't join")
                // A failed join can knock the Mac off the phone: make sure it gets back.
                if fromPhone { returningToPhone = true }
                continue
            }
            log("Joined known Wi-Fi \(ssid) (\(reason))")
            benchedCurrent = nil    // we're moving on; that bench isn't ours to lift
            trialWiFi = (ssid, Date(), fromPhone)
            offlineChecks = 0
            hotspotOnlineChecks = 0
            lastError = nil
            return true
        }
        return false
    }

    /// Watchdog dial of the phone. `onlyIfOffline`: every ordinary reason to dial is
    /// "no internet", so confirm it right before waking the phone. The one exception
    /// is getting off a stranger's iPhone, which has internet by definition.
    private func dialPhone(onlyIfOffline: Bool = true) async {
        guard !manualJoining else { return }    // "Join now" may have started during a survey
        let ssid = hotspot
        guard !ssid.isEmpty else { return }     // no hotspot name set: never dial
        if onlyIfOffline, await offMain({ internetReachable() }) {
            log("Internet is back — not dialing \(ssid)")
            offlineChecks = 0
            return
        }
        let restoreRadio = awake    // re-enable a switched-off radio only when unattended
        switch await offMain({ dialHotspot(ssid: ssid, restoreRadio: restoreRadio) }) {
        case .joined:
            log("Joined \(ssid) after \(joinAttempts + 1) attempt(s)")
            benchedCurrent = nil
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
            // Every 8 failed tries, cycle the radio: airportd's scan can go stale
            // exactly when an idle iPhone hotspot half-wakes.
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

        // Watchdog. Order of preference: the Wi-Fi we're on → any other remembered
        // Wi-Fi in range → the phone (last resort, stay-awake mode only). While on a
        // phone link — however it got there (the app, macOS's own auto-join, an app
        // restart) — a remembered Wi-Fi in range wins (owner 2026-11-10). Only a phone
        // you joined with "Join hotspot now" is left alone until the Mac leaves it.
        let onHotspot = await offMain { onPhoneHotspot() }
        onHotspotNow = onHotspot
        let fingerprint = await offMain { wifiLinkFingerprint() }
        defer { linkFingerprint = fingerprint }
        // A hand-join lasts until the Mac is off the phone (two readings in a row, so one
        // failed route lookup doesn't end it); a later rejoin by macOS isn't your choice.
        offPhonePolls = onHotspot ? 0 : offPhonePolls + 1
        if offPhonePolls >= 2 { handJoined = false }
        if onHotspot || online { returningToPhone = false }
        let now = Date()
        wifiCooldown = wifiCooldown.filter { $0.value > now }
        var dialNow = false

        // Just switched to a Wi-Fi network: it must show internet within ~45s.
        if let trial = trialWiFi {
            if online && !onHotspot {
                log("\(trial.ssid): internet OK")
                wifiFailures[trial.ssid] = nil
                trialWiFi = nil
            } else if onHotspot {
                // A phone gateway right after joining a Wi-Fi: either macOS fell back to
                // your hotspot, or that "Wi-Fi" was someone else's iPhone (every iPhone hotspot
                // uses the same 172.20.10.x gateway, so the two can't be told apart). Either way:
                // bench it (backoff stops repeats) and dial your hotspot explicitly — a harmless
                // rejoin if we're already on it, and off a stranger's phone if not.
                bench(trial.ssid, now: now, why: "led to a phone hotspot")
                trialWiFi = nil
                if autoJoin { await dialPhone(onlyIfOffline: false) }
                renderMenu()
                return
            } else if now.timeIntervalSince(trial.at) >= kWiFiTrialSeconds {
                bench(trial.ssid, now: now)
                trialWiFi = nil
                if trial.fromPhone {
                    // We left a working phone for it: go back, whatever the mode,
                    // and keep trying until we're on it (one dial can fail).
                    returningToPhone = true
                    if autoJoin, !manualJoining { await dialPhone() }
                    renderMenu()
                    return
                }
                dialNow = true
            }
        }

        if online {
            offlineChecks = 0
            joinAttempts = 0
            hotspotOutageLogged = false
            outageSawAssociation = false
            outageClockReset = false
            lastError = nil
            // Back online off the phone: the Wi-Fi we benched at the outage works again.
            if !onHotspot, let b = benchedCurrent {
                wifiFailures[b] = nil
                wifiCooldown[b] = nil
                benchedCurrent = nil
            }
            // On the phone with internet: every ~60s look for Wi-Fi (not while a hand-join is fresh).
            if onHotspot, !handJoined, autoJoin, !manualJoining, trialWiFi == nil {
                hotspotOnlineChecks += 1
                if lookForWiFiNow || hotspotOnlineChecks % kHotspotLookbackChecks == 0 {
                    lookForWiFiNow = false
                    await tryKnownWiFi(reason: "leaving the phone", fromPhone: true)
                }
            } else {
                hotspotOnlineChecks = 0
            }
            if !onHotspot { lookForWiFiNow = false }
        } else if trialWiFi == nil {
            offlineChecks += 1
            // macOS moved to a different network on its own: give it the full wait
            // before judging it, instead of the clock left over from the old one.
            if !onHotspot, !outageClockReset, let prev = linkFingerprint, let cur = fingerprint, prev != cur {
                log("macOS switched to another Wi-Fi during the outage — giving it time")
                offlineChecks = 1
                outageClockReset = true
            }
            // Wi-Fi associated at ANY point this outage means the link was up and the
            // probes were failing transiently (typically right after screen lock) —
            // demand a longer outage before switching away. Sticky per outage: one
            // momentary "disconnected" reading must not bring back the 30s dial.
            let associated = await offMain { wifiAssociated() }
            if associated { outageSawAssociation = true }
            if offlineChecks == 1 {
                log("No internet — Wi-Fi link \(associated ? "connected" : "disconnected")\(onHotspot ? ", on \(hotspot)" : "")")
            }
            let threshold = outageSawAssociation ? kOfflineChecksWhenAssociated : kOfflineChecksBeforeDial
            let due = dialNow || offlineChecks >= threshold || (onHotspot && lookForWiFiNow)
            if onHotspot { lookForWiFiNow = false }
            if onHotspot {
                if !hotspotOutageLogged {
                    log("On phone hotspot with no internet — looking for Wi-Fi, re-dialing the phone every ~2 min")
                    hotspotOutageLogged = true
                }
                if due, autoJoin, !manualJoining {
                    // Hand-joined: you chose the phone, so only re-dial it, never swap it for Wi-Fi.
                    if !handJoined, await tryKnownWiFi(reason: "phone has no internet", fromPhone: false) { renderMenu(); return }
                    if awake, offlineChecks % kDeadPhoneRedialChecks == 0 { await dialPhone() }
                }
            } else if returningToPhone, autoJoin, !manualJoining {
                await dialPhone()   // whatever the mode: we're the ones who left the phone
            } else if due, !manualJoining, autoJoin {
                if await tryKnownWiFi(reason: "internet lost", fromPhone: false, benchCurrent: true) { renderMenu(); return }
                guard offlineChecks > 0 else { renderMenu(); return }   // internet came back: stay put
                guard awake else { renderMenu(); return }   // phone only in stay-awake mode
                await dialPhone()
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
        } else if let trial = trialWiFi {
            wifiStatusItem.title = "Trying \(trial.ssid)…"
        } else if onHotspotNow {
            wifiStatusItem.title = "No internet on \(ssid)"
        } else if offlineChecks < (outageSawAssociation ? kOfflineChecksWhenAssociated : kOfflineChecksBeforeDial) {
            wifiStatusItem.title = "Internet: checking…"
        } else if !awake {
            wifiStatusItem.title = "No internet (phone only in stay-awake mode)"
        } else {
            wifiStatusItem.title = "No internet — dialing \(ssid) (attempt \(joinAttempts + 1))"
        }
        if simulatedOutageActive() { wifiStatusItem.title = "⚠ TEST: simulated outage on — " + wifiStatusItem.title }
        errorItem.isHidden = lastError == nil
        if let err = lastError { errorItem.title = "! \(err)" }
        screenLockItem.state = lockOnLid ? .on : .off
        switch claudeRoutingIsPool() {
        case .some(true):  claudeRoutingItem.title = "Claude routing: Pool (click for Direct)"
        case .some(false): claudeRoutingItem.title = "Claude routing: Direct (click for Pool)"
        case .none:        claudeRoutingItem.title = "Claude routing: settings unreadable"
        }
        codexRoutingItem.isEnabled = codexRoutingMode != nil && !codexRoutingBusy
        switch codexRoutingMode {
        case "Pool":   codexRoutingItem.title = "Codex routing: Pool (click for Direct)"
        case "Direct": codexRoutingItem.title = "Codex routing: Direct (click for Pool)"
        default:       codexRoutingItem.title = codexRoutingReadID != nil ? "Checking Codex routing…" : "Codex routing unavailable"
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        renderExcludedWiFiMenu()
    }

    private func renderExcludedWiFiMenu() {
        let names = WiFiExclusionStore().list()
        excludedWiFiItem.title = names.isEmpty ? "Excluded Wi-Fi networks" : "Excluded Wi-Fi networks (\(names.count))"
        // renderMenu runs on every poll; swapping the submenu then could reset it while
        // it is open, so only rebuild when the list actually changed.
        if excludedWiFiItem.submenu != nil, renderedExclusions == names { return }
        renderedExclusions = names
        let sub = NSMenu()
        let add = NSMenuItem(title: "Add network…", action: #selector(addExcludedWiFi), keyEquivalent: "")
        add.target = self
        sub.addItem(add)
        if names.isEmpty {
            let none = NSMenuItem(title: "None — Maxbar may pick any remembered network", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        } else {
            sub.addItem(.separator())
            for name in names {
                let item = NSMenuItem(title: "Remove \(displaySSID(name))", action: #selector(removeExcludedWiFi(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = name
                sub.addItem(item)
            }
        }
        excludedWiFiItem.submenu = sub
    }

    @objc private func addExcludedWiFi() {
        guard !addingExclusion else { return }
        addingExclusion = true
        Task {
            // networksetup can take up to 8s: never on the main actor, or the menu bar freezes.
            let remembered = await offMain { preferredWiFiNetworks() }
            showAddExclusionDialog(remembered: remembered)
            addingExclusion = false
        }
    }

    private func showAddExclusionDialog(remembered: [String]) {
        let alert = NSAlert()
        alert.messageText = "Exclude a Wi-Fi network"
        alert.informativeText = "Maxbar will never join this network on its own (backup or switch-over). " +
            "Type the exact name, or pick one macOS remembers. It does not need to be in range. " +
            "Your Mac's own auto-join and the Wi-Fi menu are not changed."
        let box = NSComboBox(frame: NSRect(x: 0, y: 0, width: 280, height: 26))
        box.completes = true
        box.addItems(withObjectValues: remembered)
        alert.accessoryView = box
        alert.addButton(withTitle: "Exclude")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = box
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let store = WiFiExclusionStore()
        let unreadable = store.read().dropped
        if unreadable > 0 { log("Wi-Fi exclusion list: \(unreadable) unreadable entr(ies) discarded on save") }
        switch store.add(box.stringValue, hotspot: hotspot) {
        case .added: lastError = nil; log("Wi-Fi exclusion added (\(store.list().count) total)")
        case .alreadyExcluded(let name):
            log("Wi-Fi exclusion already present; nothing to add")
            lastError = nil
            showInfo("Already excluded", "\(displaySSID(name)) is already on the excluded list.")
        case .listFull: lastError = "Excluded list is full (\(kMaxExcludedNetworks) networks) — remove one first"
        case .isHotspot: lastError = "That is your hotspot — it can't be excluded"
        case .invalid: lastError = "Not a valid Wi-Fi name"
        }
        renderMenu()
    }

    @objc private func removeExcludedWiFi(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if WiFiExclusionStore().remove(name) { log("Wi-Fi exclusion removed (\(WiFiExclusionStore().list().count) left)") }
        renderMenu()
    }

    // MARK: - NSMenuDelegate — show fresh sleep state every time the menu opens

    func menuNeedsUpdate(_ menu: NSMenu) {
        awake = sleepDisabled() ?? awake
        refreshCodexRouting()
        renderMenu()
    }
}

@main
enum MaxbarApp {
    static func main() {
        seedHotspotNameFromEnvOrArgs()
        // Setup hook: `Maxbar --register-login` turns on "Launch at Login" and runs normally.
        if CommandLine.arguments.contains("--register-login") {
            do { try SMAppService.mainApp.register(); log("Launch at login enabled via setup flag") }
            catch { log("Launch at login flag failed: \(error.localizedDescription)") }
        }
        // Diagnostic: `Maxbar --survey` prints what the Wi-Fi survey sees and exits.
        if CommandLine.arguments.contains("--survey") {
            let t0 = Date()
            let s = surveyKnownWiFi(onPhone: onPhoneHotspot())
            print("in range (best first): \(s.inRange)")
            print("on now: \(s.current ?? "unknown")")
            print(String(format: "took %.1fs", Date().timeIntervalSince(t0)))
            return
        }
        // Diagnostic: `Maxbar --join-phone` wakes the phone over Bluetooth and joins
        // your hotspot with the same code the watchdog uses (a test of switch-back from the phone).
        if CommandLine.arguments.contains("--join-phone") {
            // Off the main thread with the main run loop alive, as in the running app
            // (the Bluetooth wake may deliver its callback on the main queue).
            let ssid = hotspotName()
            guard !ssid.isEmpty else { print("no hotspot name set"); return }
            DispatchQueue.global().async {
                switch dialHotspot(ssid: ssid, restoreRadio: false) {
                case .joined: print("joined \(ssid)")
                case .failed(let why): print("failed: \(why)")
                case .radioOff: print("Wi-Fi radio is off")
                case .radioRestored: print("Wi-Fi radio was off")
                }
                exit(0)
            }
            RunLoop.main.run()
            return
        }
        let app = NSApplication.shared
        let controller = MaxbarController()   // strong ref for the app lifetime
        app.run()
        _ = controller
    }
}
