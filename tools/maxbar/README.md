# Maxbar

Menu-bar app for the team: one-click toggle of macOS `sleepoff`/`sleepon`, auto-join of
your iPhone hotspot when Wi-Fi drops, lid-close screen lock while sleep is off, and a
Pool/Direct routing toggle for the Claude desktop app.

Ported from Max's personal SleepMenu; the hotspot name is now per-user configuration
(set it in the menu — nothing personal is compiled in).

## What it does

| Feature | Behavior |
|---|---|
| Toggle sleep | Click menu icon → "Stay awake (sleepoff)" / "Allow sleep (sleepon)". Runs the exact two passwordless-sudo commands granted by `/etc/sudoers.d/sleep-control` (template: `sudoers-example` in this folder) |
| Icon | coffee cup = staying awake, z's = normal sleep |
| Auto-join hotspot | Every 15s the app checks real internet access (Apple's captive-portal test, not just "has a Wi-Fi address"). Only in stay-awake mode, and only after you set your hotspot name; after ~30s with no internet it dials the phone, retrying every 15s. If the Wi-Fi radio was switched off, it switches it back on first |
| "Join hotspot now" | Manual join from the menu. Up to 4 tries 8s apart; ⏳ shows in the menu bar while it works; a notification on success/give-up (if notifications are allowed in System Settings) |
| Wake the phone | Every join first wakes the iPhone hotspot over Bluetooth — the same private Sharing.framework call (`SFRemoteHotspotSession enableHotspotForDevice:`) the Wi-Fi menu's Personal Hotspot entry makes — and joins with the password the phone hands back (never logged). This is what fixes "Could not find network" / `-3900 tmpErr` on an idle phone |
| Radio refresh | After ~2 min of failed dials, Wi-Fi is switched off/on for a fresh scan |
| Battery: lid closed in sleep-on | If the Mac rides the phone hotspot with sleep ON and the lid closes, Wi-Fi is switched off (maintenance wakes would keep re-waking the phone's hotspot all night); switched back on when the lid opens |
| Lock when lid closes | With sleep OFF, macOS no longer locks on lid close (its lock is tied to sleep). The app watches the lid every 2s and locks with the same call as Apple menu → Lock Screen. Skipped when an external monitor is connected. Checkbox, on by default |
| Claude routing | "Claude routing: Pool / Direct" flips `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` in the `env` block of `~/.claude/settings.json` (Pool = maxpool rc-gate proxy `127.0.0.1:3457` + mkcert CA; Direct = both keys removed). Read-modify-write that keeps every other key and its order, atomic temp-file + rename. Only affects the Claude Mac app, and only after it restarts; terminal sessions set their own proxy in ~/.zshrc. Pool mode requires the rc-gate proxy on that machine (see `tools/rc-gate/`): the switch to Pool is refused, with the reason shown in the menu, when the mkcert root CA is missing or nothing listens on `127.0.0.1:3457`. A missing `settings.json` counts as Direct and is created on first switch |
| Launch at Login | Toggle in the menu (SMAppService) |

## Setup (per machine, ~5 minutes)

Requires an arm64 (Apple Silicon) Mac with Xcode Command Line Tools
(`xcode-select --install`). Built for macOS 13+ (developed and verified on
macOS 26 / arm64).

```bash
git clone https://github.com/2solarmax/maxpool.git   # or KarpelesLab/teamclaude
cd maxpool/tools/maxbar
./build.sh        # builds Maxbar.app with swiftc, ad-hoc signed
cp -R Maxbar.app /Applications/ && open /Applications/Maxbar.app
```

Why build from a git checkout: Maxbar is a Swift menu-bar app; an .app bundle can't
ship inside the npm tarball cleanly (`package.json` `files` is `src/` only). The git
repo IS the distribution for this tool; the npm package continues to ship the proxy.

1. **Sudoers — one-time admin step.** The sleep toggle calls `sudo -n pmset` with no
   password prompt. Grant exactly those two commands:

   ```bash
   sed "s/YOURNAME/$(whoami)/" sudoers-example | sudo tee /etc/sudoers.d/sleep-control >/dev/null
   sudo chown root:wheel /etc/sudoers.d/sleep-control && sudo chmod 0440 /etc/sudoers.d/sleep-control
   sudo visudo -cf /etc/sudoers.d/sleep-control   # must print: parsed OK
   ```

   Without it the sleep toggle fails with "sudo: a password is required" (everything
   else still works). Removing the file reverts the grant.

2. **Hotspot name — yours, not Max's.** Menu → "Set hotspot name…" → type your
   iPhone's hotspot name (iPhone Settings → Personal Hotspot). Or seed it on first
   launch: `open -a Maxbar --args --hotspot-ssid "Your iPhone"` (also honored via the
   `MAXBAR_HOTSPOT_SSID` env var; either is saved to UserDefaults and only applies
   when nothing is saved yet). Auto-join and "Join now" stay inert until a name is
   set. The Bluetooth wake needs Bluetooth on and the phone nearby, signed into the
   same Apple Account as the Mac.

3. **Launch at Login** — toggle it in the menu so the app survives reboots.

4. **Claude routing (optional).** Works only on machines where the maxpool rc-gate
   proxy is installed (`tools/rc-gate/`, incl. its mkcert root CA and LaunchAgent).
   Toggle "Claude routing" in the menu, then **restart the Claude app** — running
   sessions keep the env they started with.

## Caveats

- The Bluetooth wake uses a private Apple API: a macOS update can break it
  (symptom: `Bluetooth wake of <name> failed: …` in the log on every join; the plain
  join is still tried).
- Critically low battery still forces sleep even in sleepoff mode (pmset limitation).
- Requires arm64 (Apple Silicon): built with the default target of `swiftc`.
- The Wi-Fi device is auto-detected from `networksetup -listallhardwareports`
  (usually en0); nothing is hardcoded.

## Log

`~/Library/Logs/Maxbar.log` — Wi-Fi-loss events, join attempts, toggles.

## Revert

Delete `/Applications/Maxbar.app` and, if you made it,
`/etc/sudoers.d/sleep-control`. Nothing else is touched (pmset, sudoers, Wi-Fi
config are unchanged by this app — it only calls existing commands).
