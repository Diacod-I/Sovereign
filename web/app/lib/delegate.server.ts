// app/lib/delegate.server.ts
// Signing as the user's own embedded wallet, after they delegated it.
//
// Privy holds the key; the user grants our app permission to use it with
// `delegateWallet` in the browser, and from then on our server can ask Privy to
// send a transaction from that wallet. The user can revoke from their side, and
// we can revoke from ours by deleting the link token.
//
// WHAT THIS COSTS, stated plainly because it is easy to lose in the plumbing:
// between the grant and its revocation, this server can move that user's money.
// That is a custodial-shaped power even though we never hold a key, and it is
// why the spend policy had to stop being a localStorage object before this
// existed. Two further limits are worth configuring rather than assuming:
//
//   - a Privy SIGNER POLICY on the authorization key, capping amount and
//     expiring the grant, so Privy refuses what we should never have asked for
//   - `SOVEREIGN_SERVER_MAX_PER_CALL`, a hard ceiling here that no account
//     policy can raise, so a compromised policy store cannot authorise a
//     transfer of any size

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';
const APP_SECRET = process.env.PRIVY_APP_SECRET || '';
const AUTH_KEY = process.env.PRIVY_AUTHORIZATION_KEY || '';

/** A ceiling the account policy cannot raise. Defence against our own storage. */
export const SERVER_MAX_PER_CALL = Number(process.env.SOVEREIGN_SERVER_MAX_PER_CALL || '5');

/**
 * Why this server cannot sign for a delegated wallet, if it cannot.
 *
 * Every message names WHERE the variable belongs. These strings travel a long
 * way -- from here, through the API response, through sovereign-mcp, into a
 * model's explanation, to a person -- and "PRIVY_APP_SECRET is not set" read at
 * the far end of that chain sounds like something missing on the machine the
 * terminal is running on. It is not: it is a server secret in the deployment,
 * and somebody spent a retry finding that out.
 */
export function delegationProblem(): string | null {
  if (!APP_ID) {
    return 'NEXT_PUBLIC_PRIVY_APP_ID is not set in the Sovereign deployment (server-side config, not on your machine).';
  }
  if (!APP_SECRET) {
    return (
      'PRIVY_APP_SECRET is not set in the Sovereign deployment, so the server cannot sign as your ' +
      'wallet. This is a server environment variable on the Sovereign host, not anything on your ' +
      'machine or in .mcp.json. Set it in the Vercel project settings and redeploy.'
    );
  }
  if (!AUTH_KEY) {
    return (
      'PRIVY_AUTHORIZATION_KEY is not set in the Sovereign deployment. It must be the private key ' +
      'of the same key quorum whose id is in NEXT_PUBLIC_PRIVY_SIGNER_ID, or the signer attached ' +
      'in the browser will not be the one the server signs with. Set it in the Vercel project ' +
      'settings and redeploy.'
    );
  }
  return null;
}

type PrivyClient = {
  walletApi: {
    ethereum: {
      sendTransaction: (args: {
        walletId?: string;
        address?: string;
        caip2: string;
        transaction: Record<string, unknown>;
      }) => Promise<{ hash: string }>;
    };
  };
  getUserByWalletAddress?: (address: string) => Promise<unknown>;
};

let clientPromise: Promise<PrivyClient> | null = null;

/**
 * Imported lazily so a deployment without the server SDK still builds and every
 * other route keeps working. The failure then lands here, named, instead of at
 * module load in a route that has nothing to do with delegation.
 */
async function getClient(): Promise<PrivyClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    let mod: Record<string, unknown>;
    try {
      mod = (await import('@privy-io/server-auth')) as unknown as Record<string, unknown>;
    } catch {
      throw new Error('@privy-io/server-auth is not installed on the server.');
    }
    const Ctor = mod.PrivyClient as new (id: string, secret: string, opts?: unknown) => PrivyClient;
    if (!Ctor) throw new Error('@privy-io/server-auth did not export PrivyClient.');
    return new Ctor(APP_ID, APP_SECRET, {
      walletApi: { authorizationPrivateKey: AUTH_KEY },
    });
  })().catch((e) => {
    clientPromise = null; // let a later call retry rather than poisoning the process
    throw e;
  });
  return clientPromise;
}

/**
 * Sends a native-value transfer from the user's delegated wallet.
 *
 * `caip2` rather than a chain name because that is what the wallet API takes and
 * because a typo in a chain name is the kind of thing that silently sends real
 * money somewhere else.
 */
/**
 * What Privy actually knows about this address, before we ask it to sign.
 *
 * "No wallet account found for address 0x..." is what the signing call returns
 * when the address is not an embedded wallet Privy holds for this app, and it
 * arrives at the end of a payment attempt where every other gate has already
 * passed. Three different causes produce that one sentence, and they are fixed
 * in completely different places:
 *
 *   - the address is an external wallet (a MetaMask login), so there is no key
 *     for Privy to sign with and never will be
 *   - APP_ID and APP_SECRET belong to different Privy apps, so the lookup is
 *     asking the wrong app about a wallet it has never seen
 *   - the wallet exists but the authorization key's quorum has no access to it
 *
 * Asking first lets the caller say which, instead of relaying an error whose
 * subject is ambiguous.
 */
