import {el, card, kpi, panelHead, note, help, actionForm, toast} from "../lib/ui.js"
import {fromWei, shortAddr, commas} from "../lib/format.js"
import {lineChart, SERIES} from "../lib/charts.js"

// Panel-local state survives re-renders so a generated batch isn't lost when
// the poll ticks.
const local = {
    info: null,
    batch: null,
    history: [],
    recipient: null,
    sender: null
}

export default function paymentsPanel(store, ctx) {
    const s = store.state || {}

    if (!s.deployed) {
        return el(
            "div",
            {},
            panelHead("PAYMENTS", "No broker yet.", "Deploy the protocol on the SETUP panel first.", "pay"),
            note("The TicketBroker isn't on this chain yet.", "warn")
        )
    }

    const pool = s.pool || []
    const acting = store.acting()

    if (!local.sender) local.sender = acting
    if (!local.recipient && pool.length) local.recipient = pool[0].address

    // Refresh sender balances lazily; the panel re-renders when it lands.
    if (!local.info || local.info.sender !== local.sender) {
        ctx.api
            .post("/api/tickets/info", {sender: local.sender})
            .then(info => {
                local.info = info
                store.emitChange()
            })
            .catch(() => {})
    }

    const info = local.info || {deposit: "0", reserve: "0", withdrawRound: "0"}

    // ── controls ────────────────────────────────────────────────────────────
    const senderSel = el("select", {}, ...store.accounts.map(a =>
        el("option", {value: a.address, text: `#${a.index}  ${shortAddr(a.address)}`})
    ))
    senderSel.value = local.sender || ""
    senderSel.addEventListener("change", ev => {
        local.sender = ev.target.value
        local.info = null
        local.batch = null
        store.emitChange()
    })

    const recipientSel = el(
        "select",
        {},
        ...(pool.length
            ? pool.map(t => el("option", {value: t.address, text: `${shortAddr(t.address)} ${t.active ? "(active)" : ""}`}))
            : [el("option", {value: "", text: "— no orchestrators registered —"})])
    )
    recipientSel.value = local.recipient || ""
    recipientSel.addEventListener("change", ev => {
        local.recipient = ev.target.value
    })

    const countInput = el("input", {type: "text", value: "100", spellcheck: "false"})
    const oddsInput = el("input", {type: "text", value: "10", spellcheck: "false"})
    const faceInput = el("input", {type: "text", value: "0.01", spellcheck: "false"})

    const generateBtn = el("button", {
        class: "btn accent",
        text: "SIGN A BATCH",
        onclick: async () => {
            if (!local.recipient) {
                toast("Register an orchestrator first — tickets need a recipient.", {kind: "bad", title: "No recipient"})
                return
            }
            generateBtn.disabled = true
            try {
                const res = await ctx.api.post("/api/tickets/generate", {
                    sender: local.sender,
                    recipient: local.recipient,
                    count: Number(countInput.value) || 100,
                    oneInN: Number(oddsInput.value) || 10,
                    faceValue: faceInput.value || "0.01"
                })
                local.batch = res
                local.history.push({
                    n: local.history.length + 1,
                    count: res.count,
                    expected: res.expectedWinners,
                    actual: res.winners
                })
                store.emitChange()
            } catch (err) {
                toast(err.message, {kind: "bad", title: "Could not sign tickets", ms: 14000})
            } finally {
                generateBtn.disabled = false
            }
        }
    })

    // The signed batch lives on the server, so a page reload shouldn't strand
    // it — fall back to the count the server reports.
    const serverHasBatch = Boolean(info.batch)
    const redeemBtn = el("button", {
        class: "btn",
        text: "REDEEM WINNERS",
        disabled: !((local.batch && local.batch.winners > 0) || serverHasBatch),
        onclick: async () => {
            redeemBtn.disabled = true
            try {
                const res = await ctx.api.post("/api/tickets/redeem", {})
                if (res.ok) {
                    toast(`Redeemed ${res.redeemed.length} winning ticket(s) on-chain.`, {kind: "ok", title: "REDEEMED"})
                    local.batch = null
                    local.info = null
                } else {
                    toast(res.error, {kind: "bad", title: "Redemption failed", ms: 14000})
                }
                await ctx.refresh()
            } catch (err) {
                toast(err.message, {kind: "bad", title: "Redemption failed", ms: 14000})
            } finally {
                redeemBtn.disabled = false
            }
        }
    })

    // ── convergence chart: expected vs realized winners, cumulative ─────────
    let cumCount = 0
    let cumWon = 0
    const expectedPts = []
    const actualPts = []
    for (const h of local.history) {
        cumCount += h.count
        cumWon += h.actual
        expectedPts.push({x: cumCount, y: cumCount / (Number(oddsInput.value) || 10)})
        actualPts.push({x: cumCount, y: cumWon})
    }

    const convergence = [
        {name: "Expected winners", color: SERIES[0], points: expectedPts},
        {name: "Actual winners", color: SERIES[1], points: actualPts}
    ]

    // ── batch visual ────────────────────────────────────────────────────────
    const batchGrid = local.batch
        ? el(
              "div",
              {style: "display:flex;flex-wrap:wrap;gap:3px;margin:10px 0"},
              ...local.batch.tickets.slice(0, 400).map(t =>
                  el("i", {
                      title: `nonce ${t.nonce} — ${t.won ? "WINNER" : "worthless"}`,
                      style:
                          `display:block;width:9px;height:9px;border-radius:2px;` +
                          `background:${t.won ? SERIES[1] : "#e3e0d9"}`
                  })
              )
          )
        : null

    const actions = store.byPanel("payments").map(a => actionForm(a, ctx))

    return el(
        "div",
        {},
        panelHead(
            "PAYMENTS · THE TICKET LOTTERY",
            "Pay a fraction of a cent, ten thousand times, for one transaction's worth of gas.",
            "Transcoding a segment is worth almost nothing, and writing that to a chain costs more than the payment. " +
                "So gateways send tickets that are mostly worthless and occasionally worth a lot. Same expected value, " +
                "a fraction of the gas.",
            "pay"
        ),
        Number(info.deposit) === 0
            ? note(
                  "<b>No deposit yet.</b> Fund a deposit and reserve below before signing tickets — a winning ticket " +
                      "with nothing behind it pays nobody.",
                  "warn"
              )
            : null,
        el(
            "div",
            {class: "kpis"},
            kpi("DEPOSIT", fromWei(info.deposit, 4), {
                sub: "ETH · spending money",
                helpText:
                    "Winning tickets draw from here first. When it runs dry mid-ticket, the remainder comes out of " +
                    "the reserve.",
                source: "MixinTicketBrokerCore.sol:senders",
                accent: "pay"
            }),
            kpi("RESERVE", fromWei(info.reserve, 4), {
                sub: "ETH · backstop",
                helpText:
                    "Covers winners bigger than the remaining deposit, so orchestrators aren't left holding a winner " +
                    "from an account that just ran out.",
                source: "MixinReserve.sol"
            }),
            kpi("BATCH", local.batch ? commas(local.batch.count) : "—", {
                sub: local.batch ? `${local.batch.winners} winners` : "none signed",
                helpText:
                    "Tickets are signed off-chain and cost nothing. Only winners ever become transactions — that is " +
                    "the entire saving."
            }),
            kpi("ODDS", local.batch ? `1 in ${local.batch.oneInN}` : `1 in ${oddsInput.value}`, {
                sub: local.batch ? `expected ${local.batch.expectedWinners.toFixed(1)}` : "",
                helpText:
                    "winProb is a uint256 threshold. The contract hashes the gateway's signature together with the " +
                    "orchestrator's secret and checks whether the result lands below it.",
                source: "MixinTicketBrokerCore.sol:isWinningTicket"
            })
        ),
        el(
            "div",
            {class: "grid side"},
            card(
                "TICKET SIMULATOR",
                {sub: "sign a batch, see who won", accent: "pay"},
                el(
                    "div",
                    {class: "fields"},
                    el("div", {class: "field"}, el("label", {}, "GATEWAY (SENDER)", help("The account paying. It needs a funded deposit.", "TicketBroker")), senderSel),
                    el("div", {class: "field"}, el("label", {}, "ORCHESTRATOR (RECIPIENT)", help("Who gets paid. Must be a registered orchestrator so fees can be split.", "BondingManager")), recipientSel),
                    el("div", {class: "field"}, el("label", {}, "TICKETS", help("How many to sign. Signing is free and off-chain.", "")), countInput, el("div", {class: "conv", text: "off-chain, costs nothing"})),
                    el("div", {class: "field"}, el("label", {}, "ODDS (1 IN N)", help("Lower N = more winners = more gas. Higher N = rarer, larger payouts.", "")), oddsInput, el("div", {class: "conv", text: "winProb = MAX_UINT256 / N"})),
                    el("div", {class: "field"}, el("label", {}, "FACE VALUE", help("What a winning ticket pays out, in ETH. Expected value per ticket is faceValue / N.", "")), faceInput, el("div", {class: "conv", text: "ETH per winner"}))
                ),
                el("div", {class: "btn-row"}, generateBtn, redeemBtn),
                batchGrid,
                local.batch
                    ? el("p", {
                          class: "dim",
                          style: "font-size:12px",
                          text:
                              `Signed ${local.batch.count} tickets. ${local.batch.winners} won ` +
                              `(expected ${local.batch.expectedWinners.toFixed(1)}). Only those ${local.batch.winners} ` +
                              `ever touch the chain — the rest are worthless paper, which is the point.`
                      })
                    : el("p", {
                          class: "dim",
                          style: "font-size:12px",
                          text: "Each square below will be one ticket. Orange means it won."
                      })
            ),
            card(
                "CONVERGENCE",
                {sub: "expected vs realized", accent: "pay"},
                lineChart(convergence, {
                    xLabel: "TICKETS",
                    yLabel: "CUMULATIVE WINNERS",
                    format: v => v.toFixed(1),
                    height: 190,
                    width: 420,
                    empty: "Sign a few batches — the two lines converge as the sample grows."
                }),
                el("p", {
                    class: "dim",
                    style: "font-size:11.5px;padding:0 4px",
                    text:
                        "Over a few batches the realized count wanders around the expectation; over many it hugs it. " +
                        "That convergence is why an orchestrator can accept lottery tickets as payment at all."
                })
            )
        ),
        el("div", {style: "height:16px"}),
        card("BROKER CALLS", {sub: "funding and withdrawal", accent: "pay"}, ...actions)
    )
}
