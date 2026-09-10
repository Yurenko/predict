# LIVE execution safety

## Source of truth

For Binance Prediction trading, LIVE account state is reconciled from the Prediction REST API:

- order history / active orders
- ONGOING positions
- PENDING_CLAIM positions when claim/recovery runs

The Prediction WebSocket API currently provides the prediction orderbook broadcast stream. It is used for low-latency market data, but it is not an authenticated user-order/position stream. Therefore LIVE order submission remains on the official REST `placeOrder` endpoint, and REST remains authoritative for account state.

## LIVE invariants

1. A cumulative Binance fill is applied to the database only as a delta from the last persisted cumulative fill.
2. Every fill delta creates one `Execution`.
3. Partial ENTER increases the existing position; it never creates another position for the same live inventory.
4. Partial EXIT decreases shares and realizes PnL only for the shares actually closed.
5. A SELL fill without a local position never creates a synthetic OPEN SELL position.
6. Binance inventory can recover a missing local LIVE position so the bot cannot accidentally open a duplicate position.
7. If Binance order/position synchronization fails at the start of a LIVE cycle, the cycle aborts and no new LIVE order is submitted.
8. LIVE ENTER obeys stale-data, API-breaker, cooldown, slippage and price-impact protections.
9. EXIT share quantity is taken from Binance ONGOING inventory; a failed inventory query does not fall back to stale local shares.

## PAPER

PAPER uses the same partial-fill accounting model:

- `PARTIALLY_FILLED` orders are retried by the paper worker.
- cumulative position shares are updated instead of creating a new position per retry.
- partial EXIT keeps the position OPEN until all shares are closed.
- PnL is realized only for the filled portion.

This makes PAPER much closer to the LIVE accounting model and therefore more useful for execution testing.
