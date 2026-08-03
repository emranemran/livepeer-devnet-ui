// Hand-rolled SVG charts. No chart library.
//
// Colour policy: the UI's editorial accents (teal/rust/olive/purple/amber) are
// chrome only — borders, rails, headers. Data series use the validated
// categorical palette below, which passes the lightness, chroma, CVD-separation
// and normal-vision gates on a light surface.
//
// Three slots (aqua, yellow, magenta) fall below 3:1 contrast against the
// surface, so every chart here ships the required relief: direct value labels on
// marks, plus a table view of the same numbers elsewhere on the panel.

import {el} from "./ui.js"

export const SERIES = [
    "#2a78d6", // 1 blue
    "#eb6834", // 2 orange
    "#1baf7a", // 3 aqua
    "#eda100", // 4 yellow
    "#e87ba4", // 5 magenta
    "#008300" // 6 green
]
export const OTHER = "#8a877e"

const INK = "#14150f"
const INK_2 = "#3d3b34"
const MUTED = "#86837a"
const GRID = "#ececE6"
const AXIS = "#d3cfc6"
const SURFACE = "#ffffff"

const SVG_NS = "http://www.w3.org/2000/svg"

function svgEl(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue
        node.setAttribute(k, String(v))
    }
    return node
}

function niceTicks(min, max, count = 4) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1]
    if (min === max) {
        const pad = Math.abs(min) || 1
        min -= pad * 0.5
        max += pad * 0.5
    }
    const span = max - min
    const raw = span / count
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const norm = raw / mag
    const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
    const start = Math.floor(min / step) * step
    const out = []
    for (let v = start; v <= max + step * 0.5; v += step) out.push(v)
    return out
}

function fmtTick(v) {
    const a = Math.abs(v)
    if (a >= 1e9) return `${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`
    if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
    if (a >= 1) return v.toFixed(a >= 100 ? 0 : 2).replace(/\.00$/, "")
    if (a === 0) return "0"
    return v.toPrecision(3)
}

function emptyState(message) {
    return el("div", {class: "chart-empty", text: message})
}

/**
 * Multi-series line chart with a crosshair tooltip.
 *
 * @param series  [{ name, color, points: [{x, y}] }]
 * @param opts    { yLabel, xLabel, height, format, reference: {y, label}, empty }
 */
