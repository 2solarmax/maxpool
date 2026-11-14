// Child of probePendingSwitch() (reload-pty-harness.js), run on a pty nobody reads.
// Fills the pty's output queue far past any kernel's size, then asks the real helper
// (src/terminal-mode.js) for a raw-mode switch and reports whether it landed.
//   node pending-switch-probe.mjs <terminal-mode.js URL> <report path>
// `queued` > 0 after the event loop has idled is the proof that the KERNEL queue is
// full: a non-blocking tty write hands the kernel all it takes and keeps only the rest.
import { writeFileSync } from 'node:fs';

const [modeUrl, report] = process.argv.slice(2);
const { createTerminalModeSwitcher } = await import(modeUrl);
const sw = createTerminalModeSwitcher();
process.stdout._handle.setBlocking(false);
const chunk = 'x'.repeat(64 * 1024);
for (let i = 0; i < 256; i++) process.stdout.write(chunk);   // 16 MB
setTimeout(() => {
  const queued = process.stdout.writableLength;
  let settled = null;
  sw.setRaw(true).then(r => { settled = r; }, e => { settled = { ok: false, error: String(e) }; });
  setTimeout(() => {
    writeFileSync(report, JSON.stringify({ queued, settled }));
    sw.close();
    process.exit(0);
  }, 3000);
}, 300);
