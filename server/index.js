"use strict"

const http = require("http")
const fs = require("fs")
const path = require("path")

const {bus, emit, history} = require("./bus")
const {createProcesses} = require("./processes")
const {createChain} = require("./chain")
const {createNodes} = require("./nodes")

const ROOT = path.resolve(__dirname, "..")
const PUBLIC = path.join(ROOT, "public")

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"))
const processes = createProcesses(config)
const chain = createChain(config, processes)

const nodes = createNodes(config, chain)
const actions = require("./actions")({config, chain, processes})

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
}

function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store"
    })
    res.end(payload)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = ""
        req.on("data", chunk => {
            data += chunk
            if (data.length > 1e6) {
                reject(new Error("Request body too large"))
                req.destroy()
            }
        })
        req.on("end", () => {
            if (!data) return resolve({})
            try {
                resolve(JSON.parse(data))
            } catch (err) {
                reject(new Error("Body was not valid JSON"))
            }
        })
        req.on("error", reject)
    })
}

function serveStatic(req, res, pathname) {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const file = path.join(PUBLIC, rel)

    // Never serve anything outside public/.
    if (!file.startsWith(PUBLIC)) {
        res.writeHead(403).end("Forbidden")
        return
    }
    fs.readFile(file, (err, buf) => {
        if (err) {
            res.writeHead(404, {"content-type": "text/plain"}).end("Not found")
            return
        }
        res.writeHead(200, {
            "content-type": MIME[path.extname(file)] || "application/octet-stream",
            "cache-control": "no-store"
        })
        res.end(buf)
    })
}

