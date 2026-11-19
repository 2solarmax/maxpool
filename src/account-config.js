import { nativeCodexOwnerIdentity } from './codex-native.js';
import { knownDifferentOrg, sameAccountIdentity } from './oauth.js';

export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      // Legacy import-sourced accounts keep their stored token (the file/Keychain
      // re-import was removed — it snapshotted a credential other clients rotate,
      // which bricked accounts). Re-add via `maxpool login` for an independent grant.
      if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping — re-add it with: maxpool login`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    } else if (acct.type === 'provider' && (acct.authToken || acct.apiKey)) {
      accounts.push(acct);
    }
  }
  return accounts;
}

// A disk read may start before a single-use refresh finishes and arrive while
// the replacement is being persisted. Keep that consumed grant out of both
// the live account and the config snapshot a later TUI save can write.
export function oauthTokensForDiskSync(account, disk) {
  const differentGrant = Boolean(disk.refreshToken) && disk.refreshToken !== account.refreshToken;
  const consumedGrant = differentGrant && disk.refreshToken === account._refreshedFrom;
  const replacedAccess = disk.refreshToken === account._refreshedFrom
    && disk.accessToken === account._refreshedAccessFrom && disk.accessToken !== account.credential;
  const olderExpiry = disk.expiresAt && account.expiresAt && disk.expiresAt < account.expiresAt;
  // A separately authorized ChatGPT grant can have a shorter lifetime.
  if (consumedGrant || replacedAccess || (olderExpiry && !(account.provider === 'codex' && differentGrant))) {
    return { accessToken: account.credential, refreshToken: account.refreshToken, expiresAt: account.expiresAt };
  }
  return { accessToken: disk.accessToken, refreshToken: disk.refreshToken, expiresAt: disk.expiresAt };
}

/** Use the complete ChatGPT owner identity for native grants; names are editable. */
export function findAccountConfigIndex(accounts, account) {
  if (account.codexAuth === 'native') {
    const owner = nativeCodexOwnerIdentity(account);
    return owner ? accounts.findIndex(candidate => nativeCodexOwnerIdentity(candidate) === owner) : -1;
  }
  const exact = accounts.findIndex(candidate => candidate.codexAuth !== 'native' && sameAccountIdentity(candidate, account));
  if (exact >= 0) return exact;
  return accounts.findIndex(candidate => candidate.codexAuth !== 'native' && candidate.name === account.name
    && !knownDifferentOrg(candidate, account));
}
