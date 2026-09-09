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
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        loginMethods: ['email', 'wallet'],
        appearance: { theme: '#0a0a0a', accentColor: '#2FFF00' },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