function serveEvents(req, res) {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no"
    })
    res.write("retry: 1000\n\n")

    // Replay recent history so a page reload doesn't lose the transcript.
    for (const ev of history.slice(-120)) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }

    const onEvent = ev => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`)
    }
    bus.on("event", onEvent)

    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000)

    req.on("close", () => {
        clearInterval(keepAlive)
        bus.off("event", onEvent)
    })
}

const LIFECYCLE = {
    async start() {
        const result = await processes.startNode()
        chain.resetProvider()
        return result
    },
    async stop() {
        const result = await processes.stopNode()
        chain.resetProvider()
        return result
    },
    async deploy() {
        const result = await processes.run("deploy")
        chain.loadDeployments({force: true})
        return result
    },
    async dummies() {
        const result = await processes.run("dummies")
        chain.loadDeployments({force: true})
        return result
    },
    async unpause() {
        return processes.run("unpause")
    },
    /**
     * Full reset: stop the chain, delete the deployment records (they would
     * otherwise describe a world that no longer exists), start clean, and run
     * all three deploy steps.
     */
    async reset() {
        // force: true so an adopted chain gets stopped too — otherwise reset
        // would re-adopt the chain it was meant to throw away.
        await processes.stopNode({force: true})
        await processes.killPort()
        processes.clearDeployments()
        chain.resetProvider()
        actions.series.clear()
        await processes.startNode()
        chain.resetProvider()
        await processes.run("deploy")
        chain.loadDeployments({force: true})
        await processes.run("dummies")
        await processes.run("unpause")
        emit("notice", {message: "Reset complete — fresh chain, protocol deployed and unpaused."})
        return {ok: true}
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const {pathname} = url

    try {
        if (pathname === "/api/events" && req.method === "GET") {
            return serveEvents(req, res)
        }

        if (pathname === "/api/state" && req.method === "GET") {
            return sendJson(res, 200, await chain.snapshot())
        }

        if (pathname === "/api/commands" && req.method === "GET") {
            return sendJson(res, 200, {
                lifecycle: Object.fromEntries(
                    Object.entries(processes.COMMANDS).map(([id, c]) => [
                        id,
                        {label: c.label, display: c.display, why: c.why}
                    ])
                ),
                catalog: actions.catalogForClient()
            })
        }

        if (pathname.startsWith("/api/lifecycle/") && req.method === "POST") {
            const step = pathname.split("/").pop()
            const handler = LIFECYCLE[step]
            if (!handler) return sendJson(res, 404, {error: `Unknown lifecycle step "${step}"`})
            const result = await handler()
            return sendJson(res, 200, {ok: true, result})
        }

        if (pathname === "/api/accounts" && req.method === "GET") {
            const addresses = await chain.accounts()
            const limit = Number(url.searchParams.get("limit") || 25)
            return sendJson(res, 200, {
                total: addresses.length,
                accounts: await chain.balances(addresses.slice(0, limit))
            })
        }

        if (pathname === "/api/tx" && req.method === "POST") {
            const body = await readBody(req)
            return sendJson(res, 200, await actions.execute(body))
        }

        if (pathname === "/api/preview" && req.method === "POST") {
            const body = await readBody(req)
            return sendJson(res, 200, actions.preview(body))
        }

        if (pathname.startsWith("/api/time/") && req.method === "POST") {
            const op = pathname.split("/").pop()
            const body = await readBody(req)
            return sendJson(res, 200, await actions.time(op, body))
        }

        if (pathname.startsWith("/api/tickets/") && req.method === "POST") {
            const op = pathname.split("/").pop()
            const body = await readBody(req)
            return sendJson(res, 200, await actions.tickets(op, body))
        }

        if (pathname.startsWith("/api/series") && req.method === "GET") {
            return sendJson(res, 200, actions.series.all())
        }

        // ── real go-livepeer daemons ────────────────────────────────────────
        if (pathname === "/api/nodes" && req.method === "GET") {
            return sendJson(res, 200, await nodes.snapshot())
        }

        if (pathname === "/api/nodes/pull" && req.method === "POST") {
            await nodes.pullImage()
            return sendJson(res, 200, {ok: true})
        }

        if (pathname.startsWith("/api/nodes/") && req.method === "POST") {
            const [, , , role, op] = pathname.split("/")
            const body = await readBody(req)
            if (op === "start") return sendJson(res, 200, await nodes.start(role))
            if (op === "stop") return sendJson(res, 200, await nodes.stop(role))
            if (op === "fund") return sendJson(res, 200, await nodes.fund(role, body))
            return sendJson(res, 404, {error: `Unknown node operation "${op}"`})
        }

        if (pathname.startsWith("/api/")) {
            return sendJson(res, 404, {error: `No route for ${req.method} ${pathname}`})
        }

        return serveStatic(req, res, pathname)
    } catch (err) {
        emit("notice", {level: "error", message: err.message})
        return sendJson(res, 400, {error: err.message})
    }
})

server.on("error", err => {
    if (err.code === "EADDRINUSE") {
        console.error("")
        console.error(`  Port ${config.port} is already in use — another copy of this UI is probably running.`)
        console.error(`  Either open http://127.0.0.1:${config.port} , or stop it with:  lsof -ti:${config.port} | xargs kill`)
        console.error("")
        process.exit(1)
    }
    throw err
})

// Localhost only. This process spawns child processes and signs transactions
// for unlocked accounts; it must never be reachable from another machine.
server.listen(config.port, "127.0.0.1", () => {
    /* eslint-disable no-console */
    console.log("")
    console.log("  Livepeer Devnet Terminal")
    console.log(`  →  http://127.0.0.1:${config.port}`)
    console.log(`  protocol repo: ${processes.protocolDir}`)
    console.log("")
})

// The chain deliberately outlives this process. Restarting the UI shouldn't
// throw away an hour of experiment state — the next start adopts the running
// chain instead of colliding with it.
const shutdown = () => {
    if (processes.state.node.running && processes.state.node.pid) {
        console.log("")
        console.log(`  Leaving the chain running (pid ${processes.state.node.pid}).`)
        console.log(`  Restart this UI and it will adopt it, or stop it with:  kill ${processes.state.node.pid}`)
        console.log("")
    }
    process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
