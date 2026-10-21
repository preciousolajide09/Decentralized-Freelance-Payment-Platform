/**
 * wallet-context.ts
 *
 * Wallet context object + hook, kept separate from the provider component so
 * Fast Refresh works when editing the provider.
 *
 * Freighter injects an API object into the page. Depending on the version this
 * is either `window.freighterApi` (current) or `window.freighter` (legacy); we
 * support both so the app works without pinning a specific extension build.
 *
 * No private keys ever touch this code; Freighter signs in its own context.
 */

import { createContext, useContext } from "react";

export interface FreighterApi {
  getPublicKey(): Promise<string>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<string>;
  /** SEP-53 message signing. Newer versions return an object, older a string. */
  signMessage?(
    message: string,
    opts?: { address?: string },
  ): Promise<{ signature: string } | string>;
  /** Get the network details from Freighter */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
    freighterApi?: FreighterApi;
  }
}

export function freighter(): FreighterApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.freighterApi ?? window.freighter;
}

export interface WalletContextValue {
  publicKey: string | null;
  connecting: boolean;
  error: string | null;
  networkMismatch: boolean;
  connect: () => Promise<string | null>;
  disconnect: () => void;
  sign: (xdr: string) => Promise<string>;
  /** Sign a message per SEP-53; returns the base64 signature. */
  signMessage: (message: string) => Promise<string>;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
