import Foundation

// Wi-Fi networks Maxbar must never pick on its own (a car's Wi-Fi, a printer, a
// captive hotel network). This is Maxbar's own list, kept in UserDefaults. It only
// filters the networks Maxbar chooses; macOS's own auto-join and the Wi-Fi menu are
// untouched, and a network the Mac is already on is never left because of it.
// Pure logic: no scanning, no joining, so it can be tested without a radio.

let kPrefsExcludedWiFi = "excludedWiFiNetworks"
let kMaxSSIDBytes = 32   // an SSID is at most 32 bytes (IEEE 802.11)

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
    case isHotspot      // the hotspot is dialed by its own path, which never reads this list: an entry would do nothing and mislead
}

struct WiFiExclusionStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Saved names in the order they were added.
    func list() -> [String] {
        (defaults.array(forKey: kPrefsExcludedWiFi) as? [String] ?? []).compactMap(normalizedSSID)
    }

    func contains(_ ssid: String) -> Bool {
        let key = foldedSSID(ssid.trimmingCharacters(in: .whitespacesAndNewlines))
        return list().contains { foldedSSID($0) == key }
    }

    /// Works for a network that is not in range or not remembered: nothing is scanned.
    @discardableResult
    func add(_ raw: String, hotspot: String = "") -> ExclusionAdd {
        guard let ssid = normalizedSSID(raw) else { return .invalid }
        if !hotspot.isEmpty, foldedSSID(hotspot) == foldedSSID(ssid) { return .isHotspot }
        if contains(ssid) { return .alreadyExcluded(ssid) }
        defaults.set(list() + [ssid], forKey: kPrefsExcludedWiFi)
        return .added(ssid)
    }

    @discardableResult
    func remove(_ raw: String) -> Bool {
        let key = foldedSSID(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        let kept = list().filter { foldedSSID($0) != key }
        guard kept.count != list().count else { return false }
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
