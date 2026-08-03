// Formatting helpers. The browser never loads ethers — everything numeric
// arrives as a decimal string and is handled with BigInt here.

const WEI = 10n ** 18n

export function toBig(v) {
    if (v === null || v === undefined || v === "") return 0n
    try {
        return BigInt(String(v).split(".")[0])
    } catch (err) {
        return 0n
    }
}

/** wei → human string, trimmed to `dp` decimals without floating point. */
export function fromWei(value, dp = 4) {
    const v = toBig(value)
    const neg = v < 0n
    const abs = neg ? -v : v
    const whole = abs / WEI
    const frac = abs % WEI

    let fracStr = frac.toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "")
    const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    return `${neg ? "-" : ""}${wholeStr}${fracStr ? "." + fracStr : ""}`
}

/** Same, but keeps enough precision to see a single reward call land. */
export function fromWeiPrecise(value) {
    return fromWei(value, 7)
}

export function commas(value) {
    if (value === null || value === undefined || value === "") return "—"
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export function shortAddr(a) {
    if (!a) return "—"
    return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/**
 * Percentages in these contracts are numerators over a divisor that differs by
 * contract — 1e6 in MathUtils, 1e9 in the Minter, 1e27 for the treasury cut.
 * Getting this wrong is the single most common mistake, so we always show both.
 */
export function percent(value, divisor, dp = 4) {
    const v = toBig(value)
    const d = toBig(divisor)
    if (d === 0n) return "—"
    if (v === 0n) return "0%"

    // Inflation is a few parts per billion, so a fixed 4dp renders it as a flat
    // "0%" and hides the number entirely. Extend precision until something
    // shows rather than lying about it being zero.
    let places = dp
    while (places < 12) {
        const scaled = (v * 10n ** BigInt(places + 2)) / d
        if (scaled > 0n) {
            const s = scaled.toString().padStart(places + 1, "0")
            const whole = s.slice(0, -places) || "0"
            const frac = places ? s.slice(-places).replace(/0+$/, "") : ""
            return `${whole}${frac ? "." + frac : ""}%`
        }
        places += 2
    }
    return "~0%"
}

export function toPercNumber(value, divisor) {
    const v = toBig(value)
    const d = toBig(divisor)
    if (d === 0n) return 0
    return Number((v * 1000000n) / d) / 10000
}

export function fromPercNumber(pct, divisor) {
    const d = toBig(divisor)
    const scaled = BigInt(Math.round(Number(pct) * 10000))
    return ((scaled * d) / 1000000n).toString()
}

export function relTime(iso) {
    const d = new Date(iso)
    return d.toLocaleTimeString([], {hour12: false})
}

export function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many || one + "s"}`
}
