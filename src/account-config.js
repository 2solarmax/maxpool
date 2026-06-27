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
