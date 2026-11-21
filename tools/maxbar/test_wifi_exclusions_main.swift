import Foundation

nonisolated(unsafe) var failures = 0
func check(_ ok: Bool, _ name: String) {
    print(ok ? "PASS \(name)" : "FAIL \(name)")
    if !ok { failures += 1 }
}
func freshStore() -> WiFiExclusionStore {
    let suite = "maxbar-test-\(UUID().uuidString)"
    return WiFiExclusionStore(defaults: UserDefaults(suiteName: suite)!)
}

let car = "SyntheticCar-Net", home = "SyntheticHome-Net", phone = "SyntheticPhone"

// persistence across a fresh store object on the same defaults
do {
    let suite = "maxbar-test-\(UUID().uuidString)"
    let a = WiFiExclusionStore(defaults: UserDefaults(suiteName: suite)!)
    _ = a.add(car)
    let b = WiFiExclusionStore(defaults: UserDefaults(suiteName: suite)!)
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
}
print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
