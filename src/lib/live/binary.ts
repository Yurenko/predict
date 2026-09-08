import { OrderSide } from "@prisma/client";
import { outcomeIsDownToken, pickComplementOutcome } from "@/lib/normalize/markets";
import type { SignalDirection } from "@/lib/types/domain";
import type { PaperAction } from "@/lib/paper/action";

export type LiveBinaryAction = "ENTER_UP" | "ENTER_DOWN" | "EXIT" | "HOLD";

export function paperActionFromBinary(action: LiveBinaryAction): PaperAction | null {
  if (action === "HOLD") return null;
  return action === "EXIT" ? "EXIT" : "ENTER";
}

export function binaryOrderSide(action: LiveBinaryAction): OrderSide | null {
  if (action === "HOLD") return null;
  return action === "EXIT" ? OrderSide.SELL : OrderSide.BUY;
}

export function openBinaryLegs(options: {
  hasOpen?: boolean;
  openOutcomeName?: string | null;
  hasOpenUp?: boolean;
  hasOpenDown?: boolean;
}): { hasOpenUp: boolean; hasOpenDown: boolean } {
  if (options.hasOpenUp != null || options.hasOpenDown != null) {
    return {
      hasOpenUp: Boolean(options.hasOpenUp),
      hasOpenDown: Boolean(options.hasOpenDown),
    };
  }
  if (!options.hasOpen) return { hasOpenUp: false, hasOpenDown: false };
  const down = outcomeIsDownToken(options.openOutcomeName);
  return { hasOpenUp: !down, hasOpenDown: down };
}

/**
 * BUY → Up token. SELL → Down token. EXIT sells that token's full stack.
 * oppositeCloses=true (PAPER, or LIVE flip mode): a SELL while long Up exits Up first.
 * oppositeCloses=false (LIVE independent): Up and Down are independent legs; only EXIT closes.
 */
export function decideLiveBinaryAction(options: {
  direction: SignalDirection;
  hasOpen?: boolean;
  openOutcomeName?: string | null;
  hasOpenUp?: boolean;
  hasOpenDown?: boolean;
  oppositeCloses?: boolean;
}): LiveBinaryAction {
  if (options.direction === "FLAT") return "HOLD";
  const { hasOpenUp, hasOpenDown } = openBinaryLegs(options);
  const oppositeCloses = options.oppositeCloses !== false;

  if (options.direction === "EXIT") {
    if (hasOpenUp || hasOpenDown) return "EXIT";
    return "HOLD";
  }

  const wantDown = options.direction === "SELL";
  if (oppositeCloses) {
    const hasOpen = hasOpenUp || hasOpenDown;
    if (!hasOpen) return wantDown ? "ENTER_DOWN" : "ENTER_UP";
    const haveDown = hasOpenDown && !hasOpenUp;
    if (wantDown === haveDown) return "HOLD";
    return "EXIT";
  }

  if (wantDown) return hasOpenDown ? "HOLD" : "ENTER_DOWN";
  return hasOpenUp ? "HOLD" : "ENTER_UP";
}

export function invertBinaryPrice(price: number | null): number | null {
  if (price == null || !Number.isFinite(price)) return null;
  const inverted = 1 - price;
  if (inverted < 0 || inverted > 1) return null;
  return inverted;
}

export function invertBinaryBook(book: {
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
}): { bestBid: number | null; bestAsk: number | null; lastPrice: number | null } {
  return {
    bestBid: invertBinaryPrice(book.bestAsk),
    bestAsk: invertBinaryPrice(book.bestBid),
    lastPrice: invertBinaryPrice(book.lastPrice),
  };
}

export function resolveLiveBinaryTarget<T extends { id?: string; tokenId: string; name: string }>(options: {
  action: LiveBinaryAction;
  primaryTokenId: string | null;
  primaryOutcomeId?: string | null;
  outcomes: T[];
  openTokenId?: string | null;
}): { tokenId: string; outcomeId: string | undefined; invertBook: boolean } | null {
  if (options.action === "HOLD") return null;
  if (options.action === "EXIT") {
    const tokenId = options.openTokenId ?? options.primaryTokenId;
    if (!tokenId) return null;
    const row = options.outcomes.find((item) => item.tokenId === tokenId);
    return {
      tokenId,
      outcomeId: row?.id,
      invertBook: outcomeIsDownToken(row?.name),
    };
  }
  if (options.action === "ENTER_UP") {
    if (!options.primaryTokenId) return null;
    return {
      tokenId: options.primaryTokenId,
      outcomeId: options.primaryOutcomeId ?? undefined,
      invertBook: false,
    };
  }
  const down = pickComplementOutcome(options.outcomes, options.primaryTokenId ?? "");
  if (!down?.tokenId) return null;
  return {
    tokenId: down.tokenId,
    outcomeId: down.id,
    invertBook: true,
  };
}

function exitOpenTokenId(options: {
  hasOpenUp: boolean;
  hasOpenDown: boolean;
  openUpTokenId?: string | null;
  openDownTokenId?: string | null;
  openTokenId?: string | null;
}): string | null | undefined {
  if (options.hasOpenUp) return options.openUpTokenId ?? options.openTokenId;
  if (options.hasOpenDown) return options.openDownTokenId ?? options.openTokenId;
  return options.openTokenId;
}

export function resolveBinaryWorkerTrade(options: {
  direction: SignalDirection;
  hasOpen?: boolean;
  openOutcomeName?: string | null;
  openTokenId?: string | null;
  hasOpenUp?: boolean;
  hasOpenDown?: boolean;
  openUpTokenId?: string | null;
  openDownTokenId?: string | null;
  oppositeCloses?: boolean;
  primaryTokenId: string | null;
  primaryOutcomeId?: string | null;
  outcomes: { id?: string; tokenId: string; name: string }[];
}): {
  paperAction: Exclude<PaperAction, "HOLD">;
  binary: Exclude<LiveBinaryAction, "HOLD">;
  tokenId: string;
  outcomeId: string | undefined;
  invertBook: boolean;
  orderSide: OrderSide;
} | null {
  const oppositeCloses = options.oppositeCloses !== false;
  const legs = openBinaryLegs(options);
  const binary = decideLiveBinaryAction({
    direction: options.direction,
    hasOpen: options.hasOpen,
    openOutcomeName: options.openOutcomeName,
    hasOpenUp: legs.hasOpenUp,
    hasOpenDown: legs.hasOpenDown,
    oppositeCloses,
  });
  if (binary === "HOLD") return null;
  const openTokenId =
    binary === "EXIT"
      ? exitOpenTokenId({
          hasOpenUp: legs.hasOpenUp,
          hasOpenDown: legs.hasOpenDown,
          openUpTokenId: options.openUpTokenId,
          openDownTokenId: options.openDownTokenId,
          openTokenId: options.openTokenId,
        })
      : options.openTokenId;
  const target = resolveLiveBinaryTarget({
    action: binary,
    primaryTokenId: options.primaryTokenId,
    primaryOutcomeId: options.primaryOutcomeId,
    outcomes: options.outcomes,
    openTokenId,
  });
  if (!target) return null;
  const paperAction = paperActionFromBinary(binary);
  const orderSide = binaryOrderSide(binary);
  if (!paperAction || !orderSide) return null;
  return {
    paperAction,
    binary,
    tokenId: target.tokenId,
    outcomeId: target.outcomeId,
    invertBook: target.invertBook,
    orderSide,
  };
}
