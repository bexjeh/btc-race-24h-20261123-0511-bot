"""Slow-momentum trend bot for make.fun's btc-race-24h-20261123-0511.

Reads one 1-minute cbBTC/USDC bar per batch (agent-fun/bars-replay/v1) and
answers with buy/sell orders. Long only, $1,000 paper capital, full equity
per trade.

Strategy (chosen by backtesting the dev window plus held-out slices built
from the kit's 2-second samples: 30-second-offset bars, 4-hour chunks with a
history prefix, a time-reversed down day, and block-bootstrap days):
  - Enter when the 60-bar close return exceeds +40 bps while the 120-bar
    return is above -50 bps (a regime filter that keeps the bot out of
    bounce entries inside a falling market). One trade per trend: after an
    exit the bot waits 120 bars before it may enter again.
  - Exit on a 250 bps trailing stop below the highest close since entry, or
    when the 60-bar return falls below -200 bps. No cost stop: on this data
    a cost stop false-triggers on ordinary pullbacks and costs more than it
    saves. Positions are held at least 15 bars so a single noisy bar cannot
    flip the bot out right after entry.
  - No new entries in the last 30 batches of the 1440-bar window: a trade
    opened there cannot earn back its ~34 bps round-trip cost in time.
  - At most one open position; a buy spends the whole cash balance (the
    weight cap is 100% of equity), a sell closes the whole position.

Determinism: the decision uses only the closes seen so far, in float64
arithmetic (+, -, /, comparisons). No randomness, no wall clock, no
environment reads, so two runs on the same bars answer byte for byte alike.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
import makefun_bars

SYMBOL = "CBBTC"
# The window is 1,440 one-minute batches; seq counts batches, bars included.
WINDOW_BARS = 1440

# Entry: 60-bar momentum above this, with the 120-bar return above its floor.
MOM_BARS = 60
ENTRY_BPS = 40
LONG_BARS = 120
LONG_MIN_BPS = -50
# Exit: trailing stop below the peak close since entry, or momentum reversal.
TRAIL_BPS = 250
SLOW_EXIT_BPS = -200
# Frictions: wait after an exit, hold a minimum time, stop entering near the end.
COOLDOWN_BARS = 120
MIN_HOLD_BARS = 15
NO_ENTRY_LAST = 30
# Fill guard: the dev window's largest 1-minute move was 72 bps; 150 bps of
# headroom covers that plus the 2 bps modelled slippage and ~17 bps of impact
# on a full-size fill, while still refusing a fill into a real dislocation.
MAX_SLIPPAGE_BPS = 150


class TrendBot:
    """State for one run: the closes seen, the peak since entry, and the bar
    counts that gate entries and exits. Bar counts count CBBTC bars actually
    received, so a minute with no bar neither ages a cooldown nor counts as
    a hold bar."""

    def __init__(self):
        self.closes = []
        self.peak = None
        self.entry_bar = -10 ** 9
        self.last_exit_bar = -10 ** 9

    def ret_bps(self, n):
        """The close's return over the last n bars, in basis points, or None
        while fewer than n + 1 closes have been seen."""
        closes = self.closes
        if len(closes) <= n:
            return None
        return (closes[-1] / closes[-1 - n] - 1.0) * 10000.0

    def on_batch(self, state, batch):
        if state.warming_up:
            return []
        bar = None
        for b in batch.get("bars", []):
            if b.get("symbol") == SYMBOL:
                bar = b
                break
        if bar is None:
            # No bar for our symbol this minute: nothing new to decide on.
            return []
        close = float(bar["c"])
        self.closes.append(close)
        bar_no = len(self.closes) - 1
        held = state.positions.get(SYMBOL)
        if held is not None:
            if self.peak is None or close > self.peak:
                self.peak = close
            if bar_no - self.entry_bar >= MIN_HOLD_BARS:
                trail_hit = close < self.peak * (1.0 - TRAIL_BPS / 10000.0)
                mom = self.ret_bps(MOM_BARS)
                reversal = mom is not None and mom < SLOW_EXIT_BPS
                if trail_hit or reversal:
                    self.last_exit_bar = bar_no
                    self.peak = None
                    return [{"side": "sell", "symbol": SYMBOL, "qty": held.qty,
                             "max_slippage_bps": MAX_SLIPPAGE_BPS}]
            return []
        # Flat: look for an entry.
        if state.seq >= WINDOW_BARS - NO_ENTRY_LAST:
            return []
        if bar_no - self.last_exit_bar < COOLDOWN_BARS:
            return []
        mom = self.ret_bps(MOM_BARS)
        if mom is None or mom <= ENTRY_BPS:
            return []
        long_mom = self.ret_bps(LONG_BARS)
        if long_mom is not None and long_mom <= LONG_MIN_BPS:
            return []
        room = state.weight_room(SYMBOL)
        notional = state.cash if state.cash < room else room
        if notional < int(state.hello["fees"]["min_notional_quote_units"]):
            return []
        self.entry_bar = bar_no
        self.peak = close
        return [{"side": "buy", "symbol": SYMBOL,
                 "notional_quote_units": notional,
                 "max_slippage_bps": MAX_SLIPPAGE_BPS}]


def main():
    bot = TrendBot()
    makefun_bars.run(bot.on_batch)


if __name__ == "__main__":
    main()
