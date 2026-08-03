import {el, card, kpi, panelHead, note, help, actionForm, toast} from "../lib/ui.js"
import {commas} from "../lib/format.js"

export default function timePanel(store, ctx) {
    const s = store.state || {}
    const r = s.round

    if (!s.deployed || !r) {
        return el(
            "div",
            {},
            panelHead("TIME", "No clock yet.", "Deploy the protocol on the SETUP panel first.", "time"),
            note("The RoundsManager isn't on this chain yet, so there is no round to advance.", "warn")
        )
    }

    const roundLength = Number(r.roundLength)

    async function post(path, body, label) {
        try {
            const res = await ctx.api.post(path, body)
            if (res.ok === false) {
                toast(res.error, {kind: "bad", title: label, ms: 12000})
            }
            await ctx.refresh()
            return res
        } catch (err) {
            toast(err.message, {kind: "bad", title: label, ms: 12000})
        }
    }

    const mineBtn = (label, blocks, helpText) =>
        el("button", {
            class: "btn secondary",
            text: label,
            title: helpText,
            onclick: async () => post("/api/time/mine", {blocks}, "Mine blocks")
        })

    const initBtn = el("button", {
        class: "btn accent",
        text: "INITIALIZE ROUND",
        disabled: r.initialized,
        onclick: async () => post("/api/time/initRound", {}, "Initialize round")
    })

    // Auto-run: the fastest way to build up chart history.
    const roundsInput = el("input", {type: "text", value: "10", spellcheck: "false"})
    const rewardChk = el("input", {type: "checkbox", checked: "checked"})
    const autoBtn = el("button", {
        class: "btn accent",
        text: "AUTO-RUN",
        onclick: async () => {
            autoBtn.disabled = true
            autoBtn.textContent = "RUNNING…"
            try {
                await post(
                    "/api/time/autoRun",
                    {rounds: Number(roundsInput.value) || 10, callReward: rewardChk.checked},
                    "Auto-run"
                )
                toast("Auto-run finished — check the charts on STAKE and KNOBS.", {kind: "ok", title: "AUTO-RUN"})
            } finally {
                autoBtn.disabled = false
                autoBtn.textContent = "AUTO-RUN"
            }
        }
    })

    const actions = store.byPanel("time").map(a => actionForm(a, ctx))

    return el(
        "div",
        {},
        panelHead(
            "TIME · ROUNDS",
            "The protocol has a heartbeat, and someone has to press the button.",
            "A round is 5,760 Ethereum L1 blocks — roughly 19–20 hours. Nothing about a new round takes effect until " +
                "somebody pays gas to open it. Locally you can skip time for free.",
            "time"
        ),
        r.initialized
            ? null
            : note(
                  "<b>This round isn't open yet.</b> Until someone calls <code>initializeRound()</code> the active " +
                      "set isn't frozen, no LPT is mintable, and most calls revert with <code>current round is not " +
                      "initialized</code>.",
                  "warn"
              ),
        r.locked
            ? note(
                  "<b>Round lock is active.</b> You're in the tail of the round where orchestrators can't change " +
                      "commission or join the pool — it gives delegators a stable window to review terms. " +
                      "<code>transcoder()</code> will revert until the next round.",
                  "warn"
              )
            : null,
        el(
            "div",
            {class: "kpis"},
            kpi("CURRENT ROUND", commas(r.currentRound), {
                sub: r.initialized ? "open" : "not initialized",
                helpText:
                    "Computed by dividing the block number by the round length. That part is automatic — but a " +
                    "round doesn't DO anything until initializeRound() is called.",
                source: "RoundsManager.sol:currentRound",
                accent: "time"
            }),
            kpi("BLOCK", commas(r.blockNum), {
                sub: `round started at ${commas(r.currentRoundStartBlock)}`,
                helpText:
                    "Locally this is a variable you can set, not a real chain height — the devnet deploys an " +
                    "AdjustableRoundsManager so you can skip time.",
                source: "AdjustableRoundsManager.sol:blockNum"
            }),
            kpi("BLOCKS LEFT", commas(r.blocksRemaining), {
                sub: `of ${commas(r.roundLength)} per round`,
                helpText: "How many blocks until the next round begins. Mine that many to cross the boundary."
            }),
            kpi("LAST INITIALIZED", commas(r.lastInitializedRound), {
                sub: r.locked ? "round locked" : "unlocked",
                helpText:
                    "The most recent round anyone opened. If this trails the current round, nobody has called " +
                    "initializeRound() yet."
            })
        ),
        el(
            "div",
            {class: "grid side"},
            card(
                "TIME TRAVEL",
                {sub: "local only", accent: "time"},
                el("p", {class: "action-blurb"}, "Skip forward, then open the new round. Both are needed — mining blocks alone doesn't start a round."),
                el(
                    "div",
                    {class: "btn-row", style: "margin-bottom:14px"},
                    mineBtn("+1 ROUND", roundLength, "Mine exactly one round's worth of blocks"),
                    mineBtn("+1 WEEK", roundLength * 7, "Seven rounds"),
                    mineBtn("+1 MONTH", roundLength * 30, "Thirty rounds"),
                    mineBtn("+1 BLOCK", 1, "A single block")
                ),
                el("div", {class: "btn-row"}, initBtn, el("span", {class: "dim mono", style: "font-size:10px", text: r.initialized ? "already open for this round" : "opens the round"})),
                el("hr", {class: "rule"}),
                el(
                    "div",
                    {},
                    el(
                        "h4",
                        {style: "font-size:14px;font-weight:700;margin-bottom:3px"},
                        "Auto-run",
                        help(
                            "Loops mine → initializeRound → reward for every active orchestrator, as fast as the " +
                                "chain will go. This is how you build up enough history for the charts to be " +
                                "interesting, and how you'd answer a question like 'what do returns look like over a year?'",
                            "actions.js:autoRun"
                        )
                    ),
                    el("p", {class: "action-blurb"}, "Advance many rounds at once, calling reward each time."),
                    el(
                        "div",
                        {class: "fields"},
                        el(
                            "div",
                            {class: "field"},
                            el("label", {}, "ROUNDS"),
                            roundsInput,
                            el("div", {class: "conv", text: "365 ≈ one year of protocol time"})
                        ),
                        el(
                            "div",
                            {class: "field"},
                            el("label", {}, "CALL REWARD"),
                            el("div", {style: "padding-top:6px"}, rewardChk, el("span", {class: "dim", style: "margin-left:6px;font-size:12px"}, "for every active orchestrator"))
                        )
                    ),
                    el("div", {class: "btn-row"}, autoBtn)
                )
            ),
            card("RAW CALLS", {sub: "the same thing, unwrapped", accent: "time"}, ...actions)
        )
    )
}
