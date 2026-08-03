"use strict"

const {ethers} = require("ethers")

const {emit} = require("./bus")
const {ACTIONS, BY_ID} = require("./catalog")
const {createSeries} = require("./series")
const tickets = require("./tickets")

const ZERO_ADDRESS = ethers.constants.AddressZero

module.exports = function createActions({config, chain, processes}) {
    const series = createSeries(chain)

    // ── helpers ─────────────────────────────────────────────────────────────

    async function ownerAddress() {
        const accounts = await chain.accounts()
        if (!accounts.length) throw new Error("The chain has no accounts — is it running?")
        return accounts[0]
    }

    async function resolveSender(action, from) {
        if (action.sender === "owner") return ownerAddress()
        if (!from) return ownerAddress()
        return ethers.utils.getAddress(from)
    }

    function coerce(spec, raw, sender) {
        const value = raw === undefined || raw === "" ? spec.default : raw

        switch (spec.type) {
            case "lpt":
            case "eth": {
                if (value === undefined || value === null || value === "") {
                    throw new Error(`${spec.label} is required`)
                }
                return ethers.utils.parseEther(String(value))
            }
            case "perc":
            case "uint": {
                if (value === undefined || value === null || value === "") {
                    throw new Error(`${spec.label} is required`)
                }
                return ethers.BigNumber.from(String(value).trim())
            }
            case "address": {
                if (value === "self" || value === undefined || value === "") return sender
                if (value === "zero") return ZERO_ADDRESS
                return ethers.utils.getAddress(String(value).trim())
            }
            case "bytes32": {
                const v = String(value)
                if (!ethers.utils.isHexString(v, 32)) {
                    throw new Error(`${spec.label} must be a 32-byte hex value`)
                }
                return v
            }
            default:
                return value
        }
    }

    /** Render the ethers one-liner this action is about to run. */
    function snippetFor(action, params) {
        const varName = {
            BondingManager: "bm",
            RoundsManager: "rm",
            LivepeerToken: "token",
            TicketBroker: "broker",
            Minter: "minter",
            Controller: "controller",
            LivepeerTokenFaucet: "faucet"
        }[action.contract] || "contract"

        const printed = params.map(p => {
            if (ethers.BigNumber.isBigNumber(p)) {
                // Show token amounts the way a human would write them.
                const asEther = ethers.utils.formatEther(p)
                if (p.gte(ethers.utils.parseEther("0.000001")) && asEther.length < 26) {
                    return `ethers.utils.parseEther("${asEther.replace(/\.0$/, "")}")`
                }
                return `"${p.toString()}"`
            }
            return `"${p}"`
        })
        return `await ${varName}.${action.method}(${printed.join(", ")})`
    }

    function explainRevert(action, message) {
        const text = String(message || "")
        for (const [needle, plain] of Object.entries(action.reverts || {})) {
            if (text.includes(needle)) return plain
        }
        if (text.includes("system is paused")) {
            return "The protocol is paused — run the unpause step on the SETUP panel."
        }
        if (text.includes("current round is not initialized")) {
            return "This round hasn't been opened yet. Hit 'Initialize round' on the TIME panel."
        }
        if (text.includes("non-contract account")) {
            return "The L2LPTDataCache stub is missing — run 'Deploy the L2 stub' on the SETUP panel."
        }
        return null
    }

    function revertMessage(err) {
        return (
            err?.error?.message ||
            err?.data?.message ||
            err?.reason ||
            err?.message ||
            "transaction failed"
        )
            .replace(/^Error: /, "")
            .replace(/^VM Exception while processing transaction: reverted with reason string '(.*)'$/, "$1")
            .replace(/^execution reverted: /, "")
    }

    /** Decode receipt logs against every ABI we know about. */
    function decodeEvents(receipt) {
        const deployments = chain.loadDeployments() || {}
        const interfaces = Object.entries(deployments).map(([name, d]) => ({
            name,
            iface: new ethers.utils.Interface(d.abi)
        }))

        const out = []
        for (const log of receipt.logs || []) {
            for (const {name, iface} of interfaces) {
                try {
                    const parsed = iface.parseLog(log)
                    out.push({
                        contract: name,
                        event: parsed.name,
                        args: Object.fromEntries(
                            parsed.eventFragment.inputs.map((input, i) => [
                                input.name || `arg${i}`,
                                parsed.args[i]?.toString?.() ?? String(parsed.args[i])
                            ])
                        )
                    })
                    break
                } catch (err) {
                    /* this ABI doesn't know this event; try the next */
                }
            }
        }
        return out
    }

    /** A small before/after snapshot so every action shows what it changed. */
    async function probe(address) {
        const provider = chain.getProvider()
        const safe = async (p, fallback = "0") => {
            try {
                return (await p).toString()
            } catch (err) {
                return fallback
            }
        }

        const out = {
            eth: await safe(provider.getBalance(address)),
            lpt: chain.has("LivepeerToken") ? await safe(chain.contract("LivepeerToken").balanceOf(address)) : "0"
        }

        if (chain.has("BondingManager")) {
            const bm = chain.contract("BondingManager")
            out.pendingStake = await safe(bm.pendingStake(address, 0))
            out.pendingFees = await safe(bm.pendingFees(address, 0))
            out.transcoderTotalStake = await safe(bm.transcoderTotalStake(address))
            out.totalBonded = await safe(bm.getTotalBonded())
        }
        return out
    }

    function diff(before, after) {
        const out = {}
        for (const key of Object.keys(after)) {
            if (before[key] === undefined) continue
            try {
                const d = ethers.BigNumber.from(after[key]).sub(ethers.BigNumber.from(before[key]))
                if (!d.isZero()) out[key] = d.toString()
            } catch (err) {
                /* non-numeric field */
            }
        }
        return out
    }

    // ── the generic executor ────────────────────────────────────────────────

    async function build(body) {
        const action = BY_ID[body.id]
        if (!action) throw new Error(`Unknown action "${body.id}"`)

        const sender = await resolveSender(action, body.from)
        const args = body.args || {}
        const params = action.args.map(spec => coerce(spec, args[spec.name], sender))

        let value = ethers.constants.Zero
        if (action.valueFrom) {
            for (const name of action.valueFrom) {
                const index = action.args.findIndex(a => a.name === name)
                value = value.add(params[index])
            }
        }

        return {action, sender, params, value}
    }

    function preview(body) {
        try {
            const action = BY_ID[body.id]
            if (!action) throw new Error(`Unknown action "${body.id}"`)
            const sender = body.from || "0x…"
            const params = action.args.map(spec => coerce(spec, (body.args || {})[spec.name], sender))
            return {
                ok: true,
                snippet: snippetFor(action, params),
                sender: action.sender === "owner" ? "account #0 (Controller owner)" : sender,
                note:
                    action.sender === "owner"
                        ? "This is an owner-only call, so it is always sent from account #0 regardless of who you're acting as."
                        : null
            }
        } catch (err) {
            return {ok: false, error: err.message}
        }
    }

    async function execute(body) {
        const {action, sender, params, value} = await build(body)

        if (!(await chain.deploymentsAreLive())) {
            throw new Error("The protocol isn't deployed on this chain. Use the SETUP panel first.")
        }

        const provider = chain.getProvider()
        const signer = provider.getSigner(sender)
        const contract = chain.contract(action.contract, signer)
        const snippet = snippetFor(action, params)
        const extraTxs = []

        const before = await probe(sender)

        try {
            // ERC20 approval is a prerequisite, not a Livepeer concept — do it
            // for the user but show that it happened.
            if (action.autoApprove && chain.has("LivepeerToken")) {
                const token = chain.contract("LivepeerToken", signer)
                const spender = chain.loadDeployments()[action.contract].address
                const amount = params[0]
                const allowance = await token.allowance(sender, spender)
                if (allowance.lt(amount)) {
                    const approveTx = await token.approve(spender, amount)
                    const approveReceipt = await approveTx.wait()
                    extraTxs.push({
                        label: "ERC20 approval",
                        snippet: `await token.approve("${spender}", ${amount.toString()})`,
                        hash: approveReceipt.transactionHash,
                        gasUsed: approveReceipt.gasUsed.toString()
                    })
                }
            }

            const overrides = value.isZero() ? {} : {value}
            const tx = await contract[action.method](...params, overrides)
            const receipt = await tx.wait()

            const after = await probe(sender)
            const events = decodeEvents(receipt)
            const changed = diff(before, after)

            emit("tx", {
                id: action.id,
                label: action.label,
                status: "ok",
                sender,
                hash: receipt.transactionHash,
                gasUsed: receipt.gasUsed.toString(),
                snippet,
                events,
                diff: changed
            })

            await series.sample()

            return {
                ok: true,
                hash: receipt.transactionHash,
                gasUsed: receipt.gasUsed.toString(),
                snippet,
                extraTxs,
                events,
                diff: changed,
                sender
            }
        } catch (err) {
            const message = revertMessage(err)
            const explanation = explainRevert(action, message)
            emit("tx", {
                id: action.id,
                label: action.label,
                status: "revert",
                sender,
                snippet,
                message,
                explanation
            })
            return {ok: false, error: message, explanation, snippet, sender}
        }
    }

    // ── time travel ─────────────────────────────────────────────────────────

    async function time(op, body = {}) {
        if (!(await chain.deploymentsAreLive())) {
            throw new Error("The protocol isn't deployed on this chain. Use the SETUP panel first.")
        }

        const provider = chain.getProvider()
        const owner = await ownerAddress()
        const rm = chain.rounds(provider.getSigner(owner))

        if (op === "mine") {
            const blocks = ethers.BigNumber.from(String(body.blocks || 5760))
            const tx = await rm.mineBlocks(blocks)
            await tx.wait()
            emit("tx", {
                id: "mineBlocks",
                label: "Mine blocks",
                status: "ok",
                snippet: `await rm.mineBlocks(${blocks.toString()})`,
                hash: tx.hash
            })
            return {ok: true, blocks: blocks.toString()}
        }

        if (op === "initRound") {
            try {
                const tx = await rm.initializeRound()
                const receipt = await tx.wait()
                await series.sample({force: true})
                emit("tx", {
                    id: "initializeRound",
                    label: "Initialize round",
                    status: "ok",
                    snippet: "await rm.initializeRound()",
                    hash: receipt.transactionHash,
                    gasUsed: receipt.gasUsed.toString()
                })
                return {ok: true, hash: receipt.transactionHash}
            } catch (err) {
                const message = revertMessage(err)
                emit("tx", {
                    id: "initializeRound",
                    label: "Initialize round",
                    status: "revert",
                    message,
                    explanation: explainRevert({reverts: {}}, message)
                })
                return {ok: false, error: message}
            }
        }

        if (op === "autoRun") {
            const roundsToRun = Math.max(1, Math.min(500, Number(body.rounds || 10)))
            const callReward = body.callReward !== false
            const info = await chain.roundInfo()
            const roundLength = ethers.BigNumber.from(info.roundLength)
            const accounts = (await chain.accounts()).map(a => a.toLowerCase())
            const results = []

            for (let i = 0; i < roundsToRun; i += 1) {
                await (await rm.mineBlocks(roundLength)).wait()

                try {
                    await (await rm.initializeRound()).wait()
                } catch (err) {
                    emit("progress", {
                        job: "autoRun",
                        index: i + 1,
                        total: roundsToRun,
                        message: `Round init failed: ${revertMessage(err)}`
                    })
                    break
                }

                let rewarded = 0
                if (callReward) {
                    const pool = await chain.transcoderPool()
                    for (const t of pool) {
                        if (!t.active) continue
                        // We can only act for accounts the node has unlocked.
                        if (!accounts.includes(t.address.toLowerCase())) continue
                        try {
                            const bm = chain.contract("BondingManager", provider.getSigner(t.address))
                            await (await bm.reward()).wait()
                            rewarded += 1
                        } catch (err) {
                            /* already rewarded, or not active this round */
                        }
                    }
                }

                const point = await series.sample({force: true})
                results.push({round: point ? point.round : null, rewarded})
                emit("progress", {
                    job: "autoRun",
                    index: i + 1,
                    total: roundsToRun,
                    message: `Round ${point ? point.round : "?"} — ${rewarded} reward call${rewarded === 1 ? "" : "s"}`
                })
            }

            emit("notice", {message: `Auto-run finished: ${results.length} rounds advanced.`})
            return {ok: true, rounds: results}
        }

        throw new Error(`Unknown time operation "${op}"`)
    }

    // ── ticket lottery ──────────────────────────────────────────────────────

    const ticketState = {batch: [], recipientRand: null, nonce: 0}

    async function ticketOps(op, body = {}) {
        if (!chain.has("TicketBroker")) throw new Error("TicketBroker is not deployed yet.")
        const provider = chain.getProvider()

        if (op === "info") {
            const broker = chain.contract("TicketBroker")
            const sender = body.sender ? ethers.utils.getAddress(body.sender) : await ownerAddress()
            const info = await broker.getSenderInfo(sender)
            return {
                ok: true,
                sender,
                deposit: info.sender.deposit.toString(),
                withdrawRound: info.sender.withdrawRound.toString(),
                reserve: info.reserve.fundsRemaining.toString(),
                batch: ticketState.batch.length
            }
        }

        if (op === "generate") {
            const recipient = ethers.utils.getAddress(body.recipient)
            const sender = ethers.utils.getAddress(body.sender)
            const count = Math.max(1, Math.min(500, Number(body.count || 20)))
            const faceValue = ethers.utils.parseEther(String(body.faceValue || "0.01"))
            const oneInN = Math.max(1, Number(body.oneInN || 10))

            const info = await chain.roundInfo()
            const creationRound = ethers.BigNumber.from(info.currentRound)
            const blockHash = await chain.rounds().blockHashForRound(creationRound)

            if (blockHash === ethers.constants.HashZero) {
                throw new Error(
                    "This round has no block hash, so tickets built against it would be rejected. " +
                        "Set a non-zero block hash on the TIME panel, then initialize a new round."
                )
            }

            const auxData = tickets.buildAuxData(creationRound, blockHash)
            const recipientRand = Math.floor(Math.random() * 1e15) + 1

            const batch = await tickets.generateBatch({
                signer: provider.getSigner(sender),
                recipient,
                sender,
                faceValue,
                winProb: tickets.oddsToWinProb(oneInN),
                count,
                startNonce: ticketState.nonce,
                recipientRand,
                auxData
            })

            ticketState.batch = batch
            ticketState.recipientRand = recipientRand
            ticketState.nonce += count

            const winners = batch.filter(t => t.won)
            emit("notice", {
                message: `Signed ${count} tickets at 1-in-${oneInN} — ${winners.length} won.`
            })

            return {
                ok: true,
                count,
                oneInN,
                faceValue: faceValue.toString(),
                creationRound: creationRound.toString(),
                expectedWinners: count / oneInN,
                winners: winners.length,
                tickets: batch.map((t, i) => ({index: i, nonce: t.senderNonce, won: t.won, hash: t.hash}))
            }
        }

        if (op === "redeem") {
            const winners = ticketState.batch.filter(t => t.won)
            if (!winners.length) throw new Error("No winning tickets in the current batch.")

            const redeemed = []
            for (const ticket of winners) {
                const broker = chain.contract("TicketBroker", provider.getSigner(ticket.recipient))
                try {
                    const tx = await broker.redeemWinningTicket(
                        tickets.toStruct(ticket),
                        ticket.sig,
                        ticketState.recipientRand
                    )
                    const receipt = await tx.wait()
                    redeemed.push({hash: receipt.transactionHash, faceValue: ticket.faceValue})
                    emit("tx", {
                        id: "redeemWinningTicket",
                        label: "Redeem winning ticket",
                        status: "ok",
                        hash: receipt.transactionHash,
                        gasUsed: receipt.gasUsed.toString(),
                        snippet: "await broker.redeemWinningTicket(ticket, sig, recipientRand)"
                    })
                } catch (err) {
                    const message = revertMessage(err)
                    emit("tx", {
                        id: "redeemWinningTicket",
                        label: "Redeem winning ticket",
                        status: "revert",
                        message
                    })
                    return {ok: false, error: message, redeemed}
                }
            }

            // Each secret may only be used once; force a fresh batch next time.
            ticketState.batch = []
            await series.sample()
            return {ok: true, redeemed}
        }

        throw new Error(`Unknown ticket operation "${op}"`)
    }

    // ── what the browser gets ───────────────────────────────────────────────

    function catalogForClient() {
        return ACTIONS.map(a => ({
            id: a.id,
            panel: a.panel,
            contract: a.contract,
            method: a.method,
            label: a.label,
            blurb: a.blurb,
            help: a.help,
            source: a.source,
            sender: a.sender,
            autoApprove: Boolean(a.autoApprove),
            args: a.args
        }))
    }

    return {
        series,
        catalogForClient,
        preview,
        execute,
        time,
        tickets: ticketOps
    }
}
