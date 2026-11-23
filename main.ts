// BTC race bot, round 2: high-variance momentum revision.
//
// Long only, one full-equity position at a time. Enters all-in on a fast
// 20-bar momentum signal when the 120-bar regime is not falling, then rides
// the move with only a wide 5% trailing stop and a momentum-reversal exit.
// No take-profit, no cost stop, no dip filter: the bet is that one strong
// trend day pays for the whipsaws. Speaks agent-fun/bars-replay/v1 on
// stdin/stdout through the vendored SDK shim.
//
// Decisions use only the closes seen so far, in exact bigint arithmetic.
// No randomness, no wall clock, no environment reads: two runs on the same
// bars produce byte-identical action logs.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// The window is 1,440 one-minute bars; batches are one per minute, so the
// last batch is seq warmupBars + 1439.
const TOTAL_BARS = 1440;
const NO_ENTRY_TAIL_BARS = 30;
const MAX_SLIPPAGE_BPS = 150;
// Minimum cash to bother entering: $1, in quote units (6 decimals).
const MIN_CASH_UNITS = 1_000_000n;
// Entry: 20-bar return above +10 bps, 120-bar return above -50 bps.
const ENTRY_RET20_BPS = 10n;
const REGIME_RET120_BPS = -50n;
// Exits, after holding at least 3 bars: 5% trailing stop below the peak
// close since entry, or the 20-bar return falling below -200 bps.
const EXIT_RET20_BPS = -200n;
const TRAIL_BPS = 500n;
const MIN_HOLD_BARS = 3;
// Bars to wait after an exit before a new entry may fire.
const EXIT_COOLDOWN_BARS = 5;

// ---------------------------------------------------------------- state

// Every CBBTC close seen so far, oldest first. The bar index of the latest
// close is closes.length - 1.
const closes: bigint[] = [];
// Entry state, meaningful only while long: the close the entry was decided
// on, the bar index of that decision, and the highest close since entry.
let entryClose = 0n;
let entryBar = -1;
let peakClose = 0n;
// Bar index of the most recent exit fill; deeply negative until the first.
let lastExitBar = -1_000_000;
// A buy decided on the previous batch, awaiting its fill report.
let pendingBuy: { price: bigint; bar: number } | null = null;
// A sell has been sent and not yet reported filled; retry until it fills.
let pendingSell = false;

// Return in bps between the latest close and the close `bars` bars back.
// Null when not enough closes have been seen yet, or when the reference
// close is zero (a zero divisor would throw and kill the run).
function retBps(bars: number): bigint | null {
  if (closes.length <= bars) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - bars]!;
  if (then === 0n) return null;
  return ((now - then) * 10_000n) / then;
}

function sellAll(state: BarsState): OrderInput[] {
  const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
  if (qty <= 0n) return [];
  pendingSell = true;
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

async function onBatch(state: BarsState, batch: Batch): Promise<OrderInput[]> {
  // Fold in this batch's fresh bar, if CBBTC traded this minute.
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  const freshBar = bar !== undefined;
  if (freshBar) closes.push(BigInt(bar.c));
  const barIndex = closes.length - 1;
  const latestClose = closes.length > 0 ? closes[closes.length - 1]! : null;

  // Settle the previous batch's orders from their fill reports.
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.side === 'buy') {
      if (fill.status === 'filled' && pendingBuy !== null) {
        entryClose = pendingBuy.price;
        entryBar = pendingBuy.bar;
        peakClose = pendingBuy.price;
      }
      pendingBuy = null;
    } else if (fill.side === 'sell' && fill.status === 'filled') {
      pendingSell = false;
      lastExitBar = barIndex;
    }
  }

  // Position is whatever the account reports, never an assumption.
  const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
  if (qty === 0n) {
    pendingSell = false;
    if (pendingBuy === null) {
      entryClose = 0n;
      entryBar = -1;
      peakClose = 0n;
    }
  }

  // No orders on a warm-up batch, on a batch with no fresh bar, or on the
  // last batch (the harness rejects those; the position auto-flattens).
  const firstScoredSeq = state.warmupBars;
  const lastSeq = firstScoredSeq + TOTAL_BARS - 1;
  if (state.warmingUp || !freshBar || latestClose === null || state.seq >= lastSeq) return [];

  // A refused sell is retried on every following batch until it fills;
  // never buy while a sell is pending.
  if (pendingSell) return sellAll(state);

  if (qty > 0n) {
    // Long: track the peak, then check the exits once the minimum hold
    // has passed.
    if (latestClose > peakClose) peakClose = latestClose;
    if (barIndex - entryBar < MIN_HOLD_BARS) return [];
    const trailingStop = latestClose * 10_000n < peakClose * (10_000n - TRAIL_BPS);
    const ret20 = retBps(20);
    const reversal = ret20 !== null && ret20 < EXIT_RET20_BPS;
    if (trailingStop || reversal) return sellAll(state);
    return [];
  }

  // Flat: wait for a pending buy's fill report before deciding anything.
  if (pendingBuy !== null) return [];

  // Entry: fast momentum up, regime not falling, cooled down after the
  // last exit, not in the last 30 bars, and at least $1 of cash.
  const ret20 = retBps(20);
  if (ret20 === null || ret20 <= ENTRY_RET20_BPS) return [];
  const ret120 = retBps(120);
  if (ret120 !== null && ret120 <= REGIME_RET120_BPS) return [];
  if (barIndex - lastExitBar < EXIT_COOLDOWN_BARS) return [];
  if (state.seq >= firstScoredSeq + TOTAL_BARS - NO_ENTRY_TAIL_BARS) return [];
  if (state.cash < MIN_CASH_UNITS) return [];

  pendingBuy = { price: latestClose, bar: barIndex };
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({ onBatch });