export function lineChart(series, opts = {}) {
    const {
        height = 210,
        width = 720,
        format = fmtTick,
        yLabel = "",
        xLabel = "ROUND",
        reference = null,
        empty = "No data yet — advance some rounds on the TIME panel."
    } = opts

    const live = (series || []).filter(s => s.points && s.points.length)
    if (!live.length) return emptyState(empty)

    const pad = {t: 14, r: 62, b: 26, l: 54}
    const W = width
    const H = height

    const xs = live.flatMap(s => s.points.map(p => p.x))
    const ys = live.flatMap(s => s.points.map(p => p.y))
    if (reference && isFinite(reference.y)) ys.push(reference.y)

    const xMin = Math.min(...xs)
    const xMax = Math.max(...xs)

    // Lines track change over time, so the y-axis follows the data rather than
    // being pinned to zero — a 2% move on a 2,500 LPT stake is the whole story
    // and a zero baseline flattens it into a straight line. (Bars stay anchored
    // at zero, where the baseline carries meaning.)
    const dataMin = Math.min(...ys)
    const dataMax = Math.max(...ys)
    const flat = dataMin === dataMax
    // A series that is entirely zero should sit on a 0-baseline axis, not be
    // centred in a ±1 window that implies negative values are possible.
    const headroom = flat
        ? Math.abs(dataMax) * 0.2 || 1
        : (dataMax - dataMin) * 0.12
    const yTicks = niceTicks(
        opts.zeroBase || (flat && dataMin >= 0) ? Math.min(0, dataMin) : dataMin - headroom,
        dataMax + headroom
    )
    const yMin = yTicks[0]
    const yMax = yTicks[yTicks.length - 1]

    const sx = x => (xMax === xMin ? pad.l : pad.l + ((x - xMin) / (xMax - xMin)) * (W - pad.l - pad.r))
    const sy = y => (yMax === yMin ? H - pad.b : H - pad.b - ((y - yMin) / (yMax - yMin)) * (H - pad.t - pad.b))

    const svg = svgEl("svg", {viewBox: `0 0 ${W} ${H}`, role: "img"})

    // Recessive grid + y axis labels
    for (const t of yTicks) {
        svg.append(
            svgEl("line", {x1: pad.l, x2: W - pad.r, y1: sy(t), y2: sy(t), stroke: GRID, "stroke-width": 1})
        )
        const label = svgEl("text", {
            x: pad.l - 8,
            y: sy(t) + 3.5,
            "text-anchor": "end",
            fill: MUTED,
            "font-size": 9.5,
            "font-family": "JetBrains Mono, monospace"
        })
        label.textContent = format(t)
        svg.append(label)
    }

    // x axis
    svg.append(svgEl("line", {x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, stroke: AXIS, "stroke-width": 1}))
    for (const x of [xMin, xMax]) {
        const t = svgEl("text", {
            x: sx(x),
            y: H - pad.b + 15,
            "text-anchor": x === xMin ? "start" : "end",
            fill: MUTED,
            "font-size": 9.5,
            "font-family": "JetBrains Mono, monospace"
        })
        t.textContent = `${xLabel} ${x}`
        svg.append(t)
    }

    // reference / threshold line — muted ink, labelled, never a series colour
    if (reference && isFinite(reference.y) && reference.y >= yMin && reference.y <= yMax) {
        svg.append(
            svgEl("line", {
                x1: pad.l,
                x2: W - pad.r,
                y1: sy(reference.y),
                y2: sy(reference.y),
                stroke: INK_2,
                "stroke-width": 1.5,
                "stroke-dasharray": "5 4"
            })
        )
        const rl = svgEl("text", {
            x: W - pad.r + 5,
            y: sy(reference.y) + 3.5,
            fill: INK_2,
            "font-size": 9.5,
            "font-family": "JetBrains Mono, monospace"
        })
        rl.textContent = reference.label || "target"
        svg.append(rl)
    }

    // series
    live.forEach((s, i) => {
        const color = s.color || SERIES[i % SERIES.length]
        const d = s.points
            .slice()
            .sort((a, b) => a.x - b.x)
            .map((p, idx) => `${idx === 0 ? "M" : "L"}${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`)
            .join(" ")

        svg.append(
            svgEl("path", {
                d,
                fill: "none",
                stroke: color,
                "stroke-width": 2,
                "stroke-linecap": "round",
                "stroke-linejoin": "round"
            })
        )

        // Direct label on the last point — this is the relief that lets the
        // lower-contrast slots ship, and it removes a legend lookup.
        if (live.length <= 4) {
            const last = s.points[s.points.length - 1]
            const t = svgEl("text", {
                x: Math.min(sx(last.x) + 7, W - pad.r + 4),
                y: sy(last.y) + 3.5,
                fill: INK_2,
                "font-size": 9.5,
                "font-weight": 600,
                "font-family": "JetBrains Mono, monospace"
            })
            t.textContent = format(last.y)
            svg.append(t)
        }
    })

    // ── hover layer: crosshair + tooltip ────────────────────────────────────
    const crosshair = svgEl("line", {
        y1: pad.t,
        y2: H - pad.b,
        stroke: INK,
        "stroke-width": 1,
        "stroke-dasharray": "3 3",
        opacity: 0
    })
    svg.append(crosshair)

    const dots = live.map((s, i) => {
        const dot = svgEl("circle", {
            r: 4.5,
            fill: s.color || SERIES[i % SERIES.length],
            stroke: SURFACE,
            "stroke-width": 2,
            opacity: 0
        })
        svg.append(dot)
        return dot
    })

    const wrap = el("div", {class: "chart-wrap", style: "position:relative"})
    const tip = el("div", {
        style:
            "position:absolute;pointer-events:none;opacity:0;background:#14150f;color:#f4f1e8;" +
            "font-family:'JetBrains Mono',monospace;font-size:11px;padding:7px 9px;border-radius:3px;" +
            "white-space:nowrap;z-index:5;transition:opacity .08s;box-shadow:0 6px 20px -8px rgba(0,0,0,.5)"
    })

    const hit = svgEl("rect", {
        x: pad.l,
        y: pad.t,
        width: Math.max(1, W - pad.l - pad.r),
        height: Math.max(1, H - pad.t - pad.b),
        fill: "transparent"
    })
    svg.append(hit)

    function move(ev) {
        const rect = svg.getBoundingClientRect()
        const scale = W / rect.width
        const px = (ev.clientX - rect.left) * scale
        const xValue = xMax === xMin ? xMin : xMin + ((px - pad.l) / (W - pad.l - pad.r)) * (xMax - xMin)

        const lines = []
        let anyY = null
        live.forEach((s, i) => {
            let best = null
            for (const p of s.points) {
                if (!best || Math.abs(p.x - xValue) < Math.abs(best.x - xValue)) best = p
            }
            if (!best) return
            dots[i].setAttribute("cx", sx(best.x))
            dots[i].setAttribute("cy", sy(best.y))
            dots[i].setAttribute("opacity", 1)
            lines.push(`${s.name}: ${format(best.y)}`)
            if (anyY === null) anyY = best
        })
        if (!anyY) return

        crosshair.setAttribute("x1", sx(anyY.x))
        crosshair.setAttribute("x2", sx(anyY.x))
        crosshair.setAttribute("opacity", 0.4)

        tip.innerHTML = `<b>${xLabel} ${anyY.x}</b><br>${lines.join("<br>")}`
        tip.style.opacity = 1
        const leftPct = (sx(anyY.x) / W) * 100
        tip.style.left = `${leftPct > 62 ? leftPct - 3 : leftPct + 3}%`
        tip.style.transform = leftPct > 62 ? "translateX(-100%)" : "none"
        tip.style.top = "6px"
    }

    function leave() {
        crosshair.setAttribute("opacity", 0)
        for (const d of dots) d.setAttribute("opacity", 0)
        tip.style.opacity = 0
    }

    svg.addEventListener("mousemove", move)
    svg.addEventListener("mouseleave", leave)

    wrap.append(svg, tip)

    // Legend is always present for two or more series.
    if (live.length >= 2) {
        const legend = el("div", {class: "chart-legend"})
        live.forEach((s, i) => {
            const swatch = el("i")
            swatch.style.background = s.color || SERIES[i % SERIES.length]
            legend.append(el("span", {}, swatch, s.name))
        })
        wrap.append(legend)
    }

    if (yLabel) {
        wrap.append(
            el("div", {
                class: "dim mono",
                style: "font-size:9.5px;letter-spacing:.1em;padding:2px 10px 0",
                text: yLabel
            })
        )
    }

    return wrap
}

