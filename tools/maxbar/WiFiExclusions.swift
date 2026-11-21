import Foundation

// Wi-Fi networks Maxbar must never pick on its own (a car's Wi-Fi, a printer, a
// captive hotel network). This is Maxbar's own list, kept in UserDefaults. It only
// filters the networks Maxbar chooses; macOS's own auto-join and the Wi-Fi menu are
// untouched, and an exclusion by itself never disconnects the Mac from a network.
// Pure logic: no scanning, no joining, so it can be tested without a radio.

let kPrefsExcludedWiFi = "excludedWiFiNetworks"
let kMaxSSIDBytes = 32   // an SSID is at most 32 bytes (IEEE 802.11)
let kMaxExcludedNetworks = 256   // far above any real list; bounds the work done per poll and per join

/// A name shown in a menu: control, line-break and bidirectional-format characters are
/// written out as \u{XXXX} so a hostile or odd network name cannot reorder or hide the
/// surrounding menu text. Only for display: matching and removal use the stored name.
func displaySSID(_ s: String) -> String {
    var out = ""
    for scalar in s.unicodeScalars {
        switch scalar.properties.generalCategory {
        case .control, .format, .lineSeparator, .paragraphSeparator:
            out += "\\u{" + String(scalar.value, radix: 16, uppercase: true) + "}"
        default:
            out.unicodeScalars.append(scalar)
        }
    }
    return out
}

/// Trimmed network name, or nil when it cannot be a valid name.
func normalizedSSID(_ raw: String) -> String? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty, s.utf8.count <= kMaxSSIDBytes else { return nil }
    return s
}

/// Names compare without regard to case, so "My Car" typed by hand still matches the
/// remembered "my car". Accents are NOT folded: "Café" and "Cafe" are different
/// networks, and excluding one must not block the other.
private func foldedSSID(_ s: String) -> String {
    s.folding(options: .caseInsensitive, locale: nil)
}

enum ExclusionAdd: Equatable {
    case added(String)
    case alreadyExcluded(String)
    case invalid
    case listFull       // kMaxExcludedNetworks reached: nothing more is stored
    case isHotspot      // the hotspot is dialed by its own path, which never reads this list: an entry would do nothing and mislead
}

/// What was read back from preferences. `dropped` counts stored entries that could not
/// be used (not a string, blank, over 32 bytes) or a stored value that is not a list at
/// all, so damaged data is reported instead of silently emptying the list.
struct ExclusionRead: Equatable {
    let names: [String]
    let dropped: Int
}

struct WiFiExclusionStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private static func valid(_ element: Any) -> String? {
        (element as? String).flatMap(normalizedSSID)
    }

    /// Element by element: one damaged entry must not make every other excluded network
    /// joinable. Valid names are kept in the order they were added.
    func read() -> ExclusionRead {
        guard let stored = defaults.object(forKey: kPrefsExcludedWiFi) else {
            return ExclusionRead(names: [], dropped: 0)
        }
        guard let elements = stored as? [Any] else { return ExclusionRead(names: [], dropped: 1) }
        let names = elements.compactMap(Self.valid)
        return ExclusionRead(names: names, dropped: elements.count - names.count)
    }

    /// Saved names in the order they were added.
    func list() -> [String] { read().names }

    /// One pass, stops at the first match, builds no list: cheap enough to ask per candidate.
    func contains(_ ssid: String) -> Bool {
        let key = foldedSSID(ssid.trimmingCharacters(in: .whitespacesAndNewlines))
        guard let elements = defaults.array(forKey: kPrefsExcludedWiFi) else { return false }
        return elements.lazy.compactMap(Self.valid).contains { foldedSSID($0) == key }
    }

    /// Works for a network that is not in range or not remembered: nothing is scanned.
    @discardableResult
    func add(_ raw: String, hotspot: String = "") -> ExclusionAdd {
        guard let ssid = normalizedSSID(raw) else { return .invalid }
        if !hotspot.isEmpty, foldedSSID(hotspot) == foldedSSID(ssid) { return .isHotspot }
        let current = read().names
        let key = foldedSSID(ssid)
        if current.contains(where: { foldedSSID($0) == key }) { return .alreadyExcluded(ssid) }
        if current.count >= kMaxExcludedNetworks { return .listFull }
        defaults.set(current + [ssid], forKey: kPrefsExcludedWiFi)
        return .added(ssid)
    }

    @discardableResult
    func remove(_ raw: String) -> Bool {
        let key = foldedSSID(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        let current = read().names
        let kept = current.filter { foldedSSID($0) != key }
        guard kept.count != current.count else { return false }
        defaults.set(kept, forKey: kPrefsExcludedWiFi)
        return true
    }
}

/// The in-range networks the exclusion list holds back. The one predicate behind both
/// the filter below and the "not joining N excluded" log line, so they cannot disagree.
func excludedInRange(inRange: [String], excluded: [String]) -> [String] {
    let blocked = Set(excluded.map(foldedSSID))
    return inRange.filter { blocked.contains(foldedSSID($0)) }
}

/// Networks Maxbar may join, best first: in range, not the one we are on, not cooling
/// down after a failure, and not excluded. Every automatic or backup pick goes through
/// here; an empty result means "no eligible network" and the caller falls through to
/// the phone hotspot. Cooldown and current-network matches stay exact (as before this
/// list existed); only the exclusion list is case-folded.
func eligibleWiFiCandidates(inRange: [String], current: String?, cooldown: Set<String>,
                            excluded: [String]) -> [String] {
    let held = Set(excludedInRange(inRange: inRange, excluded: excluded))
    return inRange.filter { !held.contains($0) && !cooldown.contains($0) && $0 != current }
}
