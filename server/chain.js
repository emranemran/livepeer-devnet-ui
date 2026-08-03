"use strict"

const fs = require("fs")
const path = require("path")
const {ethers} = require("ethers")

const {emit} = require("./bus")

// Percentage denominators used across the protocol. Every "percentage" in these
// contracts is a numerator over one of these, and which one depends on the
// contract — this is the single most common source of confusion.
const PERC = {
    // MathUtils.sol — BondingManager, RoundsManager
    STANDARD: ethers.BigNumber.from(1_000_000),
    // MathUtilsV2.sol — Minter (inflation, target bonding rate)
    V2: ethers.BigNumber.from(1_000_000_000),
    // PreciseMathUtils.sol — treasury reward cut rate
    PRECISE: ethers.BigNumber.from(10).pow(27)
}

const contractId = name => ethers.utils.solidityKeccak256(["string"], [name])

function createChain(config, processes) {
    const deploymentsDir = () =>
        path.join(processes.protocolDir, "deployments", config.network)

    let provider = null
    let deployments = null
    let deploymentsLoadedAt = 0

    function getProvider() {
        if (!provider) {
            provider = new ethers.providers.JsonRpcProvider(config.rpcUrl)
            // The devnet mines instantly; polling adds latency for nothing.
            provider.pollingInterval = 250
        }
        return provider
    }

    function resetProvider() {
        provider = null
        deployments = null
    }

    /**
     * Load every deployment artifact, pairing each logical contract name with
     * the right ABI.
     *
     * hardhat-deploy saves proxied contracts under their plain name but with
     * ManagerProxy's ABI (3 functions — a fallback and not much else). The real
     * interface lives in `<Name>Target.json`. So: address from the plain file,
     * ABI from the Target file when one exists.
     */
    function loadDeployments({force = false} = {}) {
        const dir = deploymentsDir()
        if (!fs.existsSync(dir)) {
            deployments = null
            return null
        }
        const stat = fs.statSync(dir)
        if (!force && deployments && stat.mtimeMs === deploymentsLoadedAt) {
            return deployments
        }

        const raw = {}
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith(".json")) continue
            const name = file.replace(/\.json$/, "")
            try {
                raw[name] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))
            } catch (err) {
                emit("notice", {message: `Could not parse deployments/${config.network}/${file}`})
            }
        }

        const resolved = {}
        for (const [name, artifact] of Object.entries(raw)) {
            if (name.endsWith("Target") || name.endsWith("Proxy")) continue
            const target = raw[`${name}Target`]
            resolved[name] = {
                address: artifact.address,
                abi: target ? target.abi : artifact.abi,
                proxied: Boolean(target)
            }
        }

        deployments = resolved
        deploymentsLoadedAt = stat.mtimeMs
        return deployments
    }

    function contract(name, signerOrProvider) {
        const all = loadDeployments()
        const entry = all && all[name]
        if (!entry) throw new Error(`${name} is not deployed. Run the deploy step first.`)
        return new ethers.Contract(entry.address, entry.abi, signerOrProvider || getProvider())
    }

    function has(name) {
        const all = loadDeployments()
        return Boolean(all && all[name])
    }

    /** The rounds manager locally is an AdjustableRoundsManager (mineBlocks etc). */
    function rounds(signerOrProvider) {
        return contract("RoundsManager", signerOrProvider)
    }

    async function isUp() {
        try {
            await getProvider().getBlockNumber()
            return true
        } catch (err) {
            return false
        }
    }

    const safe = async (promise, fallback = null) => {
        try {
            return await promise
        } catch (err) {
            return fallback
        }
    }

    /**
     * Are the files in deployments/ describing *this* chain? After a node
     * restart the folder survives but every address in it points at empty
     * space. Checking for code at the Controller address catches that.
     */
    async function deploymentsAreLive() {
        const all = loadDeployments()
        if (!all || !all.Controller) return false
        const code = await safe(getProvider().getCode(all.Controller.address), "0x")
        return code && code !== "0x"
    }

    async function accounts() {
        const provider = getProvider()
        const addresses = await safe(provider.send("eth_accounts", []), [])
        return addresses
    }

    async function balances(addresses) {
        const provider = getProvider()
        const token = has("LivepeerToken") ? contract("LivepeerToken") : null
        return Promise.all(
            addresses.map(async (address, index) => ({
                index,
                address,
                eth: (await safe(provider.getBalance(address), ethers.constants.Zero)).toString(),
                lpt: token
                    ? (await safe(token.balanceOf(address), ethers.constants.Zero)).toString()
                    : "0"
            }))
        )
    }

    /** Walk the sorted linked list of registered orchestrators. */
    async function transcoderPool(limit = 200) {
        if (!has("BondingManager")) return []
        const bm = contract("BondingManager")
        const out = []

        let addr = await safe(bm.getFirstTranscoderInPool(), ethers.constants.AddressZero)
        while (addr && addr !== ethers.constants.AddressZero && out.length < limit) {
            const [info, totalStake, status, active, delegator] = await Promise.all([
                safe(bm.getTranscoder(addr)),
                safe(bm.transcoderTotalStake(addr), ethers.constants.Zero),
                safe(bm.transcoderStatus(addr), 0),
                safe(bm.isActiveTranscoder(addr), false),
                safe(bm.getDelegator(addr))
            ])

            out.push({
                rank: out.length + 1,
                address: addr,
                totalStake: totalStake.toString(),
                selfStake: delegator ? delegator.bondedAmount.toString() : "0",
                delegatedAmount: delegator ? delegator.delegatedAmount.toString() : "0",
                rewardCut: info ? info.rewardCut.toString() : "0",
                feeShare: info ? info.feeShare.toString() : "0",
                lastRewardRound: info ? info.lastRewardRound.toString() : "0",
                activationRound: info ? info.activationRound.toString() : "0",
                deactivationRound: info ? info.deactivationRound.toString() : "0",
                registered: Number(status) === 1,
                active: Boolean(active)
            })

            addr = await safe(bm.getNextTranscoderInPool(addr), ethers.constants.AddressZero)
        }
        return out
    }

    async function roundInfo() {
        if (!has("RoundsManager")) return null
        const rm = rounds()
        const [currentRound, startBlock, roundLength, lockAmount, initialized, locked, lastInit, blockNum] =
            await Promise.all([
                safe(rm.currentRound(), ethers.constants.Zero),
                safe(rm.currentRoundStartBlock(), ethers.constants.Zero),
                safe(rm.roundLength(), ethers.constants.Zero),
                safe(rm.roundLockAmount(), ethers.constants.Zero),
                safe(rm.currentRoundInitialized(), false),
                safe(rm.currentRoundLocked(), false),
                safe(rm.lastInitializedRound(), ethers.constants.Zero),
                safe(rm.blockNum(), ethers.constants.Zero)
            ])

        const elapsed = blockNum.sub(startBlock)
        const progress = roundLength.isZero()
            ? 0
            : Math.min(100, elapsed.mul(100).div(roundLength).toNumber())

        return {
            currentRound: currentRound.toString(),
            lastInitializedRound: lastInit.toString(),
            currentRoundStartBlock: startBlock.toString(),
            roundLength: roundLength.toString(),
            roundLockAmount: lockAmount.toString(),
            blockNum: blockNum.toString(),
            blocksIntoRound: elapsed.toString(),
            blocksRemaining: roundLength.sub(elapsed).toString(),
            progress,
            initialized: Boolean(initialized),
            locked: Boolean(locked)
        }
    }

    async function parameters() {
        const out = {}

        if (has("BondingManager")) {
            const bm = contract("BondingManager")
            // Two different numbers with confusingly similar names:
            //   getTranscoderPoolMaxSize() — how many slots exist (the knob)
            //   getTranscoderPoolSize()    — how many orchestrators registered
            const [unbondingPeriod, maxSlots, treasuryCut, treasuryCeiling, totalBonded, registered] =
                await Promise.all([
                    safe(bm.unbondingPeriod()),
                    safe(bm.getTranscoderPoolMaxSize()),
                    safe(bm.treasuryRewardCutRate()),
                    safe(bm.treasuryBalanceCeiling()),
                    safe(bm.getTotalBonded()),
                    safe(bm.getTranscoderPoolSize())
                ])
            out.unbondingPeriod = unbondingPeriod ? unbondingPeriod.toString() : null
            out.maxActiveTranscoders = maxSlots ? maxSlots.toString() : null
            out.registeredTranscoders = registered ? registered.toString() : "0"
            out.treasuryRewardCutRate = treasuryCut ? treasuryCut.toString() : null
            out.treasuryBalanceCeiling = treasuryCeiling ? treasuryCeiling.toString() : null
            out.totalBonded = totalBonded ? totalBonded.toString() : "0"
        }

        if (has("Minter")) {
            const minter = contract("Minter")
            const [inflation, inflationChange, target, mintable, minted] = await Promise.all([
                safe(minter.inflation()),
                safe(minter.inflationChange()),
                safe(minter.targetBondingRate()),
                safe(minter.currentMintableTokens()),
                safe(minter.currentMintedTokens())
            ])
            out.inflation = inflation ? inflation.toString() : null
            out.inflationChange = inflationChange ? inflationChange.toString() : null
            out.targetBondingRate = target ? target.toString() : null
            out.currentMintableTokens = mintable ? mintable.toString() : "0"
            out.currentMintedTokens = minted ? minted.toString() : "0"
        }

        if (has("TicketBroker")) {
            const broker = contract("TicketBroker")
            const [unlockPeriod, validity] = await Promise.all([
                safe(broker.unlockPeriod()),
                safe(broker.ticketValidityPeriod())
            ])
            out.unlockPeriod = unlockPeriod ? unlockPeriod.toString() : null
            out.ticketValidityPeriod = validity ? validity.toString() : null
        }

        if (has("LivepeerToken")) {
            const token = contract("LivepeerToken")
            const totalSupply = await safe(token.totalSupply(), ethers.constants.Zero)
            out.totalSupply = totalSupply.toString()

            if (out.totalBonded && !totalSupply.isZero()) {
                // Bonding rate drives the inflation feedback loop in Minter.setInflation()
                out.bondingRate = ethers.BigNumber.from(out.totalBonded)
                    .mul(PERC.V2)
                    .div(totalSupply)
                    .toString()
            }
        }

        if (has("Treasury") && has("LivepeerToken")) {
            const token = contract("LivepeerToken")
            const treasury = loadDeployments().Treasury.address
            const bal = await safe(token.balanceOf(treasury), ethers.constants.Zero)
            out.treasuryBalance = bal.toString()
        }

        return out
    }

    /** Is the L2LPTDataCache stub registered? Without it initializeRound reverts. */
    async function dummiesRegistered() {
        if (!has("Controller")) return false
        const addr = await safe(
            contract("Controller").getContract(contractId("L2LPTDataCache")),
            ethers.constants.AddressZero
        )
        return Boolean(addr) && addr !== ethers.constants.AddressZero
    }

    async function snapshot() {
        const up = await isUp()
        const base = {
            chain: {
                up,
                rpcUrl: config.rpcUrl,
                node: processes.state.node,
                busy: processes.state.busy
            },
            deployed: false,
            deploymentsOnDisk: processes.deploymentsExist(),
            stale: false,
            dummies: false,
            paused: null,
            blockNumber: null,
            round: null,
            params: {},
            pool: [],
            contracts: {}
        }

        if (!up) return base

        base.blockNumber = await safe(getProvider().getBlockNumber(), null)

        const all = loadDeployments()
        if (!all) return base

        base.contracts = Object.fromEntries(
            Object.entries(all).map(([name, e]) => [name, e.address])
        )

        const live = await deploymentsAreLive()
        if (!live) {
            // Files describe a chain that no longer exists.
            base.stale = base.deploymentsOnDisk
            return base
        }

        base.deployed = true
        const [paused, dummies, round, params, pool] = await Promise.all([
            safe(contract("Controller").paused(), null),
            dummiesRegistered(),
            roundInfo(),
            parameters(),
            transcoderPool()
        ])

        base.paused = paused
        base.dummies = dummies
        base.round = round
        base.params = params
        base.pool = pool
        return base
    }

    return {
        PERC,
        contractId,
        getProvider,
        resetProvider,
        loadDeployments,
        contract,
        has,
        rounds,
        isUp,
        accounts,
        balances,
        transcoderPool,
        roundInfo,
        parameters,
        deploymentsAreLive,
        snapshot
    }
}

module.exports = {createChain, PERC, contractId}
