"use strict"

const {ethers} = require("ethers")

/**
 * Probabilistic micropayment tickets — an ethers port of the repo's
 * test/helpers/ticket.js, which is written against web3.
 *
 * The idea: transcoding a segment is worth a fraction of a cent, and writing
 * that to a chain costs more than the payment. So instead of paying a tiny
 * amount ten thousand times, the gateway signs ten thousand tickets each worth
 * a lot but with a one-in-ten-thousand chance of winning. Same expected value,
 * one on-chain transaction instead of ten thousand.
 */

const MAX_UINT256 = ethers.constants.MaxUint256

/** auxData packs the creation round and that round's block hash. */
function buildAuxData(creationRound, creationRoundBlockHash) {
    return ethers.utils.defaultAbiCoder.encode(
        ["uint256", "bytes32"],
        [creationRound, creationRoundBlockHash]
    )
}

/** Mirrors MixinTicketBrokerCore.getTicketHash — encodePacked, not encode. */
function ticketHash(ticket) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "bytes"],
        [
            ticket.recipient,
            ticket.sender,
            ticket.faceValue,
            ticket.winProb,
            ticket.senderNonce,
            ticket.recipientRandHash,
            ticket.auxData
        ]
    )
}

/**
 * The orchestrator commits to a secret in advance by publishing only its hash,
 * so it can't fish for a value that makes a ticket win.
 */
function recipientRandHash(recipientRand) {
    return ethers.utils.solidityKeccak256(["uint256"], [recipientRand])
}

/**
 * The winner check, exactly as the contract computes it. Neither side can rig
 * it: the sender's signature and the recipient's secret are hashed together.
 */
function isWinningTicket(sig, recipientRand, winProb) {
    const h = ethers.utils.solidityKeccak256(["bytes", "uint256"], [sig, recipientRand])
    return ethers.BigNumber.from(h).lt(ethers.BigNumber.from(winProb))
}

/** "1 in N" odds expressed as the contract's uint256 threshold. */
function oddsToWinProb(oneInN) {
    const n = ethers.BigNumber.from(String(oneInN))
    if (n.lte(1)) return MAX_UINT256
    return MAX_UINT256.div(n)
}

function winProbToOdds(winProb) {
    const p = ethers.BigNumber.from(winProb)
    if (p.isZero()) return Infinity
    return MAX_UINT256.div(p).toNumber()
}

function createTicket({recipient, sender, faceValue, winProb, senderNonce, randHash, auxData}) {
    return {
        recipient,
        sender,
        faceValue: ethers.BigNumber.from(faceValue).toString(),
        winProb: ethers.BigNumber.from(winProb).toString(),
        senderNonce: Number(senderNonce),
        recipientRandHash: randHash,
        auxData
    }
}

/**
 * Build and sign a batch of tickets, marking which ones won.
 *
 * The gateway signs each ticket hash with a personal-sign message, which is
 * what the contract's ECDSA recovery expects.
 */
async function generateBatch({
    signer,
    recipient,
    sender,
    faceValue,
    winProb,
    count,
    startNonce = 0,
    recipientRand,
    auxData
}) {
    const randHash = recipientRandHash(recipientRand)
    const tickets = []

    for (let i = 0; i < count; i += 1) {
        const ticket = createTicket({
            recipient,
            sender,
            faceValue,
            winProb,
            senderNonce: startNonce + i,
            randHash,
            auxData
        })
        const hash = ticketHash(ticket)
        const sig = await signer.signMessage(ethers.utils.arrayify(hash))

        tickets.push({
            ...ticket,
            hash,
            sig,
            won: isWinningTicket(sig, recipientRand, winProb)
        })
    }

    return tickets
}

/** The tuple shape redeemWinningTicket expects. */
function toStruct(ticket) {
    return [
        ticket.recipient,
        ticket.sender,
        ticket.faceValue,
        ticket.winProb,
        ticket.senderNonce,
        ticket.recipientRandHash,
        ticket.auxData
    ]
}

module.exports = {
    MAX_UINT256,
    buildAuxData,
    ticketHash,
    recipientRandHash,
    isWinningTicket,
    oddsToWinProb,
    winProbToOdds,
    createTicket,
    generateBatch,
    toStruct
}
