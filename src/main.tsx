import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import '@fontsource-variable/manrope';
import App from './App';
import { wagmiConfig } from './chain';
import './styles.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <WagmiProvider config={wagmiConfig}><QueryClientProvider client={queryClient}><App /></QueryClientProvider></WagmiProvider>
</React.StrictMode>);
