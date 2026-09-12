// app/lib/policyMessage.ts
// The exact string /api/policy verifies, shared so the two cannot drift.
//
// Duplicating this in the browser is how signature checks quietly start failing
// on a whitespace change, so it lives in one place that both sides import. It
// is deliberately free of server-only imports so the client can use it.

export function policySignMessage(op: string, account: string, issuedAt: string): string {
  return [
    `Sovereign: ${op} spend policy`,
    `account: ${account.toLowerCase()}`,
    `issued: ${issuedAt}`,
  ].join('\n');
}
