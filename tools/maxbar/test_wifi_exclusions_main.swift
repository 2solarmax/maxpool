import Foundation

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ name: String) {
    print(ok ? "PASS \(name)" : "FAIL \(name)")
    if !ok { failures += 1 }
}
// Every suite created here is removed at the end so local runs leave no plists in
// ~/Library/Preferences.
nonisolated(unsafe) var suites: [String] = []
func freshDefaults() -> UserDefaults {
    let suite = "maxbar-test-\(UUID().uuidString)"
    suites.append(suite)
    return UserDefaults(suiteName: suite)!
}
func freshStore() -> WiFiExclusionStore { WiFiExclusionStore(defaults: freshDefaults()) }

let car = "SyntheticCar-Net", home = "SyntheticHome-Net", phone = "SyntheticPhone"

// persistence across a fresh store object on the same defaults
do {
    let d = freshDefaults()
    let a = WiFiExclusionStore(defaults: d)
    _ = a.add(car)
    let b = WiFiExclusionStore(defaults: d)
    check(b.list() == [car], "persists across store instances")
}
// manual add of a name that is in no scan result and not remembered
do {
    let s = freshStore()
    check(s.add("  Not In Range Anywhere  ") == .added("Not In Range Anywhere"), "manual add trims and stores")
    check(s.contains("not in range anywhere"), "match ignores case")
    check(s.add("NOT IN RANGE ANYWHERE") == .alreadyExcluded("NOT IN RANGE ANYWHERE"), "duplicate by case rejected")
    check(s.list().count == 1, "no duplicate stored")
}
// validation
do {
    let s = freshStore()
    check(s.add("   ") == .invalid, "blank rejected")
    check(s.add(String(repeating: "x", count: 33)) == .invalid, "over 32 bytes rejected")
    check(s.add(phone, hotspot: phone) == .isHotspot, "hotspot cannot be excluded")
    check(s.list().isEmpty, "rejected names not stored")
    // 32-byte boundary: exactly 32 bytes is valid, 33 is not
    check(s.add(String(repeating: "x", count: 32)) == .added(String(repeating: "x", count: 32)), "exactly 32 bytes accepted")
    // multibyte: 16 x "é" is 16 characters but 32 bytes (ok); 17 is 17 characters but 34 bytes (rejected)
    check(s.add(String(repeating: "é", count: 16)) == .added(String(repeating: "é", count: 16)), "16 two-byte chars (32 bytes) accepted")
    check(s.add(String(repeating: "é", count: 17)) == .invalid, "17 two-byte chars (34 bytes) rejected though under 32 characters")
    // hotspot match is case-insensitive and trimmed
    let h = freshStore()
    check(h.add("  SYNTHETICPHONE ", hotspot: phone) == .isHotspot, "hotspot matched regardless of case and spaces")
    check(h.list().isEmpty, "hotspot-named entry not stored")
    check(h.add(car, hotspot: phone) == .added(car), "non-hotspot name still added when a hotspot is set")
}
// accents are different letters: excluding one network must not block its lookalike
do {
    let s = freshStore()
    _ = s.add("Café-Guest")
    check(s.contains("CAFÉ-GUEST"), "accented name matches by case")
    check(!s.contains("Cafe-Guest"), "unaccented lookalike is a different network")
    let r = eligibleWiFiCandidates(inRange: ["Cafe-Guest", "Café-Guest"], current: nil, cooldown: [], excluded: s.list())
    check(r == ["Cafe-Guest"], "only the exactly named accented network is held back")
}
// stored list: query trimming and corrupt entries
do {
    let s = freshStore()
    _ = s.add(car)
    check(s.contains("  \(car)\n"), "contains trims the query")
    check(s.remove("  \(car.lowercased()) "), "remove trims the query")
    check(s.list().isEmpty, "list empty after trimmed remove")
    let d = freshDefaults()
    d.set(["   ", String(repeating: "x", count: 33), " Good ", ""], forKey: kPrefsExcludedWiFi)
    check(WiFiExclusionStore(defaults: d).list() == ["Good"], "list drops blank and over-long stored entries, trims the rest")
    let empty = WiFiExclusionStore(defaults: freshDefaults())
    check(empty.list().isEmpty && !empty.contains(car), "nothing stored: empty list, contains false")
}
// removal
do {
    let s = freshStore()
    _ = s.add(car)
    check(s.remove("syntheticcar-net"), "remove ignores case")
    check(!s.remove(car), "remove of absent returns false")
    check(s.list().isEmpty, "list empty after remove")
}
// selection: synthetic car + normal network
do {
    let r = eligibleWiFiCandidates(inRange: [car, home], current: nil, cooldown: [], excluded: [car])
    check(r == [home], "car excluded, normal network selected")
    let none = eligibleWiFiCandidates(inRange: [car], current: nil, cooldown: [], excluded: [car])
    check(none.isEmpty, "only the car in range: no eligible candidate")
    let upper = eligibleWiFiCandidates(inRange: [car, home], current: nil, cooldown: [], excluded: [car.uppercased()])
    check(upper == [home], "exclusion matches regardless of case")
    let order = eligibleWiFiCandidates(inRange: [home, car, "Other"], current: nil, cooldown: [], excluded: [car])
    check(order == [home, "Other"], "best-first order preserved")
    let backup = eligibleWiFiCandidates(inRange: [home, car, "Other"], current: home, cooldown: [], excluded: [car])
    check(backup == ["Other"], "backup pick skips current and excluded")
    let cool = eligibleWiFiCandidates(inRange: [home, car, "Other"], current: nil, cooldown: ["Other"], excluded: [car])
    check(cool == [home], "cooldown still applies alongside exclusions")
    let allBlocked = eligibleWiFiCandidates(inRange: [car, home], current: nil, cooldown: [home], excluded: [car])
    check(allBlocked.isEmpty, "excluded plus cooled down: nothing eligible")
    let notExcluded = eligibleWiFiCandidates(inRange: [car, home], current: nil, cooldown: [], excluded: [])
    check(notExcluded == [car, home], "empty exclusion list changes nothing")
    // cooldown and current-network matches are exact, as before the list existed
    let exactCool = eligibleWiFiCandidates(inRange: ["Other"], current: nil, cooldown: ["other"], excluded: [])
    check(exactCool == ["Other"], "cooldown match stays exact (not case-folded)")
    let exactCurrent = eligibleWiFiCandidates(inRange: ["Other"], current: "OTHER", cooldown: [], excluded: [])
    check(exactCurrent == ["Other"], "current-network match stays exact (not case-folded)")
    // the held-back log line and the real filter use one predicate
    let inRange = [home, car, "Other", "Café"]
    let excl = [car.uppercased(), "café"]
    let held = excludedInRange(inRange: inRange, excluded: excl)
    check(held == [car, "Café"], "held-back list matches by the same fold as the filter")
    let kept = eligibleWiFiCandidates(inRange: inRange, current: nil, cooldown: [], excluded: excl)
    check(Set(kept).isDisjoint(with: held) && kept.count + held.count == inRange.count,
          "every in-range network is either eligible or held back, never both")
    // the pre-join re-check (store.contains) agrees with the filter
    let s = freshStore()
    for n in excl { _ = s.add(n) }
    check(inRange.allSatisfy { s.contains($0) == held.contains($0) }, "store.contains agrees with the filter")
}
for suite in suites { UserDefaults.standard.removePersistentDomain(forName: suite) }
print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
