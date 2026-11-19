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
  const olderExpiry = disk.expiresAt && account.expiresAt && disk.expiresAt < account.expiresAt;
  // A separately authorized ChatGPT grant can have a shorter lifetime.
  if (consumedGrant || (olderExpiry && !(account.provider === 'codex' && differentGrant))) {
    return { accessToken: account.credential, refreshToken: account.refreshToken, expiresAt: account.expiresAt };
  }
  return { accessToken: disk.accessToken, refreshToken: disk.refreshToken, expiresAt: disk.expiresAt };
}
