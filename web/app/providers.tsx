// app/providers.tsx
'use client';
import { PrivyProvider } from '@privy-io/react-auth';
import { defineChain } from 'viem';
import { ARC_RPC_URL } from './lib/arc';

// Arc testnet — Circle's USDC-native L1. The native coin is USDC, and Arc's native
// value fields are 18-decimal wei (verified against a real balance). Configuring the
// chain here lets the embedded wallet sign + send USDC transfers on Arc (withdrawals).
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

// WalletConnect needs a Reown/WalletConnect Cloud project id. Without one its
// sign-client cannot open the relay socket, and its pino logger emits an error
// whose object has no enumerable properties — which Next's dev overlay surfaces
// as a bare `Console Error {}`. Noise, not a real failure, but it buries real
// errors, so WalletConnect is only switched on once a project id exists.
//
// Injected wallets (MetaMask and friends) do NOT go through WalletConnect, so
// the MetaMask login path is unaffected either way. Set
// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to re-enable mobile-wallet QR pairing.
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const WC_ENABLED = WC_PROJECT_ID.length > 0;

// `rainbow` and `wallet_connect` are WalletConnect-powered; listing them while
// WalletConnect is disabled is exactly the mismatch Privy warns breaks the
// connector UI, so they are only offered when WalletConnect is actually live.
const WALLET_LIST = WC_ENABLED
  ? (['detected_wallets', 'metamask', 'coinbase_wallet', 'rainbow', 'wallet_connect'] as const)
  : (['detected_wallets', 'metamask', 'coinbase_wallet'] as const);

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        // 'all-users' (not 'users-without-wallets') is load-bearing: a MetaMask
        // login already counts as "has a wallet", so under the old setting those
        // users got NO embedded wallet and every send path below broke. Sovereign
        // always signs with the embedded wallet on Arc — MetaMask is identity only.
        embeddedWallets: {
          ethereum: { createOnLogin: 'all-users' },
          showWalletUIs: true,
        },
        loginMethods: ['wallet', 'email'],
        appearance: {
          theme: '#0a0a0a',
          accentColor: '#2FFF00',
          // Detected injected extension first, then MetaMask by name.
          walletList: [...WALLET_LIST],
        },
        externalWallets: {
          walletConnect: { enabled: WC_ENABLED },
        },
        ...(WC_ENABLED ? { walletConnectCloudProjectId: WC_PROJECT_ID } : {}),
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