/**
 * Horizontal bars. Values are labelled directly on every bar, which is both the
 * contrast relief and simply easier to read than an axis lookup.
 */
export function barChart(items, opts = {}) {
    const {format = fmtTick, empty = "Nothing to chart yet.", width = 720, rowHeight = 26} = opts
    const live = (items || []).filter(d => isFinite(d.value))
    if (!live.length) return emptyState(empty)

    const pad = {t: 6, r: 88, b: 6, l: 128}
    const H = pad.t + pad.b + live.length * rowHeight
    const W = width
    const max = Math.max(...live.map(d => d.value), 1)
    const barH = Math.min(16, rowHeight - 10)

    const svg = svgEl("svg", {viewBox: `0 0 ${W} ${H}`, role: "img"})

    live.forEach((d, i) => {
        // A 2px surface gap between adjacent bars comes from rowHeight > barH.
        const y = pad.t + i * rowHeight + (rowHeight - barH) / 2
        const w = Math.max(2, ((W - pad.l - pad.r) * d.value) / max)
        const color = d.color || SERIES[i % SERIES.length]

        const label = svgEl("text", {
            x: pad.l - 9,
            y: y + barH / 2 + 3.5,
            "text-anchor": "end",
            fill: INK_2,
            "font-size": 10,
            "font-family": "JetBrains Mono, monospace"
        })
        label.textContent = d.label
        svg.append(label)

        // 4px rounded data-end, anchored flat to the baseline.
        const bar = svgEl("path", {
            d: roundedRightRect(pad.l, y, w, barH, 4),
            fill: color
        })
        const title = svgEl("title")
        title.textContent = `${d.label}: ${format(d.value)}${d.note ? ` · ${d.note}` : ""}`
        bar.append(title)
        svg.append(bar)

        const value = svgEl("text", {
            x: pad.l + w + 7,
            y: y + barH / 2 + 3.5,
            fill: INK,
            "font-size": 10,
            "font-weight": 600,
            "font-family": "JetBrains Mono, monospace"
        })
        value.textContent = format(d.value)
        svg.append(value)
    })

    return el("div", {class: "chart-wrap"}, svg)
}

function roundedRightRect(x, y, w, h, r) {
    const rr = Math.min(r, w, h / 2)
    return [
        `M${x},${y}`,
        `H${x + w - rr}`,
        `Q${x + w},${y} ${x + w},${y + rr}`,
        `V${y + h - rr}`,
        `Q${x + w},${y + h} ${x + w - rr},${y + h}`,
        `H${x}`,
        "Z"
    ].join(" ")
}

/**
 * A stable colour per orchestrator. Colour follows the entity, not its rank —
 * filtering or re-sorting must never repaint the survivors.
 */
export function colorMap(addresses) {
    const map = new Map()
    addresses.forEach((addr, i) => {
        map.set(addr.toLowerCase(), i < SERIES.length ? SERIES[i] : OTHER)
    })
    return map
}

export {fmtTick}
