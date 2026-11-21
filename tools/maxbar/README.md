# Maxbar

Menu-bar app for the team: one-click toggle of macOS `sleepoff`/`sleepon`, auto-join of
your iPhone hotspot when Wi-Fi drops, lid-close screen lock while sleep is off, and a
Pool/Direct routing switches for Claude and Codex.

Ported from Max's personal SleepMenu; the hotspot name is now per-user configuration
(set it in the menu — nothing personal is compiled in).

## What it does

| Feature | Behavior |
|---|---|
| Excluded Wi-Fi networks | Menu → "Excluded Wi-Fi networks" → "Add network…": type a name (it need not be in range or remembered) or pick one macOS remembers. Maxbar never picks an excluded network when it looks for a backup or leaves the phone. If only excluded networks are in range, it falls through to the phone hotspot, but only when Auto-join is on, the outage persists, Stay awake mode is on and a hotspot name is set (otherwise it just keeps looking). Matching ignores case (accents count: "Café" and "Cafe" are different networks). At most 256 networks; a damaged entry in the saved list is skipped and logged without dropping the others. The list lives in Maxbar's own preferences (`excludedWiFiNetworks`). An exclusion never disconnects you by itself, but Maxbar's outage handling can still move you off a network that has lost internet. It does **not** change macOS's own auto-join or the Wi-Fi menu, so macOS can still join an excluded network on its own, including when Maxbar switches Wi-Fi off and on (lid closed on the phone hotspot, reconnecting the hotspot). To keep macOS off a network, turn off "Auto-Join" for it in System Settings → Wi-Fi → Details |
| Toggle sleep | Click menu icon → "Stay awake (sleepoff)" / "Allow sleep (sleepon)". Runs the exact two passwordless-sudo commands granted by `/etc/sudoers.d/sleep-control` (template: `sudoers-example` in this folder) |
| Icon | coffee cup = staying awake, z's = normal sleep |
| Auto-join hotspot | Every 15s the app checks real internet access (Apple's captive-portal test, not just "has a Wi-Fi address"). Only in stay-awake mode, and only after you set your hotspot name; after ~30s with no internet it dials the phone, retrying every 15s. If the Wi-Fi radio was switched off, it switches it back on first |
| "Join hotspot now" | Manual join from the menu. Up to 4 tries 8s apart; ⏳ shows in the menu bar while it works; a notification on success/give-up (if notifications are allowed in System Settings) |
| Wake the phone | Every join first wakes the iPhone hotspot over Bluetooth — the same private Sharing.framework call (`SFRemoteHotspotSession enableHotspotForDevice:`) the Wi-Fi menu's Personal Hotspot entry makes — and joins with the password the phone hands back (never logged). This is what fixes "Could not find network" / `-3900 tmpErr` on an idle phone |
| Radio refresh | After ~2 min of failed dials, Wi-Fi is switched off/on for a fresh scan |
| Battery: lid closed in sleep-on | If the Mac rides the phone hotspot with sleep ON and the lid closes, Wi-Fi is switched off (maintenance wakes would keep re-waking the phone's hotspot all night); switched back on when the lid opens |
| Lock when lid closes | With sleep OFF, macOS no longer locks on lid close (its lock is tied to sleep). The app watches the lid every 2s and locks with the same call as Apple menu → Lock Screen. Skipped when an external monitor is connected. Checkbox, on by default |
| Claude routing | Pool writes the local proxy, mkcert CA, and an opt-in for the gate's `all` profile to `~/.claude/settings.json`. Direct removes those settings. The gate updates its default without restarting. Explicit client profiles and `RC_GATE_PROFILE` take precedence. Restart the Claude Mac app to apply changed proxy settings |
| Codex routing | Pool selects MaxPool's authenticated loopback Codex listener. Direct restores the previous provider setting. The switch uses Codex's configuration writer and preserves other settings. Restart the ChatGPT app's Codex client or open a new CLI process, then start a new chat |
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
   sessions keep the env they started with. If Pool was already selected before
   upgrading Maxbar, switch to Direct and back to Pool once to opt into `all`.

5. **Codex routing (optional).** Start a MaxPool build that supports the loopback
   Codex route and add a ChatGPT account locally. Choose Pool in the Codex routing
   row, then restart the ChatGPT app's Codex client or open a new Codex CLI process.
   Direct restores your previous provider even if MaxPool is offline. Maxbar leaves
   the Codex login and unrelated configuration alone. Codex reads the current
   MaxPool caller token from the existing MaxPool config when it needs one.

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

### Separate Claude gateway on one Mac

Maxbar looks for the Claude gateway on loopback port 3457 by default. To give
new Claude Desktop sessions their own gateway, start another rc-gate LaunchAgent
on an unused loopback port with its own label and log. Point it at the same local
MaxPool backend. Set `RC_GATE_TITLE_SYNC=0` on the second process to keep a single
title-sync writer. Omit `RC_GATE_PROFILE` so the explicit Maxbar Pool choice and
client profile determine routing. Give the second gate its own route switch file
if the original gate uses a separate Direct/Pool control.

With Claude routing set to Direct, select the new port for Maxbar. For example:

```sh
defaults write com.maxpool.maxbar claudeGatePort -int 3458
```

The accepted range is 1024–65535. An absent or invalid preference uses 3457.
Changing this preference does not edit Claude settings. Choosing **Claude routing
→ Pool** writes the selected gateway for new Claude processes. To return to the
original gateway, choose **Direct** first, then remove the preference with
`defaults delete com.maxpool.maxbar claudeGatePort`. Stop the extra LaunchAgent
after clients using its port have exited.
