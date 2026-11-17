// btc-race-bot: an aggressive-but-braked momentum bot for cbBTC/USDC on 1-minute bars,
// speaking agent-fun/bars-replay/v1 through the vendored SDK shim.
//
// The shape of a run: the harness sends one hello (universe, capital, caps, fees), then one
// batch per minute; each batch carries that minute's bar, the fills of the orders decided on
// the previous batch, and the account. Every batch gets exactly one reply echoing its seq,
// carrying this minute's orders. An order decided on a batch fills at the next bar's open, so
// every signal below is computed on closes and executed one bar later.
//
// Strategy (long only, at most one position, full size when it fires). Two rounds of local
// grades shaped it. Chasing strength — a Donchian breakout, a hot half hour — loses on a
// tape that swings instead of trending: the breakout close is the local top, the trade's
// best excursion afterwards is a few bps, and the ~26 bps a full-size round trip costs
// (4 bps fee, 2 bps slippage, constant-product impact, per side) bleeds out a few dollars
// at a time. Measuring forward returns signal by signal on the dev window showed the one
// family with real expectancy: the washout. After price has fallen at least WASH_PCT over
// the last WASH_BARS bars, the next two hours recover on average — and recover past the
// round-trip cost — so the bot buys the turn out of the washout, full size, and lets the
// recovery run under a trailing stop.
//   - Setup: the return over the last WASH_BARS bars reaches -WASH_PCT: a real washout,
//     not a dip. That arms the setup for ARM_BARS bars. A losing exit disarms it until the
//     return first climbs back above -RESET_PCT, so one long slide is not bought bar
//     after bar.
//   - Trend guard: while the slow EMA (EMA_LONG bars) is seeded, the close must be at
//     least that EMA less a small band. Washouts far under the trend are falling knives,
//     not pullbacks; before the EMA seeds there is no guard, only the washout's depth.
//   - Trigger: while armed, the close ticks up on the bar and the return over TURN_BARS
//     bars is at least TURN_RET — the first show of strength out of the washout, bought
//     near the washout's prices instead of the top's.
//   - Size: SIZE_BPS of the smaller of cash and the weight-cap room, halved while equity
//     is 10% or more under its peak (the drawdown brake); at a 16% drawdown the brake
//     flattens any position and blocks entries until a signal fires out of an extra-deep
//     washout (return at most -STRONG_WASH).
//   - Exits, whichever fires first: a take-profit into strength (the return over WASH_BARS
//     bars at least TP_RET while the trade is at least TP_PROFIT in profit: the recovery
//     has run, bank it before the tape takes it back); a hard stop HARD_STOP under the
//     average entry price; a trailing stop TRAIL_PCT under the peak close once the trade
//     has been TRAIL_ACTIVATE in profit; a second-leg guard (return over FADE_BARS bars
//     under FADE_RET: the washout is continuing, get out); a time stop — TIME_BARS bars
//     in, a trade that has not reached TIME_PROFIT is dead money in a tape that charges
//     by the trade; and the brake's flatten.
//   - After an exit, a cooldown keeps the bot out of the chop that stopped it: COOLDOWN
//     bars, LOSS_COOLDOWN after a losing trade.
// Deterministic by construction: closes and the EMA in float64 on + - * / only, no clock,
// no network, no randomness; the same bars give the same orders, run after run.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const WASH_BARS = 60;
const WASH_PCT = 0.005;
const RESET_PCT = 0.002;
const ARM_BARS = 15;
const TURN_BARS = 10;
const TURN_RET = 0.0012;
const EMA_LONG = 200;
const EMA_BAND = 0.002;
const STRONG_WASH = 0.008;
const SIZE_BPS = 9_800n;
const HALF_SIZE_BPS = 4_900n;
const HARD_STOP = 0.010;
const TRAIL_ACTIVATE = 0.0035;
const TRAIL_PCT = 0.0055;
const FADE_BARS = 30;
const FADE_RET = -0.006;
const TP_PROFIT = 0.008;
const TP_RET = 0.006;
const TIME_BARS = 180;
const TIME_PROFIT = 0.003;
const COOLDOWN = 30;
const LOSS_COOLDOWN = 60;
const DD_HALF = 0.10;
const DD_FLAT = 0.16;
/** Wide enough that a normal 1-minute gap at the next open never rejects a fill. */
const MAX_SLIPPAGE_BPS = 300;

/** The traded symbol, from hello (the universe holds exactly one). */
let symbol = '';
/** Exponent turning a position's cost/qty into its average price at the price scale. */
let priceExp = 0;

/** Every close so far, oldest first, as float64 at the raw price scale (ratios are scale-free). */
const closes: number[] = [];

/** The long EMA: the closes it has seen until it starts, then its value. */
const emaLong: { span: number; warm: number[]; value: number | null } = { span: EMA_LONG, warm: [], value: null };

