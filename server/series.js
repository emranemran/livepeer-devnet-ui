"use strict"

const fs = require("fs")
const path = require("path")

const {emit} = require("./bus")

const DATA_DIR = path.resolve(__dirname, "..", "data")
const FILE = path.join(DATA_DIR, "series.json")

/**
 * A round-indexed history of protocol state, so the charts have something to
 * draw. Rounds only advance when you push a button, so sampling once per round
 * is exact rather than approximate.
 *
 * Persisted to disk so charts survive a UI restart — but wiped on chain reset,
 * because the data would otherwise describe a world that no longer exists.
 */
function createSeries(chain) {
    let points = []
    let lastRound = null

    function load() {
        try {
            if (fs.existsSync(FILE)) {
                points = JSON.parse(fs.readFileSync(FILE, "utf8"))
                lastRound = points.length ? points[points.length - 1].round : null
            }
        } catch (err) {
            points = []
        }
    }

    function persist() {
        try {
            fs.mkdirSync(DATA_DIR, {recursive: true})
            fs.writeFileSync(FILE, JSON.stringify(points))
        } catch (err) {
            /* charts are a nicety; never let persistence break a transaction */
        }
    }

    function clear() {
        points = []
        lastRound = null
        try {
            if (fs.existsSync(FILE)) fs.unlinkSync(FILE)
        } catch (err) {
            /* ignore */
        }
        emit("series", {cleared: true})
    }

    /**
     * Take a sample. Called after anything that could move the numbers; only
     * records a new point when the round has advanced, otherwise it updates the
     * current round's point in place so the latest state is always reflected.
     */
    async function sample({force = false} = {}) {
        if (!(await chain.deploymentsAreLive())) return null

        const [round, params, pool] = await Promise.all([
            chain.roundInfo(),
            chain.parameters(),
            chain.transcoderPool(25)
        ])
        if (!round) return null

        const point = {
            round: Number(round.currentRound),
            at: Date.now(),
            totalBonded: params.totalBonded || "0",
            totalSupply: params.totalSupply || "0",
            bondingRate: params.bondingRate || "0",
            inflation: params.inflation || "0",
            targetBondingRate: params.targetBondingRate || "0",
            currentMintableTokens: params.currentMintableTokens || "0",
            treasuryBalance: params.treasuryBalance || "0",
            treasuryBalanceCeiling: params.treasuryBalanceCeiling || "0",
            pool: pool.map(t => ({
                address: t.address,
                totalStake: t.totalStake,
                active: t.active
            }))
        }

        const existing = points.length ? points[points.length - 1] : null
        if (existing && existing.round === point.round && !force) {
            points[points.length - 1] = point
        } else {
            points.push(point)
            if (points.length > 2000) points.shift()
        }

        lastRound = point.round
        persist()
        emit("series", {round: point.round, points: points.length})
        return point
    }

    load()

    return {
        sample,
        clear,
        all: () => ({points, lastRound}),
        get length() {
            return points.length
        }
    }
}

module.exports = {createSeries}
