import {el, card, panelHead, note, actionForm, toast} from "../lib/ui.js"
import {fromWei, shortAddr} from "../lib/format.js"

export default function accountsPanel(store, ctx) {
    const s = store.state || {}
    const acting = String(store.acting() || "").toLowerCase()

    if (!s.deployed) {
        return el(
            "div",
            {},
            panelHead("ACCOUNTS", "Nothing to show yet.", "Deploy the protocol on the SETUP panel first.", "chain"),
            note("The token contract doesn't exist on this chain yet, so there are no LPT balances to read.", "warn")
        )
    }

    const pool = new Set((s.pool || []).map(t => t.address.toLowerCase()))

    const rows = store.accounts.map(a => {
        const isYou = a.address.toLowerCase() === acting
        const isOrch = pool.has(a.address.toLowerCase())
        const hasLpt = a.lpt !== "0"

        return el(
            "tr",
            {class: isYou ? "is-you" : ""},
            el("td", {}, `#${a.index}`),
            el("td", {}, shortAddr(a.address)),
            el("td", {class: "num"}, fromWei(a.eth, 2)),
            el("td", {class: "num"}, fromWei(a.lpt, 4)),
            el(
                "td",
                {},
                isOrch
                    ? el("span", {class: "tag on", text: "ORCHESTRATOR"})
                    : hasLpt
                      ? el("span", {class: "tag", text: "HOLDER"})
                      : el("span", {class: "tag off", text: "IDLE"})
            ),
            el(
                "td",
                {},
                isYou
                    ? el("span", {class: "tag you", text: "ACTING AS"})
                    : el("button", {
                          class: "mini",
                          text: "ACT AS",
                          onclick: () => {
                              store.actingAs = a.address
                              store.emitChange()
                          }
                      })
            )
        )
    })

    // A one-click way to get several delegators funded, since that's the setup
    // for almost every interesting experiment.
    const fundBtn = el("button", {
        class: "btn accent",
        text: "FUND 5 ACCOUNTS WITH 1,000 LPT",
        onclick: async () => {
            const deployer = store.accounts[0]
            if (!deployer) return
            const targets = store.accounts.slice(1, 6)
            fundBtn.disabled = true
            try {
                for (const t of targets) {
                    await ctx.api.post("/api/tx", {
                        id: "transferLPT",
                        from: deployer.address,
                        args: {_to: t.address, _amount: "1000"}
                    })
                }
                toast(`Sent 1,000 LPT to accounts #1–#5 from #0.`, {kind: "ok", title: "FUNDED"})
                await ctx.refresh()
            } catch (err) {
                toast(err.message, {kind: "bad", title: "Funding failed"})
            } finally {
                fundBtn.disabled = false
            }
        }
    })

    const actions = store.byPanel("accounts").map(a => actionForm(a, ctx))

    return el(
        "div",
        {},
        panelHead(
            "ACCOUNTS · WHO YOU ARE",
            "You control all of them, so you can play every role at once.",
            "The devnet unlocks every account. Pick who you're acting as, fund a few wallets, and you can be the " +
                "orchestrator, a dozen delegators and the gateway paying them — simultaneously, in one session.",
            "chain"
        ),
        note(
            `Account <b>#0</b> is the deployer. It owns the Controller — every owner-only knob is sent from it no ` +
                `matter who you're acting as — and it was minted <b>500,000 LPT</b> at deploy time. That is where ` +
                `all the play money comes from.`,
            "",
            "chain"
        ),
        el(
            "div",
            {class: "grid side"},
            card(
                "ACCOUNTS",
                {sub: `showing ${store.accounts.length} of ${store.accountTotal}`, accent: "chain"},
                el("div", {class: "btn-row", style: "margin-bottom:12px"}, fundBtn),
                el(
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
                                el("th", {}, "ADDRESS"),
                                el("th", {class: "right"}, "ETH"),
                                el("th", {class: "right"}, "LPT"),
                                el("th", {}, "ROLE"),
                                el("th", {}, "")
                            )
                        ),
                        el("tbody", {}, ...rows)
                    )
                )
            ),
            card("MOVE TOKENS", {sub: "fund your test cast", accent: "chain"}, ...actions)
        )
    )
}
