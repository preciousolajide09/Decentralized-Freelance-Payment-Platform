/**
 * WalletProvider.tsx
 *
 * Provides the Freighter wallet state to the app. See `wallet-context.ts` for
 * the context object and the `useWallet` hook.
 */

import { useCallback, useMemo, useState, useEffect, type ReactNode } from "react";
import { networkPassphrase } from "../lib/stellar";
import { WalletContext, freighter } from "./wallet-context";
import { clearAuthToken } from "../lib/api";

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);

  const checkNetworkMatch = useCallback(async () => {
    const api = freighter();
    if (!api || !api.getNetwork) return;

    try {
      const freighterNetwork = await api.getNetwork();
      // Compare the network passphrase from Freighter with the configured network
      if (freighterNetwork.networkPassphrase !== networkPassphrase) {
        setNetworkMismatch(true);
      } else {
        setNetworkMismatch(false);
      }
    } catch {
      // If we can't get the network, assume there's no mismatch
      setNetworkMismatch(false);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const api = freighter();
      if (!api) throw new Error("Freighter wallet not found. Install it from freighter.app");
      const key = await api.getPublicKey();
      setPublicKey(key);
      // Check network after connecting
      await checkNetworkMatch();
      return key;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setConnecting(false);
    }
  }, [checkNetworkMatch]);

  const disconnect = useCallback(() => {
    if (publicKey) clearAuthToken(publicKey);
    setPublicKey(null);
    setError(null);
    setNetworkMismatch(false);
  }, [publicKey]);

  const sign = useCallback(async (xdr: string) => {
    const api = freighter();
    if (!api) throw new Error("Freighter wallet not found");
    return api.signTransaction(xdr, { networkPassphrase });
  }, []);

  const signMessage = useCallback(
    async (message: string) => {
      const api = freighter();
      if (!api) throw new Error("Freighter wallet not found");
      if (!api.signMessage) {
        throw new Error("This Freighter version can't sign messages; update the extension.");
      }
      const result = await api.signMessage(message, publicKey ? { address: publicKey } : undefined);
      return typeof result === "string" ? result : result.signature;
    },
    [publicKey],
  );

  // Check network on window focus
  useEffect(() => {
    if (!publicKey) return;

    const handleFocus = () => {
      void checkNetworkMatch();
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [publicKey, checkNetworkMatch]);

  const value = useMemo(
    () => ({
      publicKey,
      connecting,
      error,
      networkMismatch,
      connect,
      disconnect,
      sign,
      signMessage,
    }),
    [publicKey, connecting, error, networkMismatch, connect, disconnect, sign, signMessage],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
