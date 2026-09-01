import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";

export async function resolveWalletId(options: {
  walletAddress: string;
  configuredWalletId: string;
  listWallets: () => Promise<W3WPredictionRestAPI.ListPredictionWalletsResponse>;
}): Promise<string | null> {
  const configured = options.configuredWalletId.trim();
  if (configured) return configured;
  const address = options.walletAddress.trim().toLowerCase();
  if (!address) return null;
  const listed = await options.listWallets();
  const match = listed.wallets?.find(
    (wallet) => wallet.walletAddress?.trim().toLowerCase() === address && wallet.walletId,
  );
  return match?.walletId ?? null;
}
