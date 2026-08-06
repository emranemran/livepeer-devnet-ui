"use strict"

const {spawn, execFile} = require("child_process")
const fs = require("fs")
const http = require("http")
const path = require("path")

const {emit} = require("./bus")
const {createShim} = require("./rpcshim")

/**
 * Real go-livepeer daemons, run as Docker containers against the local devnet.
 *
 * This is the piece that turns the sandbox from "press the buttons a daemon
 * would press" into "run the actual daemon". The flags below come from
 * go-livepeer's own end-to-end harness (test/e2e/e2e.go), which does exactly
 * this against a local chain — network "devnet", an empty eth password, fast
 * block polling, and -initializeRound to turn on the round-opening bot.
 */

const PREFIX = "lpdev"

// The daemon encrypts its keystore with this. It's a throwaway devnet key, and
// the password has to be known to both sides — go-livepeer takes it via
// -ethPassword and will otherwise prompt on stdin, which has no TTY in a
// container.
const KEY_PASSWORD = "livepeer-devnet"

const ROLES = {
    orchestrator: {
        label: "Orchestrator",
        blurb: "Runs the GPU side. Opens rounds, calls reward, receives tickets.",
        cliPort: 7935,
        servicePort: 8935,
        // What this daemon takes over from you once it's running.
        takesOver: ["initializeRound()", "reward()", "ticket validation", "ServiceRegistry URI"],
        args({controller, chainUrl, serviceHost}) {
            return [
                "-orchestrator",
                "-transcoder",
                "-serviceAddr", `${serviceHost}:${this.servicePort}`,
                "-httpAddr", `0.0.0.0:${this.servicePort}`,
                "-pricePerUnit", "1",
                "-initializeRound",
                ...common({controller, chainUrl, cliPort: this.cliPort})
            ]
        }
    },
    gateway: {
        label: "Gateway",
        blurb: "The paying side. Funds a deposit and sends signed tickets.",
        cliPort: 7936,
        servicePort: 8936,
        takesOver: ["ticket creation", "ticket signing", "orchestrator discovery"],
        args({controller, chainUrl, serviceHost}) {
            return [
                "-gateway",
                "-httpAddr", `0.0.0.0:${this.servicePort}`,
                "-maxTicketEV", "100000000000000",
                ...common({controller, chainUrl, cliPort: this.cliPort})
            ]
        }
    }
}

function common({controller, chainUrl, cliPort}) {
    return [
        "-network", "devnet",
        "-ethUrl", chainUrl,
        "-ethController", controller,
        "-ethPassword", KEY_PASSWORD,
        "-datadir", "/data",
        "-cliAddr", `0.0.0.0:${cliPort}`,
        // The devnet mines instantly; the mainnet default would make the node
        // look asleep.
        "-blockPollingInterval", "1",
        "-v", "4"
    ]
}

