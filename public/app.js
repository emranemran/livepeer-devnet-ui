import store, {connectEvents} from "./lib/state.js"
import {el, $, clear, toast} from "./lib/ui.js"
import {fromWei, shortAddr, relTime, commas} from "./lib/format.js"

import setupPanel from "./panels/setup.js"
import timePanel from "./panels/time.js"
import stakePanel from "./panels/stake.js"
import paymentsPanel from "./panels/payments.js"
import knobsPanel from "./panels/knobs.js"
import accountsPanel from "./panels/accounts.js"
import rolesPanel from "./panels/roles.js"

const PANELS = {
    setup: setupPanel,
    time: timePanel,
    stake: stakePanel,
    payments: paymentsPanel,
    knobs: knobsPanel,
    accounts: accountsPanel,
    roles: rolesPanel
}

const ctx = {
    api: store.api,
    store,
    actingAs: () => store.acting(),
    get accounts() {
        return store.accounts
    },
    refresh: () => store.refresh()
}

// ── status bar ──────────────────────────────────────────────────────────────

function chip(id, on, label, {warn = false} = {}) {
    const node = document.getElementById(id)
    node.className = `chip ${on === null ? "" : on ? "ok" : warn ? "warn" : "bad"}`
    node.querySelector("span").textContent = label
}

function renderStatus() {
    const s = store.state
    if (!s) return

    chip("chip-chain", s.chain.up, s.chain.up ? "CHAIN UP" : "CHAIN DOWN")

    if (s.stale) {
        chip("chip-deploy", false, "STALE ADDRESSES", {warn: true})
    } else {
        chip("chip-deploy", s.deployed, s.deployed ? (s.dummies ? "PROTOCOL READY" : "STUB MISSING") : "NOT DEPLOYED", {
            warn: s.deployed && !s.dummies
        })
        if (s.deployed && !s.dummies) chip("chip-deploy", false, "STUB MISSING", {warn: true})
    }

    if (s.paused === null) chip("chip-paused", null, "PAUSE ?")
    else chip("chip-paused", !s.paused, s.paused ? "PAUSED" : "LIVE")

    // The protocol clock, not the chain's own height — rounds derive from this,
    // and locally it runs far ahead because you can fast-forward it.
    $("#stat-block").textContent = s.round
        ? commas(s.round.blockNum)
        : s.blockNumber === null
          ? "—"
          : commas(s.blockNumber)
    $("#stat-round").textContent = s.round ? commas(s.round.currentRound) : "—"
    $("#stat-progress").style.width = `${s.round ? s.round.progress : 0}%`

    const acct = store.actingAccount()
    $("#stat-eth").textContent = acct ? fromWei(acct.eth, 2) : "—"
    $("#stat-lpt").textContent = acct ? fromWei(acct.lpt, 2) : "—"

    renderAccountPicker()
}

function renderAccountPicker() {
    const sel = $("#acting-as")
    const current = store.acting()
    const wanted = store.accounts.map(a => `${a.index}`).join(",")
    if (sel.dataset.sig !== wanted) {
        clear(sel)
        for (const a of store.accounts) {
            sel.append(el("option", {value: a.address, text: `#${a.index}  ${shortAddr(a.address)}`}))
        }
        sel.dataset.sig = wanted
    }
    if (current) sel.value = current
}

$("#acting-as").addEventListener("change", ev => {
    store.actingAs = ev.target.value
    store.emitChange()
})

// ── router ──────────────────────────────────────────────────────────────────

function show(panel) {
    store.panel = panel
    for (const btn of document.querySelectorAll(".rail-btn[data-panel]")) {
        btn.classList.toggle("active", btn.dataset.panel === panel)
    }
    render()
}

for (const btn of document.querySelectorAll(".rail-btn[data-panel]")) {
    btn.addEventListener("click", () => show(btn.dataset.panel))
}

document.addEventListener("keydown", ev => {
    if (ev.target.matches("input, select, textarea")) return
    const keys = {1: "setup", 2: "time", 3: "stake", 4: "payments", 5: "knobs", 6: "accounts", 7: "roles"}
    if (keys[ev.key]) show(keys[ev.key])
})

let rendering = false
function render() {
    if (rendering) return
    rendering = true
    requestAnimationFrame(() => {
        rendering = false
        const main = $("#main")
        const scroll = main.scrollTop
        try {
            clear(main).append(PANELS[store.panel](store, ctx))
            main.scrollTop = scroll
        } catch (err) {
            clear(main).append(
                el("div", {class: "note bad", html: `<b>Panel error:</b> ${err.message}`}),
                el("pre", {class: "mono", text: err.stack || ""})
            )
        }
    })
}

