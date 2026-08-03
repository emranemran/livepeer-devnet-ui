// DOM helpers, tooltips, toasts, and the catalog-driven form renderer.

import {percent, fromWei, shortAddr} from "./format.js"

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue
        if (k === "class") node.className = v
        else if (k === "html") node.innerHTML = v
        else if (k === "text") node.textContent = v
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v)
        else if (k === "dataset") Object.assign(node.dataset, v)
        else node.setAttribute(k, v)
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue
        node.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return node
}

export const $ = sel => document.querySelector(sel)
export const clear = node => {
    while (node.firstChild) node.removeChild(node.firstChild)
    return node
}

// ── tooltips ────────────────────────────────────────────────────────────────

const tip = () => document.getElementById("tooltip")

export function help(text, source) {
    const dot = el("span", {class: "help-dot", tabindex: "0", "aria-label": "explain"}, "?")
    const show = ev => {
        const t = tip()
        t.innerHTML = ""
        t.append(document.createTextNode(text))
        if (source) t.append(el("span", {class: "src", text: source}))
        t.classList.add("show")
        const r = dot.getBoundingClientRect()
        const tw = Math.min(330, window.innerWidth - 24)
        t.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - tw - 12))}px`
        t.style.top = `${r.bottom + 8}px`
        // Flip above if it would run off the bottom.
        requestAnimationFrame(() => {
            const th = t.getBoundingClientRect().height
            if (r.bottom + 8 + th > window.innerHeight - 8) {
                t.style.top = `${Math.max(8, r.top - th - 8)}px`
            }
        })
    }
    const hide = () => tip().classList.remove("show")
    dot.addEventListener("mouseenter", show)
    dot.addEventListener("focus", show)
    dot.addEventListener("mouseleave", hide)
    dot.addEventListener("blur", hide)
    return dot
}

// ── toasts ──────────────────────────────────────────────────────────────────

export function toast(message, {kind = "", title = "", detail = "", ms = 7000} = {}) {
    const node = el(
        "div",
        {class: `toast ${kind}`},
        title ? el("b", {text: title}) : null,
        el("div", {text: message}),
        detail ? el("div", {class: "detail", text: detail}) : null
    )
    document.getElementById("toasts").append(node)
    setTimeout(() => node.remove(), ms)
    return node
}

// ── small building blocks ───────────────────────────────────────────────────

export function card(title, {sub, accent, headExtra} = {}, ...body) {
    const head = el("header", {}, el("h3", {text: title}))
    if (sub) head.append(el("span", {class: "sub", text: sub}))
    if (headExtra) head.append(headExtra)
    const node = el("div", {class: `card${accent ? " accent" : ""}`}, head, el("div", {class: "body"}, ...body))
    if (accent) node.style.setProperty("--accent", `var(--${accent})`)
    return node
}

export function kpi(label, value, {sub, helpText, source, accent} = {}) {
    const l = el("label", {}, label)
    if (helpText) l.append(help(helpText, source))
    const node = el("div", {class: `kpi${accent ? " accent" : ""}`}, l, el("b", {text: value}), sub ? el("div", {class: "sub", text: sub}) : null)
    if (accent) node.style.setProperty("--accent", `var(--${accent})`)
    return node
}

export function panelHead(eyebrow, title, sub, accent) {
    const node = el(
        "div",
        {class: "panel-head"},
        el("span", {class: "panel-eyebrow", text: eyebrow}),
        el("h2", {class: "panel-title", text: title}),
        el("p", {class: "panel-sub", text: sub})
    )
    if (accent) node.style.setProperty("--accent", `var(--${accent})`)
    return node
}

export function note(text, kind = "", accent) {
    const node = el("div", {class: `note ${kind}`, html: text})
    if (accent) node.style.setProperty("--accent", `var(--${accent})`)
    return node
}

// ── the catalog-driven action form ──────────────────────────────────────────

/**
 * Render one catalog action as a form. Every argument gets its unit conversion
 * shown live underneath, every label gets a tooltip, and the exact ethers call
 * is revealed on demand — the whole point being that you can always see what
 * command the button is standing in for.
 */
export function actionForm(action, ctx) {
    const values = {}
    const convNodes = {}

    const fields = el("div", {class: "fields"})

    for (const spec of action.args) {
        values[spec.name] = spec.default ?? ""

        const label = el("label", {}, spec.label)
        label.append(help(spec.help || "", action.source))

        let input
        if (spec.type === "address") {
            input = el("select", {})
            input.append(el("option", {value: "self", text: "— acting account —"}))
            for (const acct of ctx.accounts || []) {
                input.append(
                    el("option", {value: acct.address, text: `#${acct.index}  ${shortAddr(acct.address)}`})
                )
            }
            input.append(el("option", {value: "zero", text: "0x0 (zero address)"}))
            input.value = spec.default === "self" ? "self" : spec.default || "self"
        } else {
            input = el("input", {
                type: "text",
                spellcheck: "false",
                value: String(spec.default ?? ""),
                placeholder: spec.type === "lpt" ? "LPT" : spec.type === "eth" ? "ETH" : ""
            })
        }

        const conv = el("div", {class: "conv"})
        convNodes[spec.name] = conv

        const sync = () => {
            values[spec.name] = input.value
            conv.textContent = conversionFor(spec, input.value)
            updatePreview()
        }
        input.addEventListener("input", sync)
        input.addEventListener("change", sync)

        fields.append(el("div", {class: "field"}, label, input, conv))
        conv.textContent = conversionFor(spec, input.value)
    }

    const snippetPre = el("pre", {text: "…"})
    const reveal = el(
        "details",
        {class: "reveal"},
        el("summary", {text: "show me the command"}),
        snippetPre,
        el("div", {class: "why", text: action.help || ""})
    )

    let previewTimer = null
    function updatePreview() {
        clearTimeout(previewTimer)
        previewTimer = setTimeout(async () => {
            try {
                const res = await ctx.api.post("/api/preview", {
                    id: action.id,
                    args: values,
                    from: ctx.actingAs()
                })
                snippetPre.textContent = res.ok
                    ? res.snippet + (res.note ? `\n\n// ${res.note}` : "")
                    : `// ${res.error}`
            } catch (err) {
                snippetPre.textContent = `// ${err.message}`
            }
        }, 120)
    }
    updatePreview()

    const runBtn = el("button", {class: "btn accent", text: action.label.toUpperCase()})
    const status = el("span", {class: "dim mono", style: "font-size:10px"})

    runBtn.addEventListener("click", async () => {
        runBtn.disabled = true
        status.textContent = "sending…"
        try {
            const res = await ctx.api.post("/api/tx", {
                id: action.id,
                args: values,
                from: ctx.actingAs()
            })
            if (res.ok) {
                status.textContent = `ok · gas ${Number(res.gasUsed).toLocaleString()}`
                toast(describeDiff(res.diff) || `${action.label} succeeded.`, {
                    kind: "ok",
                    title: action.label,
                    detail: res.hash
                })
            } else {
                status.textContent = "reverted"
                toast(res.explanation || res.error, {
                    kind: "bad",
                    title: `${action.label} reverted`,
                    detail: res.explanation ? res.error : "",
                    ms: 12000
                })
            }
            ctx.refresh()
        } catch (err) {
            status.textContent = "failed"
            toast(err.message, {kind: "bad", title: action.label})
        } finally {
            runBtn.disabled = false
        }
    })

    const container = el(
        "div",
        {class: "action"},
        el(
            "div",
            {class: "action-head"},
            el("h4", {}, action.label),
            el("span", {class: "contract", text: `${action.contract}.${action.method}()`})
        ),
        el("p", {class: "action-blurb", text: action.blurb || ""}),
        action.args.length ? fields : null,
        el("div", {class: "btn-row"}, runBtn, status),
        reveal
    )

    if (action.sender === "owner") {
        container.querySelector(".action-blurb").append(
            el("span", {class: "tag", style: "margin-left:6px", text: "OWNER ONLY"})
        )
    }

    return container
}

