# btc-race-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/isanssss/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/isanssss/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A momentum trading bot for make.fun's btc-race-24h-20261117-0603 competition. It trades cbBTC against USDC on 1-minute bars over the agent-fun/bars-replay/v1 protocol: Donchian breakout entries confirmed by short-horizon momentum and an EMA trend filter, full-size long-only positions, a trailing stop and a hard stop, a momentum-fade exit, a post-loss cooldown, and an equity drawdown brake that halves size at a 10% drawdown and flattens at 16%. It reads one JSON line per batch on stdin (a hello, then one batch per bar carrying that bar's bar, the fills of its previous orders and its account) and answers every batch with exactly one reply echoing the batch's seq and carrying its orders. Fully deterministic: no clock, no network, no randomness.

## Run it

```sh
node main.ts
# Speaks agent-fun/bars-replay/v1 on stdin/stdout; the harness drives it bar by bar.
# Grade it on the dev window with the competition kit:
#   node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=sm62f3x7&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
