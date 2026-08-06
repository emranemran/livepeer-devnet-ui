"use strict"

const http = require("http")

const {emit} = require("./bus")

/**
 * A tiny JSON-RPC shim that sits between go-livepeer and hardhat.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Ethereum JSON-RPC spec renamed the call-data field on eth_call and
 * friends from `data` to `input`. Modern go-ethereum — which go-livepeer is
 * built on — sends `input`. Hardhat 2.8.3, which this protocol repo pins and
 * which dates from 2022, only reads `data`.
 *
 * The failure is silent and deeply confusing: hardhat receives the request,
 * finds no calldata where it expects it, and reports
 *
 *     Transaction reverted: function selector was not recognized
 *     and there's no fallback nor receive function
 *
 * …which reads like an ABI mismatch and sends you hunting through contract
 * versions. It isn't. The selector is correct and in the payload, just under
 * the other key.
 *
 * So: copy `input` into `data` (keeping both, since newer nodes prefer `input`)
 * and forward everything else untouched. The alternative would be upgrading
 * hardhat in the protocol repo, which is a much larger change to somebody
 * else's project.
 */

const CALLDATA_METHODS = new Set([
    "eth_call",
    "eth_estimateGas",
    "eth_sendTransaction",
    "eth_createAccessList"
])

function normalize(payload) {
    let touched = 0
    const fix = msg => {
        if (!msg || !CALLDATA_METHODS.has(msg.method)) return
        const tx = Array.isArray(msg.params) ? msg.params[0] : null
        if (tx && typeof tx === "object" && tx.input && !tx.data) {
            tx.data = tx.input
            touched += 1
        }
    }
    if (Array.isArray(payload)) payload.forEach(fix)
    else fix(payload)
    return touched
}

function createShim(config) {
    const target = new URL(config.rpcUrl)
    let server = null
    let translated = 0
    const port = config.rpcShimPort || 8546

    function start() {
        if (server) return Promise.resolve({alreadyRunning: true, port})

        return new Promise((resolve, reject) => {
            server = http.createServer((req, res) => {
                let body = ""
                req.on("data", chunk => {
                    body += chunk
                    if (body.length > 8e6) req.destroy()
                })
                req.on("end", () => {
                    let out = body
                    try {
                        const parsed = JSON.parse(body)
                        const n = normalize(parsed)
                        if (n) {
                            translated += n
                            out = JSON.stringify(parsed)
                        }
                    } catch (err) {
                        /* not JSON — pass it through untouched */
                    }

                    const upstream = http.request(
                        {
                            host: target.hostname,
                            port: target.port || 80,
                            path: target.pathname || "/",
                            method: req.method,
                            headers: {
                                "content-type": "application/json",
                                "content-length": Buffer.byteLength(out)
                            }
                        },
                        up => {
                            res.writeHead(up.statusCode, {"content-type": "application/json"})
                            up.pipe(res)
                        }
                    )
                    upstream.on("error", err => {
                        res.writeHead(502, {"content-type": "application/json"})
                        res.end(JSON.stringify({jsonrpc: "2.0", error: {code: -32603, message: err.message}}))
                    })
                    upstream.end(out)
                })
            })

            server.on("error", err => {
                server = null
                reject(err)
            })

            // 0.0.0.0 so containers can reach it through the host gateway.
            server.listen(port, "0.0.0.0", () => {
                emit("notice", {
                    message: `RPC shim listening on :${port} — translating go-ethereum's "input" field to the "data" field hardhat 2.8.3 expects.`
                })
                resolve({port})
            })
        })
    }

    function stop() {
        if (server) {
            server.close()
            server = null
        }
    }

    return {
        start,
        stop,
        port,
        get translated() {
            return translated
        },
        get running() {
            return Boolean(server)
        }
    }
}

module.exports = {createShim, normalize}
