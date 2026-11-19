import { createHash } from 'node:crypto';
import { nativeCodexOwnerIdentity } from './codex-native.js';
import { knownDifferentOrg, sameAccountIdentity, sameUser, suggestAccountName } from './oauth.js';

const nativeRefreshLineages = new WeakMap();

function grantPair(accessToken, refreshToken) {
  return createHash('sha256').update(JSON.stringify([accessToken, refreshToken])).digest('hex');
}

function nativeRefreshLineage(account) {
  const lineage = nativeRefreshLineages.get(account);
  return lineage?.owner === nativeCodexOwnerIdentity(account)
    && lineage?.head === grantPair(account.credential, account.refreshToken) ? lineage : null;
}

/** Keep predecessors across write failures, scoped to the exact current grant and owner. */
export function rememberNativeRefresh(account, tokens) {
  const owner = nativeCodexOwnerIdentity(account);
  if (!owner) return;
  const predecessors = nativeRefreshLineage(account)?.predecessors || new Set();
  predecessors.add(grantPair(account.credential, account.refreshToken));
  nativeRefreshLineages.set(account, { owner, predecessors, head: grantPair(tokens.accessToken, tokens.refreshToken) });
}

/** Only replace an observed refresh predecessor or the result of this same write. */
export function canPersistOAuthRefresh(disk, tokens, { account, target, refreshedFrom }) {
  if (target.codexAuth !== 'native') {
    if (disk.codexAuth === 'native' || (disk.accountUuid && target.accountUuid && !sameUser(disk, target))
      || knownDifferentOrg(disk, target)) return false;
    return !disk.refreshToken || disk.refreshToken === refreshedFrom || disk.refreshToken === tokens.refreshToken;
  }
  const owner = nativeCodexOwnerIdentity(target);
  if (!owner || owner !== nativeCodexOwnerIdentity(disk)) return false;
  const diskPair = grantPair(disk.accessToken, disk.refreshToken);
  return diskPair === grantPair(target.credential, refreshedFrom) || diskPair === grantPair(tokens.accessToken, tokens.refreshToken)
    || nativeRefreshLineage(account)?.predecessors.has(diskPair) === true;
}

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
  const nativePredecessor = nativeRefreshLineage(account)?.predecessors.has(grantPair(disk.accessToken, disk.refreshToken));
  const olderExpiry = disk.expiresAt && account.expiresAt && disk.expiresAt < account.expiresAt;
  // A separately authorized ChatGPT grant can have a shorter lifetime.
  if (consumedGrant || replacedAccess || nativePredecessor || (olderExpiry && !(account.provider === 'codex' && differentGrant))) {
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
    && (candidate.provider === 'codex') === (account.provider === 'codex')
    && (!candidate.accountUuid || !account.accountUuid || sameUser(candidate, account))
    && !knownDifferentOrg(candidate, account));
}

export function configuredAccountProvider(account) {
  return !account.provider || account.provider === 'claude' ? 'anthropic' : account.provider;
}

export function isClaudeOAuthAccount(account) {
  return account.type === 'oauth' && configuredAccountProvider(account) === 'anthropic';
}

/** Claude's legacy name fallback is only valid for another Claude OAuth row. */
export function findClaudeOAuthLoginIndex(accounts, login) {
  const exact = accounts.findIndex(account => isClaudeOAuthAccount(account) && sameAccountIdentity(account, login));
  if (exact >= 0) return exact;
  return accounts.findIndex(account => isClaudeOAuthAccount(account)
    && account.name === login.name && !knownDifferentOrg(account, login));
}

function availableAccountName(accounts, base) {
  let name = base;
  for (let suffix = 2; accounts.some(account => account.name === name); suffix++) name = base + ' ' + suffix;
  return name;
}

export function planClaudeOAuthLogin(accounts, { creds, profile, name, source }, reservedAccounts = []) {
  const reserved = [...accounts, ...reservedAccounts];
  const base = name || suggestAccountName(reserved, profile);
  const identity = { name: base, accountUuid: profile?.accountUuid, organizationUuid: profile?.organizationUuid };
  const index = findClaudeOAuthLoginIndex(accounts, identity);
  const existing = accounts[index];
  const chosen = existing?.name || availableAccountName(reserved, base);
  const entry = {
    ...existing, name: chosen, type: 'oauth', source,
    accountUuid: identity.accountUuid || existing?.accountUuid || null,
    organizationUuid: identity.organizationUuid || existing?.organizationUuid || null,
    accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt,
  };
  return { index, entry };
}

/** Apply only the account fields changed by one terminal action. */
export function applyTuiAccountChange(config, { collection = 'accounts', before, after, fields = [] }) {
  const entries = config[collection] ||= [];
  const all = [...config.accounts, ...(config.providers || [])];
  if (!before) {
    if (after.type === 'oauth' && config.accounts.some(account => account.type === 'oauth' && sameAccountIdentity(account, after))) {
      throw new Error('This account is already in the pool config. Refresh the account list and reconnect it.');
    }
    const added = { ...after, name: availableAccountName(all, after.name) };
    entries.push(added);
    return added;
  }
  const candidates = entries.filter(account => account.type === before.type
    && configuredAccountProvider(account) === configuredAccountProvider(before));
  const current = candidates[findAccountConfigIndex(candidates, before)];
  if (!after) {
    if (current) entries.splice(entries.indexOf(current), 1);
    return current || null;
  }
  if (!current) throw new Error(`Account "${before.name}" changed on disk. Refresh the account list and try again.`);
  if (fields.includes('name') && all.some(account => account !== current && account.name === after.name)) {
    throw new Error(`An account named "${after.name}" already exists`);
  }
  for (const field of fields) {
    if (after[field] === undefined) delete current[field];
    else current[field] = after[field];
  }
  return current;
}