/**
 * Does Privy actually accept these credentials?
 *
 * `delegationProblem()` only proves three environment variables are non-empty.
 * That is not the same question, and the difference cost several rounds of a
 * green health check next to a failing payment: the variables were all set, and
 * the app id and the secret belonged to different Privy apps.
 *
 * So this makes one real authenticated request. Looking up the zero address is
 * the cheapest honest probe available -- valid credentials return null for "no
 * such user", while bad ones raise "Invalid app ID or app secret" before the
 * lookup is even attempted. The distinction between those two outcomes is
 * exactly the thing worth reporting.
 */
export async function credentialsWork(): Promise<{ ok: true } | { ok: false; detail: string }> {
  const problem = delegationProblem();
  if (problem) return { ok: false, detail: problem };
  try {
    const privy = (await getClient()) as unknown as {
      getUserByWalletAddress?: (a: string) => Promise<unknown>;
    };
    if (!privy.getUserByWalletAddress) return { ok: true }; // cannot probe; assume configured
    await privy.getUserByWalletAddress('0x0000000000000000000000000000000000000000');
    return { ok: true };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail: /invalid app/i.test(raw)
        ? `Privy rejected these credentials: ${raw}. NEXT_PUBLIC_PRIVY_APP_ID and ` +
          `PRIVY_APP_SECRET must come from the SAME app's settings page.`
        : raw,
    };
  }
}

export async function describeWallet(address: string): Promise<
  { ok: true; embedded: boolean; delegated: boolean; stored: string } | { ok: false; detail: string }
> {
  const problem = delegationProblem();
  if (problem) return { ok: false, detail: problem };
  try {
    const privy = (await getClient()) as unknown as {
      getUserByWalletAddress?: (a: string) => Promise<unknown>;
    };
    if (!privy.getUserByWalletAddress) {
      return { ok: false, detail: 'This @privy-io/server-auth build cannot look up a wallet by address.' };
    }
    const user = (await privy.getUserByWalletAddress(address)) as
      | { linkedAccounts?: Array<Record<string, unknown>> }
      | null;
    if (!user) {
      return {
        ok: false,
        detail:
          `Privy has no user for ${address}. Either it is an external wallet rather than a Privy ` +
          `embedded one, or NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET belong to different apps.`,
      };
    }
    const hit = (user.linkedAccounts ?? []).find(
      (a) => a?.type === 'wallet' && String(a?.address ?? '').toLowerCase() === address.toLowerCase(),
    );
    const client = String(hit?.walletClientType ?? '');
    return {
      ok: true,
      embedded: client === 'privy' || client === 'privy-v2',
      delegated: hit?.delegated === true,
      // Privy's own spelling of the address, carried back deliberately. See
      // privyWalletAddress below for why the caller must not re-case it.
      stored: String(hit?.address ?? address),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'Privy lookup failed.' };
  }
}

export async function sendAsUser(args: {
  account: string;
  to: string;
  valueWei: bigint;
  chainId: number;
}): Promise<string> {
  const problem = delegationProblem();
  if (problem) throw new Error(problem);

  // The ceiling is enforced on the 18-decimal native value, which is what
  // actually leaves the wallet, rather than on the human number we were handed.
  // BigInt(...) rather than a literal: tsconfig targets below ES2020 here, and
  // 10n ** 12n will not compile.
  const ceilingWei = BigInt(Math.round(SERVER_MAX_PER_CALL * 1e6)) * BigInt('1000000000000');
  if (args.valueWei > ceilingWei) {
    throw new Error(
      `Refused: ${SERVER_MAX_PER_CALL} USDC is the hard per-call ceiling on this server, whatever the account policy says.`,
    );
  }

  const privy = await getClient();
  const { hash } = await privy.walletApi.ethereum.sendTransaction({
    address: args.account,
    caip2: `eip155:${args.chainId}`,
    transaction: {
      to: args.to,
      value: `0x${args.valueWei.toString(16)}`,
      chainId: args.chainId,
    },
  });
  return hash;
}

/**
 * The exact address string Privy stores for `address`, or null if it has none.
 *
 * Privy's two lookups disagree about case, and that disagreement is a trap.
 * `getUserByWalletAddress` matches any spelling, so a check built on it passes
 * for a lowercased address. `walletApi.ethereum.signTypedData` matches the
 * stored string literally and answers "no wallet account found for address"
 * for the same input. A preflight built on the first will therefore report a
 * wallet as ready while every signature with it fails, which is the worst
 * shape a check can have: green, confident and wrong.
 *
 * Reading the spelling back and signing with that removes the guess. The
 * alternative, checksumming the address ourselves, only works while our EIP-55
 * and theirs agree, and silently returns to this same failure if they ever
 * do not.
 */
export async function privyWalletAddress(address: string): Promise<string | null> {
  const d = await describeWallet(address);
  return d.ok ? d.stored : null;
}
