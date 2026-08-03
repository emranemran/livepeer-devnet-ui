import {el, card, kpi, panelHead, note, help, toast} from "../lib/ui.js"
import {shortAddr} from "../lib/format.js"

/**
 * SETUP is the panel that explains the command line. Each of the four steps is
 * exactly one real command, shown verbatim, with the reason it exists.
 */
export default function setupPanel(store, ctx) {
    const s = store.state || {}
    const cmds = store.commands || {}

    const steps = [
        {
            id: "start",
            cmdKey: "node",
            title: "Start the local chain",
            done: s.chain && s.chain.up,
            active: !(s.chain && s.chain.up)
        },
        {
            id: "deploy",
            cmdKey: "deploy",
            title: "Deploy the protocol",
            done: Boolean(s.deployed),
            active: Boolean(s.chain && s.chain.up && !s.deployed)
        },
        {
            id: "dummies",
            cmdKey: "dummies",
            title: "Deploy the L2 stub",
            done: Boolean(s.dummies),
            active: Boolean(s.deployed && !s.dummies)
        },
        {
            id: "unpause",
            cmdKey: "unpause",
            title: "Unpause the protocol",
            done: s.paused === false,
            active: Boolean(s.deployed && s.paused === true)
        }
    ]

    const busy = s.chain && s.chain.busy

    async function runStep(id) {
        const label = id === "start" ? "Starting chain" : id
        toast(`Running: ${cmds[stepCmdKey(id)]?.display || id}`, {title: "COMMAND"})
        try {
            await ctx.api.post(`/api/lifecycle/${id}`, {})
            await ctx.refresh()
        } catch (err) {
            toast(err.message, {kind: "bad", title: `${label} failed`, ms: 14000})
        }
    }

    function stepCmdKey(id) {
        return {start: "node", deploy: "deploy", dummies: "dummies", unpause: "unpause"}[id]
    }

    const stepNodes = steps.map((step, i) => {
        const spec = cmds[step.cmdKey] || {}
        const btn = el("button", {
            class: `btn ${step.done ? "secondary" : "accent"}`,
            text: step.done ? "RE-RUN" : "RUN",
            disabled: Boolean(busy),
            onclick: () => runStep(step.id)
        })

        return el(
            "div",
            {class: `step ${step.done ? "done" : ""} ${step.active ? "active" : ""}`},
            el("div", {class: "step-num", text: step.done ? "✓" : String(i + 1)}),
            el(
                "div",
                {},
                el("h4", {}, step.title, help(spec.why || "", `processes.js`)),
                el("p", {text: spec.why || ""}),
                el("code", {class: "cmd", text: spec.display || ""})
            ),
            el("div", {}, el("div", {class: "btn-row"}, btn), el("div", {class: "step-state", text: step.done ? "DONE" : step.active ? "NEXT" : "WAITING"}))
        )
    })

    // ── warnings that actually matter ───────────────────────────────────────
    const warnings = []

    if (s.stale) {
        warnings.push(
            note(
                "<b>Stale deployment records.</b> The files in <code>deployments/localhost/</code> describe a chain " +
                    "that no longer exists — every address in them points at empty space. Hit <b>RESET EVERYTHING</b> " +
                    "below, or delete the folder and re-run steps 2–4.",
                "bad"
            )
        )
    }
    if (s.deployed && !s.dummies) {
        warnings.push(
            note(
                "<b>The L2 stub is missing.</b> <code>initializeRound()</code> will revert with " +
                    "<code>function call to a non-contract account</code> until you run step 3.",
                "warn"
            )
        )
    }
    if (s.deployed && s.paused) {
        warnings.push(
            note("<b>The protocol is paused.</b> Almost every call reverts until you run step 4.", "warn")
        )
    }
    if (s.chain && s.chain.up && s.deployed && s.dummies && s.paused === false) {
        warnings.push(
            note(
                "<b>Everything is up.</b> You have a working Livepeer on your laptop. Head to " +
                    "<b>ACCOUNTS</b> to fund some wallets, then <b>STAKE</b> to become an orchestrator.",
                "ok"
            )
        )
    }

    const resetBtn = el("button", {
        class: "btn danger",
        text: "RESET EVERYTHING",
        disabled: Boolean(busy),
        onclick: async () => {
            if (!confirm("Stop the chain, delete deployment records, and redeploy from scratch?")) return
            toast("Resetting — this takes about 20 seconds.", {title: "RESET"})
            try {
                await ctx.api.post("/api/lifecycle/reset", {})
                await ctx.refresh()
                toast("Fresh chain, protocol deployed and unpaused.", {kind: "ok", title: "RESET COMPLETE"})
            } catch (err) {
                toast(err.message, {kind: "bad", title: "Reset failed", ms: 14000})
            }
        }
    })

    const stopBtn = el("button", {
        class: "btn secondary",
        text: "STOP CHAIN",
        disabled: !(s.chain && s.chain.up),
        onclick: async () => {
            await ctx.api.post("/api/lifecycle/stop", {})
            await ctx.refresh()
        }
    })

    // ── deployed contract map ───────────────────────────────────────────────
    const contracts = Object.entries(s.contracts || {}).sort(([a], [b]) => a.localeCompare(b))
    const contractRows = contracts.length
        ? el(
              "div",
              {class: "table-wrap"},
              el(
                  "table",
                  {class: "data"},
                  el("thead", {}, el("tr", {}, el("th", {}, "CONTRACT"), el("th", {}, "ADDRESS"))),
                  el(
                      "tbody",
                      {},
                      ...contracts.map(([name, addr]) =>
                          el("tr", {}, el("td", {}, name), el("td", {class: "dim"}, addr))
                      )
                  )
              )
          )
        : el("div", {class: "empty"}, "Nothing deployed yet — run step 2.")

    return el(
        "div",
        {},
        panelHead(
            "SETUP · CHAIN LIFECYCLE",
            "Four commands stand between you and a working protocol.",
            "Each button below runs exactly one real command, shown verbatim. Watch the event tape at the bottom — " +
                "that is the same output you would see in a terminal.",
            "chain"
        ),
        ...warnings,
        el(
            "div",
            {class: "kpis"},
            kpi("CHAIN", s.chain && s.chain.up ? "UP" : "DOWN", {
                sub: s.chain ? s.chain.rpcUrl : "",
                helpText:
                    "A Node.js process pretending to be Ethereum, listening on port 8545. In memory only — " +
                    "stopping it erases every account balance, contract and transaction.",
                accent: "chain"
            }),
            kpi("CONTRACTS", String(contracts.length), {
                sub: s.deployed ? "deployed and live" : "not deployed",
                helpText:
                    "How many Livepeer contracts are on this chain. A full deploy is about 21, counting the " +
                    "swappable Target half of each proxied contract."
            }),
            kpi("PROTOCOL", s.paused === false ? "LIVE" : s.paused === true ? "PAUSED" : "—", {
                sub: s.dummies ? "stub registered" : "stub missing",
                helpText:
                    "The Controller has a global pause switch that starts ON after deployment — a safety " +
                    "mechanism so a real deployment can be inspected before anyone can use it."
            }),
            kpi("ACCOUNTS", store.accountTotal ? String(store.accountTotal) : "—", {
                sub: "each with 10,000 fake ETH",
                helpText:
                    "The devnet unlocks every account, so this UI can send transactions as any of them without " +
                    "handling a single private key. Their keys are publicly known — never send real money here."
            })
        ),
        el(
            "div",
            {class: "grid side"},
            card(
                "LIFECYCLE",
                {sub: "run top to bottom", accent: "chain"},
                ...stepNodes,
                el("hr", {class: "rule"}),
                el("div", {class: "btn-row"}, resetBtn, stopBtn),
                el("p", {
                    class: "dim",
                    style: "font-size:12px;margin-top:8px",
                    text:
                        "Reset stops the chain, deletes deployments/localhost, starts fresh and re-runs all three " +
                        "deploy steps. Use it whenever things stop making sense."
                })
            ),
            card("DEPLOYED ADDRESSES", {sub: `${contracts.length} entries`}, contractRows)
        )
    )
}
