// Slow-momentum trend bot for make.fun's btc-race-24h-20261123-0511.
//
// Reads one 1-minute cbBTC/USDC bar per batch (agent-fun/bars-replay/v1) and
// answers with buy/sell orders. Long only, $1,000 paper capital, full equity
// per trade.
//
// Strategy (chosen by backtesting the dev window plus held-out slices built
// from the kit's 2-second samples: 30-second-offset bars, 4-hour chunks with
// a history prefix, a time-reversed down day, and block-bootstrap days):
//   - Enter when the 60-bar close return exceeds +40 bps while the 120-bar
//     return is above -50 bps (a regime filter that keeps the bot out of
//     bounce entries inside a falling market). One trade per trend: after an
//     exit the bot waits 120 bars before it may enter again.
//   - Exit on a 250 bps trailing stop below the highest close since entry,
//     or when the 60-bar return falls below -200 bps. No cost stop: on this
//     data a cost stop false-triggers on ordinary pullbacks and costs more
//     than it saves. Positions are held at least 15 bars so a single noisy
//     bar cannot flip the bot out right after entry.
//   - No new entries in the last 30 batches of the 1440-bar window: a trade
//     opened there cannot earn back its ~34 bps round-trip cost in time.
//     No order at all is sent on the last batch (the replay would reject it
//     and flatten the position itself).
//   - A sell the market refuses (a gap past the slippage cap, a missing bar)
//     stays pending and is sent again on the next batch; the exit only counts
//     once its fill is seen, so a refused exit can never strand the position
//     with its peak reset.
//   - At most one open position; a buy spends the whole cash balance (the
//     weight cap is 100% of equity), a sell closes the whole position.
//
// Determinism: the decision uses only the closes seen so far, in float64
// arithmetic (+, -, /, comparisons). No randomness, no wall clock, no
// environment reads, so two runs on the same bars answer byte for byte alike.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// The window is 1,440 one-minute batches; seq counts batches, bars included.
const WINDOW_BARS = 1440;

// Entry: 60-bar momentum above this, with the 120-bar return above its floor.
const MOM_BARS = 60;
const ENTRY_BPS = 40;
const LONG_BARS = 120;
const LONG_MIN_BPS = -50;
// Exit: trailing stop below the peak close since entry, or momentum reversal.
const TRAIL_BPS = 250;
const SLOW_EXIT_BPS = -200;
// Frictions: wait after an exit, hold a minimum time, stop entering near the end.
const COOLDOWN_BARS = 120;
const MIN_HOLD_BARS = 15;
const NO_ENTRY_LAST = 30;
// Fill guard: the dev window's largest 1-minute move was 72 bps; 150 bps of
// headroom covers that plus the 2 bps modelled slippage and ~17 bps of impact
// on a full-size fill, while still refusing a fill into a real dislocation.
const MAX_SLIPPAGE_BPS = 150;

/** The closes seen, the peak since entry, and the bar counts that gate
 * entries and exits. Bar counts count CBBTC bars actually received, so a
 * minute with no bar neither ages a cooldown nor counts as a hold bar. */
const closes: number[] = [];
let peak: number | null = null;
let entryBar = -1e9;
let lastExitBar = -1e9;
/** The client_id of a sell that was sent but whose fill has not been seen
 * yet. The exit only counts once the fill lands: a sell the market refuses
 * (a gap past the slippage cap at the next open, a missing bar) is sent
 * again on the next batch instead of silently leaving the position open
 * with its peak reset. */
let pendingSellId: string | null = null;

/** The close's return over the last n bars, in basis points, or null while
 * fewer than n + 1 closes have been seen. */
function retBps(n: number): number | null {
  if (closes.length <= n) return null;
  return (closes[closes.length - 1]! / closes[closes.length - 1 - n]! - 1) * 10000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    // An order decided on the last batch is rejected (after_end); the replay
    // flattens any position at the last close on its own.
    if (state.seq >= WINDOW_BARS - 1) return [];
    // Resolve a pending sell from this batch's fills before deciding.
    let sellFilled = false;
    if (pendingSellId !== null) {
      const fill = batch.fills.find((f) => f.client_id === pendingSellId);
      if (fill !== undefined && fill.status === 'filled') {
        pendingSellId = null;
        sellFilled = true;
      }
    }
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) {
      // No bar for our symbol this minute: nothing new to decide on — except
      // a refused sell, which is retried even without a new close.
      if (pendingSellId !== null) {
        const held = state.positions.get(SYMBOL);
        if (held !== undefined) {
          pendingSellId = `x${state.seq}`;
          const retry: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: pendingSellId };
          return [retry];
        }
      }
      return [];
    }
    const close = Number(bar.c);
    closes.push(close);
    const barNo = closes.length - 1;
    if (sellFilled) {
      // The exit closed at this bar's open: the cooldown counts from here.
      lastExitBar = barNo;
      peak = null;
    }
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (peak === null || close > peak) peak = close;
      if (pendingSellId !== null) {
        // The last sell was refused; send it again with a fresh id.
        pendingSellId = `x${state.seq}`;
        const retry: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: pendingSellId };
        return [retry];
      }
      if (barNo - entryBar >= MIN_HOLD_BARS) {
        const trailHit = close < peak * (1 - TRAIL_BPS / 10000);
        const mom = retBps(MOM_BARS);
        const reversal = mom !== null && mom < SLOW_EXIT_BPS;
        if (trailHit || reversal) {
          // The peak and the cooldown are only reset when the fill is seen
          // (above); until then this sell stays pending.
          pendingSellId = `x${state.seq}`;
          const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: pendingSellId };
          return [sell];
        }
      }
      return [];
    }
    // Flat: look for an entry.
    if (state.seq >= WINDOW_BARS - NO_ENTRY_LAST) return [];
    if (barNo - lastExitBar < COOLDOWN_BARS) return [];
    const mom = retBps(MOM_BARS);
    if (mom === null || mom <= ENTRY_BPS) return [];
    const longMom = retBps(LONG_BARS);
    if (longMom !== null && longMom <= LONG_MIN_BPS) return [];
    const room = state.weightRoom(SYMBOL);
    const notional = state.cash < room ? state.cash : room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    entryBar = barNo;
    peak = close;
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
