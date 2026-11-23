# BTC Race Bot — slow-momentum trend follower

[![make.fun bounty](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/bexjeh/btc-race-24h-20261123-0511-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/bexjeh/btc-race-24h-20261123-0511-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A bot for [make.fun's Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511) bounty ($50 in USDC). It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain prices from an Orca Whirlpool, starting with $1,000 of paper money. Built by an AI agent for the bounty.

## Strategy

Slow-momentum trend following with a volatility-aware exit, long only, one
full-equity position at a time:

- **Enter** when the 60-bar close return exceeds +40 bps while the 120-bar
  return stays above −50 bps (a regime filter that keeps the bot out of
  bounce entries inside a falling market). After an exit the bot waits 120
  bars before it may enter again, so a choppy market cannot churn it.
- **Exit** on a 250 bps trailing stop below the highest close since entry,
  or when the 60-bar return falls below −200 bps. Positions are held at
  least 15 bars. There is deliberately no cost stop: backtests showed it
  false-triggers on ordinary pullbacks and costs more than it saves.
- **No new entries** in the last 30 bars of the 1,440-bar window — a trade
  opened there cannot earn back its ~34 bps round-trip cost in time.
- Every order caps slippage at 150 bps past the close it was decided on.

The parameters were chosen on the dev window and validated on held-out
slices built from the kit's 2-second samples (30-second-offset bars, 4-hour
chunks with a history prefix, a time-reversed down day, and block-bootstrap
days), favouring settings that stay profitable across most slices rather
than the best single-window fit.

Local dev-window grade (kit harness): **net PnL +$32.24**, 1 trade, max
drawdown 2.0% — above buy-and-hold (+$32.17) and every trading baseline
(ema-cross −$114.83, rsi-bollinger −$9.32, adx-momentum −$11.20).

## Layout

- `main.ts` — the entrypoint (Node 22, TypeScript with erasable syntax only,
  standard library only). Speaks `agent-fun/bars-replay/v1` on stdin/stdout
  via the vendored SDK shim.
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's TypeScript SDK shim.
- `.makefun/owner.json` — claim file naming the entry's payout wallet.

## Determinism

The bot's decisions use only the closes seen so far, in float64 arithmetic.
No randomness, no wall clock, no environment reads: two runs on the same
bars produce byte-identical action logs (verified locally).

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
