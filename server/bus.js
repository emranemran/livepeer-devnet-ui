"use strict"

const {EventEmitter} = require("events")

// One process-wide event bus. Everything the UI needs to hear about — child
// process output, transaction results, state changes — is emitted here and
// fanned out to browsers over SSE by index.js.
const bus = new EventEmitter()
bus.setMaxListeners(0)

let seq = 0

/**
 * Emit an event to every connected browser.
 * @param {string} type  "log" | "tx" | "state" | "lifecycle" | "progress" | "notice"
 * @param {object} payload
 */
function emit(type, payload) {
    seq += 1
    bus.emit("event", {
        seq,
        type,
        at: new Date().toISOString(),
        ...payload
    })
}

// A rolling buffer so a browser that connects late still sees recent history.
const history = []
const HISTORY_LIMIT = 500

bus.on("event", ev => {
    history.push(ev)
    if (history.length > HISTORY_LIMIT) history.shift()
})

module.exports = {bus, emit, history}
