// Throwaway PKI for the rc-gate tests. CI (ubuntu) has neither mkcert nor the gitignored
// anthropic-mitm.key, so tests mint a CA + an api.anthropic.com leaf with openssl, point the
// gate at the leaf (RC_GATE_MITM_CERT / RC_GATE_MITM_KEY) and trust only that CA. The real
// anthropic-mitm.key is never read. Callers own the directory and must delete it.
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HAVE_OPENSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

/** Mint CA + leaf into `dir` (an existing, caller-owned directory). */
export function mintPki(dir) {
  const f = n => join(dir, n);
  const sh = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  writeFileSync(f('ca.cnf'), [
    '[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3_ca',
    '[dn]', 'CN=rc-gate-test-ca',
    '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', '',
  ].join('\n'));
  writeFileSync(f('leaf.ext'), [
    'subjectAltName=DNS:api.anthropic.com,DNS:localhost,IP:127.0.0.1',
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', '',
  ].join('\n'));
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', f('ca.cnf'), '-keyout', f('ca.key'), '-out', f('ca.crt'));
  sh('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.anthropic.com', '-keyout', f('leaf.key'), '-out', f('leaf.csr'));
  sh('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
    '-days', '2', '-extfile', f('leaf.ext'), '-out', f('leaf.crt'));
  return { dir, ca: f('ca.crt'), cert: f('leaf.crt'), key: f('leaf.key') };
}
