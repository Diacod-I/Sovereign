// app/providers.tsx
'use client';
import { PrivyProvider } from '@privy-io/react-auth';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        embeddedWallets: { createOnLogin: 'users-without-wallets' },
        loginMethods: ['email', 'wallet'],
        appearance: { theme: '#0a0a0a', accentColor: '#2FFF00' },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