function conversionFor(spec, raw) {
    if (raw === "" || raw === undefined || raw === null) return ""
    switch (spec.type) {
        case "perc": {
            try {
                return `${percent(raw, spec.divisor)}  ·  raw ${raw} over ${shortDivisor(spec.divisor)}`
            } catch (err) {
                return ""
            }
        }
        case "lpt":
            return `${raw} LPT`
        case "eth":
            return `${raw} ETH`
        case "uint":
            return ""
        default:
            return ""
    }
}

function shortDivisor(d) {
    const s = String(d)
    if (s === "1000000") return "1e6"
    if (s === "1000000000") return "1e9"
    if (s.length === 28) return "1e27"
    return s
}

/** Turn a raw state diff into a sentence a human would say. */
export function describeDiff(diff) {
    if (!diff) return ""
    const parts = []
    const sign = v => (String(v).startsWith("-") ? "" : "+")

    if (diff.transcoderTotalStake) {
        parts.push(`stake ${sign(diff.transcoderTotalStake)}${fromWei(diff.transcoderTotalStake, 7)} LPT`)
    } else if (diff.pendingStake) {
        parts.push(`pending stake ${sign(diff.pendingStake)}${fromWei(diff.pendingStake, 7)} LPT`)
    }
    if (diff.lpt) parts.push(`wallet ${sign(diff.lpt)}${fromWei(diff.lpt, 4)} LPT`)
    if (diff.pendingFees) parts.push(`fees ${sign(diff.pendingFees)}${fromWei(diff.pendingFees, 6)} ETH`)
    if (diff.totalBonded) parts.push(`total bonded ${sign(diff.totalBonded)}${fromWei(diff.totalBonded, 4)} LPT`)

    return parts.join(" · ")
}