function createNodes(config, chain) {
    // go-livepeer speaks modern go-ethereum JSON-RPC; hardhat 2.8.3 doesn't.
    // Everything from a container goes through this translating shim.
    const shim = createShim(config)
    const dataRoot = path.resolve(__dirname, "..", "data", "nodes")
    const image = config.goLivepeerImage || "livepeer/go-livepeer:latest"
    const logStreams = new Map()

    // The published go-livepeer image is linux/amd64 only. On Apple Silicon
    // Docker refuses with "no matching manifest for linux/arm64/v8" unless the
    // platform is pinned, which makes it run under emulation.
    const PLATFORM = ["--platform", "linux/amd64"]

    const run = (args, {timeout = 60_000} = {}) =>
        new Promise((resolve, reject) => {
            execFile("docker", args, {timeout, maxBuffer: 8 * 1024 * 1024}, (err, stdout, stderr) => {
                if (err) return reject(new Error((stderr || err.message).trim()))
                resolve(stdout.trim())
            })
        })

    async function dockerAvailable() {
        try {
            await run(["info", "--format", "{{.ServerVersion}}"], {timeout: 8000})
            return true
        } catch (err) {
            return false
        }
    }

    async function imagePresent() {
        try {
            const out = await run(["images", "-q", image], {timeout: 15_000})
            return Boolean(out)
        } catch (err) {
            return false
        }
    }

    /** ~2.4 GB, so stream progress rather than looking frozen. */
    function pullImage() {
        return new Promise((resolve, reject) => {
            emit("notice", {message: `Pulling ${image} — this is a couple of GB, one time only.`})
            const proc = spawn("docker", ["pull", ...PLATFORM, image])
            let last = 0
            const tail = []
            const note = chunk => {
                const text = chunk.toString()
                for (const raw of text.split("\n")) {
                    const line = raw.trim()
                    if (!line) continue
                    // Keep everything for the error path; only show summaries live.
                    tail.push(line)
                    if (tail.length > 20) tail.shift()
                    if (!/^(Status|Digest|Pulling from|error|Error|.*Pull complete)/.test(line)) continue
                    if (Date.now() - last < 500) continue
                    last = Date.now()
                    emit("log", {source: "docker", line})
                }
            }
            proc.stdout.on("data", note)
            proc.stderr.on("data", note)
            proc.on("error", reject)
            proc.on("exit", code => {
                if (code === 0) return resolve(true)
                // Previously this threw away the reason and just said "exited 1".
                const why = tail.filter(l => /no matching manifest|denied|unauthorized|no space|toomanyrequests|error/i.test(l))
                reject(new Error(why.length ? why.join(" · ") : tail.slice(-3).join(" · ") || `docker pull exited ${code}`))
            })
        })
    }

    const containerName = role => `${PREFIX}-${role}`
    const roleDir = role => path.join(dataRoot, role)

    async function containerState(role) {
        try {
            const out = await run([
                "inspect", "-f", "{{.State.Status}}", containerName(role)
            ], {timeout: 10_000})
            return out
        } catch (err) {
            return "absent"
        }
    }

    /**
     * The daemon generates its own Ethereum account on first boot and writes it
     * into the mounted datadir. We read it back so the UI can fund it — which
     * mirrors what a real operator does: start the node, then send it money.
     */
    function account(role) {
        const dir = roleDir(role)
        if (!fs.existsSync(dir)) return null
        const stack = [dir]
        while (stack.length) {
            const current = stack.pop()
            let entries
            try {
                entries = fs.readdirSync(current, {withFileTypes: true})
            } catch (err) {
                continue
            }
            for (const entry of entries) {
                const full = path.join(current, entry.name)
                if (entry.isDirectory()) {
                    stack.push(full)
                } else if (entry.name.startsWith("UTC--")) {
                    try {
                        const json = JSON.parse(fs.readFileSync(full, "utf8"))
                        if (json.address) return `0x${json.address}`
                    } catch (err) {
                        /* keep looking */
                    }
                }
            }
        }
        return null
    }

    /** go-livepeer answers /status on its CLI port once it is actually up. */
    function status(role) {
        const spec = ROLES[role]
        return new Promise(resolve => {
            const req = http.get(
                {host: "127.0.0.1", port: spec.cliPort, path: "/status", timeout: 2500},
                res => {
                    let body = ""
                    res.on("data", c => (body += c))
                    res.on("end", () => {
                        try {
                            resolve({up: res.statusCode === 200, ...JSON.parse(body)})
                        } catch (err) {
                            resolve({up: res.statusCode === 200, raw: body.slice(0, 400)})
                        }
                    })
                }
            )
            req.on("error", () => resolve({up: false}))
            req.on("timeout", () => {
                req.destroy()
                resolve({up: false})
            })
        })
    }

    function streamLogs(role) {
        if (logStreams.has(role)) return
        const proc = spawn("docker", ["logs", "-f", "--tail", "20", containerName(role)])
        logStreams.set(role, proc)

        const forward = chunk => {
            for (const line of chunk.toString().split("\n")) {
                const trimmed = line.trim()
                if (!trimmed) continue
                // glog lines are dense; keep the ones that tell a story.
                if (!/round|reward|ticket|orchestrator|gateway|register|service ?uri|error|ERROR|WARN|eth|deposit/i.test(trimmed)) {
                    continue
                }
                emit("log", {source: role, line: trimmed.slice(0, 300)})
            }
        }
        proc.stdout.on("data", forward)
        proc.stderr.on("data", forward)
        proc.on("exit", () => logStreams.delete(role))
    }

    function stopLogs(role) {
        const proc = logStreams.get(role)
        if (proc) {
            proc.kill()
            logStreams.delete(role)
        }
    }

    /**
     * Create the daemon's Ethereum key up front.
     *
     * Left to itself, go-livepeer sees an empty keystore, decides to create an
     * account, and prompts for a passphrase on stdin — which in a container
     * means it dies with "Error creating Ethereum account manager: EOF".
     * Livepeer's own e2e harness sidesteps this the same way, by writing the key
     * before the node starts. It also means we can fund the account *before*
     * first boot, so the daemon comes up already solvent.
     */
    async function ensureKeystore(role) {
        const existing = account(role)
        if (existing) return existing

        const {ethers} = require("ethers")
        const dir = path.join(roleDir(role), "keystore")
        fs.mkdirSync(dir, {recursive: true})

        const wallet = ethers.Wallet.createRandom()
        const json = await wallet.encrypt(KEY_PASSWORD)
        const stamp = new Date(0).toISOString().replace(/[:.]/g, "-")
        fs.writeFileSync(
            path.join(dir, `UTC--${stamp}--${wallet.address.slice(2).toLowerCase()}`),
            json
        )
        emit("notice", {message: `Created a keystore for the ${ROLES[role].label} at ${wallet.address}.`})
        return wallet.address
    }

    async function start(role) {
        const spec = ROLES[role]
        if (!spec) throw new Error(`Unknown role "${role}"`)

        if (!(await dockerAvailable())) {
            throw new Error(
                "Docker isn't running. Start Docker Desktop and try again — the daemons run as containers."
            )
        }
        if (!(await imagePresent())) await pullImage()

        const deployments = chain.loadDeployments()
        if (!deployments || !deployments.Controller) {
            throw new Error("Deploy the protocol first — the daemon needs a Controller address.")
        }

        // Reuse an existing container so keys and state survive a restart.
        const state = await containerState(role)
        if (state === "running") return {alreadyRunning: true}
        if (state !== "absent") {
            await run(["rm", "-f", containerName(role)]).catch(() => {})
        }

        fs.mkdirSync(roleDir(role), {recursive: true})
        const ethAcct = await ensureKeystore(role)

        // Fund before first boot so the node doesn't come up broke.
        try {
            const balance = await chain.getProvider().getBalance(ethAcct)
            if (balance.isZero()) await fund(role)
        } catch (err) {
            emit("notice", {level: "error", message: `Could not pre-fund ${role}: ${err.message}`})
        }

        // Containers reach the host chain and each other through the host
        // gateway, so one address works from inside and outside.
        await shim.start()
        const serviceHost = "host.docker.internal"
        const args = [
            "run", "-d",
            ...PLATFORM,
            "--name", containerName(role),
            "--add-host=host.docker.internal:host-gateway",
            "-p", `${spec.cliPort}:${spec.cliPort}`,
            "-p", `${spec.servicePort}:${spec.servicePort}`,
            "-v", `${roleDir(role)}:/data`,
            image,
            ...spec.args({
                controller: deployments.Controller.address,
                chainUrl: `http://${serviceHost}:${shim.port}`,
                serviceHost
            }),
            "-ethAcctAddr", ethAcct
        ]

        emit("lifecycle", {step: role, status: "running", command: `docker ${args.join(" ")}`})
        const id = await run(args, {timeout: 90_000})
        emit("notice", {message: `${spec.label} container started (${id.slice(0, 12)}).`})
        streamLogs(role)
        return {id}
    }

    async function stop(role) {
        stopLogs(role)
        await run(["rm", "-f", containerName(role)]).catch(() => {})
        emit("lifecycle", {step: role, status: "stopped"})
        return {ok: true}
    }

    /** Give the daemon's account gas money and, for an orchestrator, LPT. */
    async function fund(role, {eth = "10", lpt = "2000"} = {}) {
        const addr = account(role)
        if (!addr) {
            throw new Error(
                "The daemon hasn't generated its key yet. Give it a few seconds after starting, then retry."
            )
        }

        const {ethers} = require("ethers")
        const provider = chain.getProvider()
        const accounts = await chain.accounts()
        const funder = provider.getSigner(accounts[0])

        const tx = await funder.sendTransaction({to: addr, value: ethers.utils.parseEther(String(eth))})
        await tx.wait()

        let lptTx = null
        if (chain.has("LivepeerToken") && Number(lpt) > 0) {
            const token = chain.contract("LivepeerToken", funder)
            lptTx = await token.transfer(addr, ethers.utils.parseEther(String(lpt)))
            await lptTx.wait()
        }

        emit("notice", {message: `Funded ${ROLES[role].label} (${addr.slice(0, 10)}…) with ${eth} ETH and ${lpt} LPT.`})
        return {address: addr, eth, lpt}
    }

    async function snapshot() {
        const docker = await dockerAvailable()
        const out = {
            docker,
            image,
            imagePresent: docker ? await imagePresent() : false,
            shim: {running: shim.running, port: shim.port, translated: shim.translated},
            roles: {}
        }

        for (const [role, spec] of Object.entries(ROLES)) {
            const state = docker ? await containerState(role) : "absent"
            const addr = account(role)
            let balances = null
            if (addr && (await chain.deploymentsAreLive())) {
                const [eth, lpt] = await Promise.all([
                    chain.getProvider().getBalance(addr).catch(() => null),
                    chain.has("LivepeerToken")
                        ? chain.contract("LivepeerToken").balanceOf(addr).catch(() => null)
                        : Promise.resolve(null)
                ])
                balances = {eth: eth ? eth.toString() : "0", lpt: lpt ? lpt.toString() : "0"}
            }
            out.roles[role] = {
                label: spec.label,
                blurb: spec.blurb,
                takesOver: spec.takesOver,
                cliPort: spec.cliPort,
                servicePort: spec.servicePort,
                state,
                address: addr,
                balances,
                status: state === "running" ? await status(role) : {up: false}
            }
            if (state === "running") streamLogs(role)
        }
        return out
    }

    return {
        ROLES,
        image,
        shim,
        dockerAvailable,
        imagePresent,
        pullImage,
        start,
        stop,
        fund,
        account,
        status,
        snapshot
    }
}

module.exports = {createNodes, ROLES}
