"use strict"

const {spawn} = require("child_process")
const fs = require("fs")
const http = require("http")
const path = require("path")

const {emit} = require("./bus")

// Everything the SETUP panel can do maps to exactly one real command here, and
// the UI shows these strings verbatim. If you change a command, the "show me
// the command" text in the UI changes with it — that is the point.
const COMMANDS = {
    node: {
        label: "Start the local chain",
        cmd: "npx",
        // Bind 0.0.0.0, not the default 127.0.0.1: the go-livepeer containers
        // reach the chain through Docker's host gateway, and a loopback-only
        // listener isn't reachable from there.
        args: ["hardhat", "node", "--no-deploy", "--hostname", "0.0.0.0"],
        display: "npx hardhat node --no-deploy --hostname 0.0.0.0",
        why:
            "Starts a private Ethereum on your laptop at 127.0.0.1:8545 with 250 pre-funded accounts. " +
            "The --no-deploy flag is required: without it hardhat-deploy auto-runs every script in deploy/ " +
            "at startup and one of them assumes a Controller already exists, so the node dies with HH604.",
        longRunning: true
    },
    deploy: {
        label: "Deploy the protocol",
        cmd: "npx",
        args: ["hardhat", "deploy", "--tags", "Contracts,Poll", "--network", "localhost"],
        display: "npx hardhat deploy --tags Contracts,Poll --network localhost",
        why:
            "Sends ~21 transactions that upload each contract's code onto the chain and wire them " +
            "together through the Controller. This is what turns a blank Ethereum into a Livepeer.",
        longRunning: false
    },
    dummies: {
        label: "Deploy the L2 stub",
        cmd: "npx",
        args: ["hardhat", "deploy", "--tags", "ARBITRUM_LPT_DUMMIES", "--network", "localhost"],
        display: "npx hardhat deploy --tags ARBITRUM_LPT_DUMMIES --network localhost",
        why:
            "Deploys a stub for L2LPTDataCache. On Arbitrum that contract reports how much LPT is " +
            "circulating back on Ethereum; locally nothing provides it, so without this stub the Minter " +
            "calls address zero and initializeRound() reverts with 'function call to a non-contract account'.",
        longRunning: false
    },
    unpause: {
        label: "Unpause the protocol",
        cmd: "npx",
        args: ["hardhat", "unpause", "--network", "localhost"],
        display: "npx hardhat unpause --network localhost",
        why:
            "The Controller's constructor sets paused = true and the deploy script never turns it off. " +
            "Until you unpause, nearly every call reverts with 'system is paused'.",
        longRunning: false
    }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[a-zA-Z]/g

/**
 * Hardhat loads hardhat.config.ts through ts-node, and this repo's tsconfig
 * includes test/, deploy/, tasks/ and utils/ — so starting a node type-checks
 * the entire TypeScript project (plus typechain's generated typings) before it
 * will bind a port. That can take minutes on a cold cache and looks like a hang.
 * Running the devnet doesn't need type-checking; `yarn tsc` still does it.
 */
const CHILD_ENV = {...process.env, TS_NODE_TRANSPILE_ONLY: "1"}

function createProcesses(config) {
    const protocolDir = path.resolve(__dirname, "..", config.protocolDir)

    const state = {
        node: {running: false, ready: false, pid: null, startedAt: null},
        busy: null // id of the one-shot command currently running, if any
    }

    let nodeProc = null

    // `hardhat node` logs every single JSON-RPC call, and this UI polls state
    // constantly — unfiltered it buries the tape in eth_call chatter. One-shot
    // commands (deploy/unpause) are passed through verbatim, because their
    // output is exactly what you'd want to read in a terminal.
    const NODE_NOISE =
        /^(eth_|net_|web3_|hardhat_|evm_|personal_|Contract call:|Contract deployment:|From:|To:|Value:|Gas used:|Block #|Transaction:|Contract address:|\s*$)/
    const NODE_KEEP = /(Started HTTP|Error|error|revert|Warning|warning|HH\d{3}|Mined)/

    function interesting(source, line) {
        if (source !== "node") return true
        if (NODE_KEEP.test(line)) return true
        // hardhat indents its per-call detail lines, so match on the left-trimmed
        // text or the noise sails straight through.
        return !NODE_NOISE.test(line.replace(/^\s+/, ""))
    }

    function stream(source, chunk, onLine) {
        // Child stdout arrives in arbitrary chunks; re-assemble into lines.
        const text = chunk.toString().replace(ANSI, "")
        for (const line of text.split("\n")) {
            const trimmed = line.replace(/\s+$/, "")
            if (!trimmed) continue
            if (interesting(source, trimmed)) emit("log", {source, line: trimmed})
            if (onLine) onLine(trimmed)
        }
    }

    function assertProtocolDir() {
        if (!fs.existsSync(path.join(protocolDir, "hardhat.config.ts"))) {
            throw new Error(
                `No hardhat.config.ts found in ${protocolDir}. ` +
                    `Set "protocolDir" in config.json to your livepeer/protocol checkout.`
            )
        }
    }

    /** Is something already answering JSON-RPC on the configured port? */
    function probeRpc() {
        return new Promise(resolve => {
            const body = JSON.stringify({jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1})
            const url = new URL(config.rpcUrl)
            const req = http.request(
                {
                    host: url.hostname,
                    port: url.port || 80,
                    path: url.pathname || "/",
                    method: "POST",
                    headers: {"content-type": "application/json", "content-length": Buffer.byteLength(body)},
                    timeout: 1200
                },
                res => {
                    res.resume()
                    resolve(res.statusCode === 200)
                }
            )
            req.on("error", () => resolve(false))
            req.on("timeout", () => {
                req.destroy()
                resolve(false)
            })
            req.end(body)
        })
    }

    async function startNode() {
        assertProtocolDir()
        if (state.node.running) {
            return {alreadyRunning: true}
        }

        // A chain left running by a previous UI session is adopted rather than
        // duplicated — otherwise the port collision produces a baffling error
        // and you'd lose the state you were experimenting on.
        if (await probeRpc()) {
            state.node = {running: true, ready: true, pid: null, startedAt: Date.now(), adopted: true}
            emit("notice", {
                message: `Adopted a chain already running at ${config.rpcUrl}. Its state is intact.`
            })
            emit("lifecycle", {step: "node", status: "ready"})
            return {adopted: true}
        }

        const spec = COMMANDS.node
        emit("lifecycle", {step: "node", status: "starting", command: spec.display})

        return new Promise((resolve, reject) => {
            // detached so a Ctrl-C on the UI doesn't take the chain down with
            // it — the terminal signals the whole process group otherwise.
            nodeProc = spawn(spec.cmd, spec.args, {
                cwd: protocolDir,
                env: CHILD_ENV,
                detached: true
            })

            state.node = {running: true, ready: false, pid: nodeProc.pid, startedAt: Date.now()}
            let settled = false

            const ready = () => {
                if (settled) return
                settled = true
                state.node.ready = true
                emit("lifecycle", {step: "node", status: "ready"})
                resolve({pid: nodeProc.pid})
            }

            nodeProc.stdout.on("data", c =>
                stream("node", c, line => {
                    if (line.includes("Started HTTP and WebSocket JSON-RPC server")) ready()
                })
            )
            nodeProc.stderr.on("data", c => stream("node", c))

            nodeProc.on("error", err => {
                state.node = {running: false, ready: false, pid: null, startedAt: null}
                emit("lifecycle", {step: "node", status: "error", message: err.message})
                if (!settled) {
                    settled = true
                    reject(err)
                }
            })

            nodeProc.on("exit", code => {
                state.node = {running: false, ready: false, pid: null, startedAt: null}
                nodeProc = null
                emit("lifecycle", {step: "node", status: "stopped", code})
                if (!settled) {
                    settled = true
                    reject(new Error(`hardhat node exited with code ${code} before becoming ready`))
                }
            })

            // Hardhat prints its banner quickly; if we never see it, fail loudly
            // rather than leaving the UI spinning forever.
            setTimeout(() => {
                if (!settled) {
                    settled = true
                    reject(new Error("hardhat node did not report readiness within 60s"))
                }
            }, 60_000)
        })
    }

    /**
     * Kill whatever holds the RPC port, whoever started it, and wait for the
     * port to actually free up.
     *
     * Needed because RESET is the "things stopped making sense" escape hatch: if
     * the chain was adopted from a previous session, stopNode() alone is a no-op
     * and reset would silently re-adopt the very chain you were trying to throw
     * away.
     */
    async function killPort() {
        const port = new URL(config.rpcUrl).port
        if (!port) return false
        try {
            const {execSync} = require("child_process")
            const pids = execSync(`lsof -ti:${port} || true`, {encoding: "utf8"})
                .split("\n")
                .map(s => s.trim())
                .filter(Boolean)
            if (!pids.length) return false
            for (const pid of pids) {
                try {
                    process.kill(Number(pid), "SIGKILL")
                } catch (err) {
                    /* already gone */
                }
            }
            emit("notice", {message: `Stopped the chain holding port ${port} (pid ${pids.join(", ")}).`})
        } catch (err) {
            emit("notice", {level: "error", message: `Could not free port ${port}: ${err.message}`})
            return false
        }

        for (let i = 0; i < 40; i += 1) {
            if (!(await probeRpc())) return true
            await new Promise(r => setTimeout(r, 250))
        }
        return false
    }

    function stopNode({force = false} = {}) {
        if (!nodeProc) {
            const wasAdopted = state.node.adopted
            state.node = {running: false, ready: false, pid: null, startedAt: null}
            if (wasAdopted && force) {
                return killPort().then(killed => ({wasRunning: killed, adopted: true}))
            }
            if (wasAdopted) {
                emit("notice", {
                    level: "error",
                    message:
                        "That chain was started by a different process, so STOP CHAIN can't reach it. " +
                        "Use RESET EVERYTHING, which will stop it regardless."
                })
            }
            return Promise.resolve({wasRunning: false, adopted: wasAdopted})
        }
        return new Promise(resolve => {
            const proc = nodeProc
            const pid = proc.pid
            proc.once("exit", () => resolve({wasRunning: true}))
            // Detached children lead their own group, so signal the group.
            const signal = sig => {
                try {
                    process.kill(-pid, sig)
                } catch (err) {
                    try {
                        proc.kill(sig)
                    } catch (err2) {
                        /* already gone */
                    }
                }
            }
            signal("SIGTERM")
            setTimeout(() => {
                if (nodeProc === proc) signal("SIGKILL")
            }, 3000)
        })
    }

    function run(id) {
        assertProtocolDir()
        const spec = COMMANDS[id]
        if (!spec || spec.longRunning) {
            return Promise.reject(new Error(`Unknown one-shot command: ${id}`))
        }
        if (state.busy) {
            return Promise.reject(new Error(`Already running "${state.busy}" — wait for it to finish`))
        }

        state.busy = id
        emit("lifecycle", {step: id, status: "running", command: spec.display})

        return new Promise((resolve, reject) => {
            const proc = spawn(spec.cmd, spec.args, {cwd: protocolDir, env: CHILD_ENV})
            const tail = []

            const capture = (source, chunk) =>
                stream(source, chunk, line => {
                    tail.push(line)
                    if (tail.length > 40) tail.shift()
                })

            proc.stdout.on("data", c => capture(id, c))
            proc.stderr.on("data", c => capture(id, c))

            proc.on("error", err => {
                state.busy = null
                emit("lifecycle", {step: id, status: "error", message: err.message})
                reject(err)
            })

            proc.on("exit", code => {
                state.busy = null
                if (code === 0) {
                    emit("lifecycle", {step: id, status: "done"})
                    resolve({code, output: tail})
                } else {
                    const message = tail.slice(-6).join("\n") || `exited with code ${code}`
                    emit("lifecycle", {step: id, status: "error", message})
                    reject(new Error(message))
                }
            })
        })
    }

    function clearDeployments() {
        const dir = path.join(protocolDir, "deployments", config.network)
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, {recursive: true, force: true})
            emit("notice", {
                message: `Deleted deployments/${config.network} — stale addresses would point at nothing.`
            })
            return true
        }
        return false
    }

    function deploymentsExist() {
        const dir = path.join(protocolDir, "deployments", config.network)
        if (!fs.existsSync(dir)) return false
        return fs.readdirSync(dir).some(f => f.endsWith(".json"))
    }

    return {
        COMMANDS,
        state,
        protocolDir,
        startNode,
        stopNode,
        killPort,
        probeRpc,
        run,
        clearDeployments,
        deploymentsExist
    }
}

module.exports = {createProcesses, COMMANDS}