store.onChange(() => {
    renderStatus()
    render()
})

// ── event tape ──────────────────────────────────────────────────────────────

const tapeLines = $("#tape-lines")
let tapeCount = 0

function pushTape(ev) {
    let kind = ev.type
    let source = ev.source || ev.type
    let msg = ""

    if (ev.type === "log") {
        msg = ev.line
    } else if (ev.type === "tx") {
        kind = ev.status === "ok" ? "tx ok" : "tx bad"
        source = "tx"
        const bits = [ev.label]
        if (ev.status === "ok") {
            if (ev.diff && Object.keys(ev.diff).length) {
                if (ev.diff.transcoderTotalStake) {
                    bits.push(`stake +${fromWei(ev.diff.transcoderTotalStake, 7)} LPT`)
                } else if (ev.diff.lpt) {
                    bits.push(`wallet ${fromWei(ev.diff.lpt, 4)} LPT`)
                }
            }
            if (ev.hash) bits.push(shortAddr(ev.hash))
            if (ev.gasUsed) bits.push(`gas ${commas(ev.gasUsed)}`)
            bits.push("✓")
        } else {
            bits.push(`✗ ${ev.explanation || ev.message}`)
        }
        msg = bits.join("  ·  ")
    } else if (ev.type === "lifecycle") {
        source = ev.step
        kind = ev.status === "error" ? "bad" : ev.status === "done" || ev.status === "ready" ? "ok" : "notice"
        msg = `${ev.status.toUpperCase()}${ev.command ? `  ${ev.command}` : ""}${ev.message ? `  ${ev.message}` : ""}`
    } else if (ev.type === "notice") {
        kind = ev.level === "error" ? "bad" : "notice"
        msg = ev.message
    } else if (ev.type === "progress") {
        source = ev.job
        kind = "notice"
        msg = `${ev.index}/${ev.total}  ${ev.message}`
    } else if (ev.type === "series") {
        return
    }

    if (!msg) return

    tapeLines.append(
        el(
            "div",
            {class: `tl ${kind}`},
            el("time", {text: relTime(ev.at)}),
            el("span", {class: "src", text: source}),
            el("span", {class: "msg", text: msg})
        )
    )
    tapeCount += 1
    while (tapeLines.children.length > 400) tapeLines.firstChild.remove()
    tapeLines.scrollTop = tapeLines.scrollHeight
}

$("#tape-clear").addEventListener("click", () => clear(tapeLines))
$("#tape-toggle").addEventListener("click", ev => {
    const tape = $("#tape")
    tape.classList.toggle("collapsed")
    ev.target.textContent = tape.classList.contains("collapsed") ? "SHOW" : "HIDE"
})

// ── guided tour ─────────────────────────────────────────────────────────────

const TOUR = [
    ["setup", "Start here. Four steps take you from nothing to a running protocol — each button shows the exact command it stands in for."],
    ["accounts", "You control all 250 accounts. Send LPT from account #0 to a few others so they can act as delegators."],
    ["stake", "Bond LPT to yourself, then register as an orchestrator with a reward cut and fee share."],
    ["time", "Advance a round. The active set is frozen when a round opens, so you only join from the NEXT one."],
    ["stake", "Now call reward. Watch your stake grow — that is inflation being minted and split."],
    ["knobs", "Change something. Drop the active set size, or move the target bonding rate and watch inflation react."]
]

let tourStep = -1
$("#btn-tour").addEventListener("click", () => {
    tourStep = (tourStep + 1) % TOUR.length
    const [panel, text] = TOUR[tourStep]
    show(panel)
    toast(text, {title: `GUIDED TOUR ${tourStep + 1}/${TOUR.length}`, ms: 13000})
})

// ── boot ────────────────────────────────────────────────────────────────────

async function boot() {
    store.onEvent(ev => {
        pushTape(ev)
        // Anything that changes chain state should refresh the view.
        if (ev.type === "lifecycle" && ["done", "ready", "stopped", "error"].includes(ev.status)) {
            store.refresh().catch(() => {})
        }
        if (ev.type === "series") store.refreshSeries().then(() => store.emitChange())
    })
    connectEvents()

    await store.loadCommands()
    await store.refresh()
    show("setup")

    // Cheap poll so block/round stay honest even when nothing is happening.
    setInterval(() => {
        store.refresh({series: false}).catch(() => {})
    }, 5000)
}

boot().catch(err => {
    clear($("#main")).append(
        el("div", {class: "note bad", html: `<b>Could not reach the server.</b> ${err.message}`})
    )
})