function stepEma(close: number): void {
  if (emaLong.value !== null) {
    emaLong.value += (2 / (emaLong.span + 1)) * (close - emaLong.value);
    return;
  }
  emaLong.warm.push(close);
  if (emaLong.warm.length === emaLong.span) emaLong.value = emaLong.warm.reduce((a, x) => a + x, 0) / emaLong.span;
}

/** Return over the last m closes, or null without m + 1 closes. */
function ret(m: number): number | null {
  const n = closes.length;
  if (n <= m) return null;
  return closes[n - 1]! / closes[n - 1 - m]! - 1;
}

/** Peak equity (quote units) over the whole run: the drawdown brake's reference. */
let peakEquity = 0n;
/** Set while the drawdown brake has flattened the bot; an extra-deep washout clears it. */
let halted = false;
/** The batch seq before which no new entry is allowed (the post-exit cooldown). */
let cooldownUntil = -1;
/** The batch seq through which a washout setup stays armed, or -1 when no setup is armed. */
let armedUntil = -1;
/** After a losing exit, arming waits for the washout to reset (the return back above -RESET_PCT). */
let needsReset = false;

/** The open trade's reference points, set on the batch where the position first appears. */
let entryPrice = 0;
let entrySeq = -1;
let peakClose = 0;
let equityAtEntry = 0n;
let wasHeld = false;

function drawdown(state: BarsState): number {
  if (peakEquity === 0n) return 0;
  return 1 - Number(state.equity) / Number(peakEquity);
}

await runBars({
  onHello(state) {
    const s = state.hello.symbols[0]!;
    symbol = s.symbol;
    priceExp = s.qty_scale + s.price_scale - state.hello.capital.quote_scale;
    peakEquity = BigInt(state.hello.capital.quote_units);
  },

  onBatch(state, batch): OrderInput[] {
    if (state.equity > peakEquity) peakEquity = state.equity;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const prevClose = closes.length > 0 ? closes[closes.length - 1]! : close;
    closes.push(close);
    stepEma(close);

    const held = state.positions.get(symbol);
    const dd = drawdown(state);
    if (dd >= DD_FLAT) halted = true;

    // The position vanished since the last batch: the exit filled. Book the cooldown.
    if (wasHeld && held === undefined) {
      const loss = state.equity < equityAtEntry;
      cooldownUntil = batch.seq + (loss ? LOSS_COOLDOWN : COOLDOWN);
      if (loss) needsReset = true;
      entrySeq = -1;
      entryPrice = 0;
      peakClose = 0;
    }
    wasHeld = held !== undefined;

    if (state.warmingUp) return [];

    if (held !== undefined) {
      if (entrySeq < 0) {
        // First batch showing the position: its cost is the average fill price, fees in.
        entryPrice = (Number(held.cost) * 10 ** priceExp) / Number(held.qty);
        entrySeq = batch.seq;
        peakClose = close;
        equityAtEntry = state.equity;
      }
      if (close > peakClose) peakClose = close;
      const fade = ret(FADE_BARS);
      const stretch = ret(WASH_BARS);
      const exit =
        halted ||
        (stretch !== null && stretch >= TP_RET && close >= entryPrice * (1 + TP_PROFIT)) ||
        close <= entryPrice * (1 - HARD_STOP) ||
        (peakClose >= entryPrice * (1 + TRAIL_ACTIVATE) && close <= peakClose * (1 - TRAIL_PCT)) ||
        (fade !== null && fade <= FADE_RET) ||
        (batch.seq - entrySeq >= TIME_BARS && close < entryPrice * (1 + TIME_PROFIT));
      if (exit) return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      return [];
    }

    // Flat: maintain the washout setup, then look for the turn.
    const wash = ret(WASH_BARS);
    if (wash !== null) {
      if (needsReset && wash > -RESET_PCT) needsReset = false;
      if (!needsReset && wash <= -WASH_PCT) armedUntil = batch.seq + ARM_BARS;
    }
    if (batch.seq > armedUntil) armedUntil = -1;

    if (batch.seq < cooldownUntil || armedUntil < 0) return [];
    if (emaLong.value !== null && close < emaLong.value * (1 - EMA_BAND)) return [];
    const turn = ret(TURN_BARS);
    if (turn === null || turn < TURN_RET || close <= prevClose) return [];
    if (halted) {
      if (wash === null || wash > -STRONG_WASH) return [];
      halted = false;
    }
    armedUntil = -1;

    const room = state.weightRoom(symbol);
    const base = state.cash < room ? state.cash : room;
    const notional = (base * (dd >= DD_HALF ? HALF_SIZE_BPS : SIZE_BPS)) / BPS;
    if (notional === 0n || notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
