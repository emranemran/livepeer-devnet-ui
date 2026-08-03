import {el, card, kpi, panelHead, note, actionForm} from "../lib/ui.js"
import {fromWei, percent, commas} from "../lib/format.js"
import {lineChart, SERIES} from "../lib/charts.js"

const PERC = "1000000"
const PERC_V2 = "1000000000"
const PERC_PRECISE = "1000000000000000000000000000"

export default function knobsPanel(store, ctx) {
    const s = store.state || {}
    const p = s.params || {}

    if (!s.deployed) {
        return el(
            "div",
            {},
            panelHead("KNOBS", "No parameters to turn yet.", "Deploy the protocol on the SETUP panel first.", "knob"),
            note("Nothing is deployed on this chain.", "warn")
        )
    }

    const points = store.series.points || []
    const pct = (value, divisor) => (Number(value || 0) / Number(divisor)) * 100

    const bondingSeries = [
        {
            name: "Bonding rate",
            color: SERIES[0],
            points: points.map(x => ({x: x.round, y: pct(x.bondingRate, PERC_V2)}))
        }
    ]
    const targetPct = pct(p.targetBondingRate, PERC_V2)

    const inflationSeries = [
        {
            name: "Inflation per round",
            color: SERIES[1],
            points: points.map(x => ({x: x.round, y: pct(x.inflation, PERC_V2)}))
        }
    ]

    const treasurySeries = [
        {
            name: "Treasury balance",
            color: SERIES[0],
            points: points.map(x => ({x: x.round, y: Number(fromWei(x.treasuryBalance, 4).replace(/,/g, ""))}))
        }
    ]
    const ceiling = Number(fromWei(p.treasuryBalanceCeiling || "0", 4).replace(/,/g, ""))

    const bondingNow = pct(p.bondingRate, PERC_V2)
    const drift = bondingNow < targetPct ? "rising" : bondingNow > targetPct ? "falling" : "steady"

    const actions = store.byPanel("knobs").map(a => actionForm(a, ctx))

    // A compact table of live values, which also serves as the accessible
    // read-out for the charts above.
    const paramRows = [
        ["Active set size", commas(p.maxActiveTranscoders), "BondingManager", "top N orchestrators that can earn"],
        ["Registered orchestrators", commas(p.registeredTranscoders), "BondingManager", "how many are in the pool now"],
        ["Unbonding period", `${commas(p.unbondingPeriod)} rounds`, "BondingManager", "wait between unbond and withdraw"],
        ["Treasury cut", percent(p.treasuryRewardCutRate, PERC_PRECISE, 2), "BondingManager", "skimmed before rewards are split"],
        ["Treasury ceiling", `${fromWei(p.treasuryBalanceCeiling, 0)} LPT`, "BondingManager", "cut auto-zeroes above this"],
        ["Round length", `${commas(s.round && s.round.roundLength)} blocks`, "RoundsManager", "5,760 L1 blocks ≈ 19–20 h"],
        ["Round lock", percent(s.round && s.round.roundLockAmount, PERC, 2), "RoundsManager", "tail of the round that is frozen"],
        ["Inflation", percent(p.inflation, PERC_V2, 6), "Minter", "of total supply, per round"],
        ["Inflation step", percent(p.inflationChange, PERC_V2, 6), "Minter", "per-round adjustment"],
        ["Target bonding rate", percent(p.targetBondingRate, PERC_V2, 2), "Minter", "the thermostat set point"],
        ["Broker unlock period", `${commas(p.unlockPeriod)} rounds`, "TicketBroker", "gateway withdrawal delay"],
        ["Ticket validity", `${commas(p.ticketValidityPeriod)} rounds`, "TicketBroker", "how long a ticket stays redeemable"]
    ]

    return el(
        "div",
        {},
        panelHead(
            "KNOBS · PROTOCOL PARAMETERS",
            "The governance-owned dials, and what happens when you turn them.",
            "On mainnet each of these takes a community vote and a staged upgrade. Here you just type a number. " +
                "Every call on this panel is owner-only, so it is sent from account #0 no matter who you're acting as.",
            "knob"
        ),
        targetPct < 1
            ? note(
                  `<b>Heads up — the local defaults aren't mainnet's.</b> This devnet sets the target bonding rate to ` +
                      `<code>500000</code> and inflation to <code>137</code>, while Arbitrum mainnet uses ` +
                      `<code>500000000</code> and <code>218500</code>. The Minter reads all three against a ` +
                      `<b>10<sup>9</sup></b> divisor, so locally the target lands at <b>${targetPct.toFixed(2)}%</b> ` +
                      `rather than 50%. That's why the bonding rate sits <i>above</i> target here and inflation falls. ` +
                      `Set the target to <code>500000000</code> below to make it behave like mainnet.`,
                  "warn"
              )
            : null,
        note(
            `<b>The inflation thermostat.</b> Right now <b>${bondingNow.toFixed(2)}%</b> of supply is bonded against a ` +
                `target of <b>${targetPct.toFixed(2)}%</b>, so inflation is <b>${drift}</b>. Each round the Minter ` +
                `nudges the rate by the inflation step in whichever direction closes the gap. Move the target and ` +
                `auto-run twenty rounds to watch the loop chase it.`,
            "",
            "knob"
        ),
        el(
            "div",
            {class: "kpis"},
            kpi("BONDING RATE", `${bondingNow.toFixed(2)}%`, {
                sub: `target ${targetPct.toFixed(2)}%`,
                helpText:
                    "Total bonded divided by total supply. The Minter compares this to the target every round and " +
                    "moves inflation to close the gap.",
                source: "Minter.sol:setInflation",
                accent: "knob"
            }),
            kpi("INFLATION / ROUND", percent(p.inflation, PERC_V2, 5), {
                sub: `step ${percent(p.inflationChange, PERC_V2, 6)}`,
                helpText:
                    "Share of total supply minted each round. Mainnet sits near 0.02185% — note the Minter uses a " +
                    "10^9 divisor, not the 10^6 the BondingManager uses.",
                source: "Minter.sol:inflation"
            }),
            kpi("TREASURY", fromWei(p.treasuryBalance || "0", 2), {
                sub: `ceiling ${fromWei(p.treasuryBalanceCeiling || "0", 0)}`,
                helpText:
                    "The treasury takes its cut off the top of every reward call. When the balance crosses the " +
                    "ceiling the contract sets the cut rate to zero by itself.",
                source: "BondingManager.sol:_rewardWithHint"
            }),
            kpi("ACTIVE SLOTS", commas(p.maxActiveTranscoders), {
                sub: `${commas(p.registeredTranscoders)} registered`,
                helpText:
                    "Mainnet runs 100; a fresh local deploy runs 10. This knob only turns one way — the sorted " +
                    "list refuses to shrink, so you can raise it but never lower it. For eviction, register more " +
                    "orchestrators than there are slots and let stake decide.",
                source: "BondingManager.sol:setNumActiveTranscoders"
            })
        ),
        el(
            "div",
            {class: "grid two"},
            card(
                "BONDING RATE VS TARGET",
                {sub: "the thermostat's input", accent: "knob"},
                lineChart(bondingSeries, {
                    yLabel: "% OF SUPPLY BONDED",
                    format: v => `${v.toFixed(2)}%`,
                    reference: {y: targetPct, label: "target"},
                    empty: "No history yet — auto-run some rounds on the TIME panel."
                })
            ),
            card(
                "INFLATION RESPONSE",
                {sub: "the thermostat's output", accent: "knob"},
                lineChart(inflationSeries, {
                    yLabel: "% MINTED PER ROUND",
                    // Inflation moves in parts per billion; 5dp renders every
                    // tick as the same string.
                    format: v => `${v.toFixed(7)}%`,
                    empty: "No history yet — auto-run some rounds on the TIME panel."
                })
            )
        ),
        el("div", {style: "height:16px"}),
        el(
            "div",
            {class: "grid two"},
            card(
                "TREASURY VS CEILING",
                {sub: "watch the auto-stop trigger", accent: "knob"},
                lineChart(treasurySeries, {
                    yLabel: "TREASURY BALANCE (LPT)",
                    reference: ceiling > 0 ? {y: ceiling, label: "ceiling"} : null,
                    empty: "No history yet."
                })
            ),
            card(
                "LIVE VALUES",
                {sub: "what the chain says right now", accent: "knob"},
                el(
                    "div",
                    {class: "table-wrap"},
                    el(
                        "table",
                        {class: "data"},
                        el(
                            "thead",
                            {},
                            el("tr", {}, el("th", {}, "PARAMETER"), el("th", {class: "right"}, "VALUE"), el("th", {}, "CONTRACT"))
                        ),
                        el(
                            "tbody",
                            {},
                            ...paramRows.map(([name, value, contract, why]) =>
                                el(
                                    "tr",
                                    {title: why},
                                    el("td", {}, name),
                                    el("td", {class: "num"}, value),
                                    el("td", {class: "dim"}, contract)
                                )
                            )
                        )
                    )
                )
            )
        ),
        el("div", {style: "height:16px"}),
        card("TURN A KNOB", {sub: "owner-only calls, sent from account #0", accent: "knob"}, ...actions)
    )
}
