// app/providers.tsx
'use client';
import { PrivyProvider } from '@privy-io/react-auth';
import { defineChain } from 'viem';

// Arc testnet — Circle's USDC-native L1. The native coin is USDC, and Arc's native
// value fields are 18-decimal wei (verified against a real balance). Configuring the
// chain here lets the embedded wallet sign + send USDC transfers on Arc (withdrawals).
export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' },
  },
  testnet: true,
});

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
          // Show the injected extension first, then MetaMask by name, then the
          // WalletConnect fallback for mobile wallets.
          walletList: ['detected_wallets', 'metamask', 'coinbase_wallet', 'rainbow', 'wallet_connect'],
        },
        externalWallets: {
          walletConnect: { enabled: true },
        },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
