import { importCredentials } from './oauth.js';

export async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = await importCredentials(acct.importFrom);
          accounts.push({ ...acct, ...creds });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
          // Fall back to a previously-stored token rather than dropping the
          // account entirely when the import source is unreadable.
          if (acct.accessToken) accounts.push(acct);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    } else if (acct.type === 'provider' && (acct.authToken || acct.apiKey)) {
      accounts.push(acct);
    }
  }
  return accounts;
}
