import {el, card, kpi, panelHead, note, help, actionForm} from "../lib/ui.js"
import {fromWei, shortAddr, percent, commas, toBig} from "../lib/format.js"
import {lineChart, barChart, colorMap, SERIES} from "../lib/charts.js"

const PERC = "1000000"

export default function stakePanel(store, ctx) {
    const s = store.state || {}

    if (!s.deployed) {
        return el(
            "div",
            {},
            panelHead("STAKE", "Nothing staked yet.", "Deploy the protocol on the SETUP panel first.", "stake"),
            note("The BondingManager isn't on this chain yet.", "warn")
        )
    }

    const acting = String(store.acting() || "").toLowerCase()
    const pool = s.pool || []
    const me = pool.find(t => t.address.toLowerCase() === acting)

    // Stable colour per orchestrator, assigned by pool identity and reused by
    // every chart on the panel.
    const colors = colorMap(pool.map(t => t.address))

    // ── active set table ────────────────────────────────────────────────────
    const rows = pool.map(t => {
        const isYou = t.address.toLowerCase() === acting
        const swatch = el("i", {
            style: `display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${colors.get(
                t.address.toLowerCase()
            )}`
        })
        return el(
            "tr",
            {class: isYou ? "is-you" : ""},
            el("td", {}, String(t.rank)),
            el("td", {}, swatch, shortAddr(t.address), isYou ? el("span", {class: "tag you", style: "margin-left:6px", text: "YOU"}) : null),
            el("td", {class: "num"}, fromWei(t.totalStake, 2)),
            el("td", {class: "num"}, fromWei(t.selfStake, 2)),
            el("td", {class: "num"}, percent(t.rewardCut, PERC, 2)),
            el("td", {class: "num"}, percent(t.feeShare, PERC, 2)),
            el("td", {class: "num"}, commas(t.lastRewardRound)),
            el("td", {}, t.active ? el("span", {class: "tag on", text: "ACTIVE"}) : el("span", {class: "tag off", text: "OUT"}))
        )
    })

    const table = pool.length
        ? el(
              "div",
              {class: "table-wrap"},
              el(
                  "table",
                  {class: "data"},
                  el(
                      "thead",
                      {},
                      el(
                          "tr",
                          {},
                          el("th", {}, "#"),
                          el("th", {}, "ORCHESTRATOR"),
                          el("th", {class: "right"}, "TOTAL STAKE"),
                          el("th", {class: "right"}, "SELF"),
                          el("th", {class: "right"}, "REWARD CUT"),
                          el("th", {class: "right"}, "FEE SHARE"),
                          el("th", {class: "right"}, "LAST REWARD"),
                          el("th", {}, "STATUS")
                      )
                  ),
                  el("tbody", {}, ...rows)
              )
          )
        : el("div", {class: "empty"}, "No orchestrators registered. Bond to yourself, then hit 'Become an orchestrator'.")

    // ── charts ──────────────────────────────────────────────────────────────
    const points = (store.series.points || []).filter(p => p.pool && p.pool.length)

    // One line per orchestrator, coloured by identity.
    const byAddress = new Map()
    for (const p of points) {
        for (const entry of p.pool) {
            const key = entry.address.toLowerCase()
            if (!byAddress.has(key)) byAddress.set(key, [])
            byAddress.get(key).push({x: p.round, y: Number(fromWei(entry.totalStake, 6).replace(/,/g, ""))})
        }
    }

    const stakeSeries = [...byAddress.entries()]
        .map(([address, pts]) => ({
            name: shortAddr(address),
            color: colors.get(address) || SERIES[0],
            points: pts,
            last: pts.length ? pts[pts.length - 1].y : 0
        }))
        .sort((a, b) => b.last - a.last)
        .slice(0, 6)

    const distribution = pool.slice(0, 10).map(t => ({
        label: shortAddr(t.address),
        value: Number(fromWei(t.totalStake, 6).replace(/,/g, "")),
        color: colors.get(t.address.toLowerCase()),
        note: t.active ? "active" : "outside the set"
    }))

    // ── commission preview ──────────────────────────────────────────────────
    const cut = me ? Number(me.rewardCut) : 100000
    const cutPct = (cut / 1000000) * 100
    const splitBar = el(
        "div",
        {class: "split-bar"},
        el("i", {style: `width:${cutPct}%;background:${SERIES[1]}`, text: cutPct >= 12 ? `YOU ${cutPct.toFixed(0)}%` : ""}),
        el("i", {
            style: `width:${100 - cutPct}%;background:${SERIES[0]}`,
            text: 100 - cutPct >= 14 ? `DELEGATORS ${(100 - cutPct).toFixed(0)}%` : ""
        })
    )

    // ── your position ───────────────────────────────────────────────────────
    const yourKpis = el(
        "div",
        {class: "kpis"},
        kpi("YOUR TOTAL STAKE", me ? fromWei(me.totalStake, 4) : "—", {
            sub: me ? (me.active ? "in the active set" : "registered, not active") : "not an orchestrator",
            helpText:
                "Your own bonded LPT plus everything delegated to you. This is what the protocol ranks you by, " +
                "and what your share of each round's inflation is proportional to.",
            source: "BondingManager.sol:transcoderTotalStake",
            accent: "stake"
        }),
        kpi("TOTAL BONDED", fromWei(s.params.totalBonded || "0", 2), {
            sub: `of ${fromWei(s.params.totalSupply || "0", 0)} supply`,
            helpText:
                "Every LPT staked across the whole protocol. Divided by total supply this is the bonding rate, " +
                "which drives the inflation thermostat.",
            source: "BondingManager.sol:getTotalBonded"
        }),
        kpi("ACTIVE SET", `${pool.filter(t => t.active).length} / ${s.params.maxActiveTranscoders || "?"}`, {
            sub: "earning this round · slots available",
            helpText:
                "Only the top N orchestrators by stake can earn. The set is frozen when a round is initialized, " +
                "which is why a freshly registered orchestrator has to wait for the next round.",
            source: "BondingManager.sol:setCurrentRoundTotalActiveStake"
        }),
        kpi("MINTABLE THIS ROUND", fromWei(s.params.currentMintableTokens || "0", 4), {
            sub: `${fromWei(s.params.currentMintedTokens || "0", 4)} claimed`,
            helpText:
                "How much new LPT may be created this round, split between active orchestrators in proportion " +
                "to stake. Whatever nobody claims is simply never minted.",
            source: "Minter.sol:currentMintableTokens"
        })
    )

    const actions = store.byPanel("stake").map(a => actionForm(a, ctx))

    return el(
        "div",
        {},
        panelHead(
            "STAKE · BONDING AND REWARDS",
            "Lock tokens, back an operator, and split what gets minted.",
            "An orchestrator is just a delegator who delegates to themselves and then accepts delegation from " +
                "others. Everything on this panel is that one idea.",
            "stake"
        ),
        !me && pool.length === 0
            ? note(
                  "<b>Start here:</b> bond some LPT to your own address, then hit <i>Become an orchestrator</i>. " +
                      "Advance a round on the TIME panel and you'll be able to call <i>reward</i>.",
                  "",
                  "stake"
              )
            : null,
        me && !me.active
            ? note(
                  "<b>You're registered but not active yet.</b> The active set is frozen when a round opens, so you " +
                      "join from the <i>next</i> round. Advance one on the TIME panel.",
                  "warn"
              )
            : null,
        yourKpis,
        el(
            "div",
            {class: "grid two"},
            card(
                "STAKE OVER ROUNDS",
                {sub: "top 6 by current stake", accent: "stake"},
                lineChart(stakeSeries, {
                    xLabel: "ROUND",
                    yLabel: "TOTAL STAKE (LPT)",
                    empty: "No history yet. Use AUTO-RUN on the TIME panel to build some."
                })
            ),
            card(
                "STAKE DISTRIBUTION",
                {sub: "who holds the weight", accent: "stake"},
                barChart(distribution, {empty: "No orchestrators registered yet."})
            )
        ),
        el("div", {style: "height:16px"}),
        el(
            "div",
            {class: "grid side"},
            card(
                "ACTIVE SET",
                {sub: `${pool.length} registered`, accent: "stake"},
                table,
                el("p", {
                    class: "dim",
                    style: "font-size:12px;margin-top:10px",
                    text:
                        "Reward cut is what the orchestrator KEEPS from minted LPT. Fee share is what they PAY OUT " +
                        "of ETH fees. The two run in opposite directions — that asymmetry catches everyone."
                })
            ),
            card(
                "YOUR SPLIT",
                {sub: me ? "current terms" : "if you registered now", accent: "stake"},
                el(
                    "p",
                    {class: "action-blurb"},
                    "Of every 100 LPT minted for you, after the treasury takes its cut:"
                ),
                splitBar,
                el("p", {
                    class: "dim",
                    style: "font-size:11.5px",
                    text:
                        "Delegators split their portion in proportion to stake — and your own self-stake earns from " +
                        "that side too, on top of the cut you keep."
                })
            )
        ),
        el("div", {style: "height:16px"}),
        card("ACTIONS", {sub: "every bonding call, with its command", accent: "stake"}, ...actions)
    )
}
