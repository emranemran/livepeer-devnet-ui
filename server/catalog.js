"use strict"

/**
 * THE CATALOG
 * ===========
 * One declarative table describing every protocol action the UI exposes.
 * The browser renders its forms, tooltips, unit conversions and "show me the
 * command" panels directly from this — adding a control is one entry here, not
 * a new endpoint. The server validates every incoming request against it, so
 * the page can never invoke a method that isn't listed.
 *
 * Field guide:
 *   sender   "user"  → sent from whichever account you're acting as
 *            "owner" → forced to account #0, the Controller owner
 *   args     type drives the input widget AND the unit conversion:
 *            lpt   — human LPT, parsed to 18-decimal wei
 *            eth   — human ETH, parsed to wei
 *            perc  — percentage, stored as a numerator over `divisor`
 *            uint / address / bytes32 — raw
 *   source   where to read this in the contracts, shown in the tooltip
 */

const PERC_STANDARD = "1000000"
const PERC_V2 = "1000000000"
const PERC_PRECISE = "1000000000000000000000000000"

const ZERO = "0x0000000000000000000000000000000000000000"

const ACTIONS = [
    // ─────────────────────────────────────────── STAKE ──────────────────────
    {
        id: "bond",
        panel: "stake",
        contract: "BondingManager",
        method: "bond",
        label: "Bond LPT",
        blurb: "Lock LPT and point it at an orchestrator.",
        help:
            "Bonding is how LPT enters the protocol. Point it at someone else to become a delegator, " +
            "or at your own address to self-stake as an orchestrator. Your tokens are moved to the " +
            "protocol and start earning from the next round.",
        source: "BondingManager.sol:bond",
        sender: "user",
        autoApprove: true,
        args: [
            {
                name: "_amount",
                label: "Amount",
                type: "lpt",
                default: "1000",
                help:
                    "How much LPT to lock. The UI approves the BondingManager to move your tokens " +
                    "first — that's an ERC20 requirement, not a Livepeer one."
            },
            {
                name: "_to",
                label: "Delegate to",
                type: "address",
                default: "self",
                help:
                    "Whose stake this counts toward. Your own address makes you an orchestrator " +
                    "candidate; anyone else makes you their delegator."
            }
        ],
        reverts: {
            "transfer amount exceeds balance":
                "This account has no LPT (or not enough). Fund it from account #0 on the ACCOUNTS panel — " +
                "#0 was minted 500,000 LPT at deploy time and is where all the play money comes from.",
            "delegate is not registered":
                "That address hasn't called transcoder() yet, so it can't accept delegation.",
            "system is paused": "The protocol is paused — run the unpause step on the SETUP panel."
        }
    },
    {
        id: "transcoder",
        panel: "stake",
        contract: "BondingManager",
        method: "transcoder",
        label: "Become an orchestrator",
        blurb: "Declare your commission and join the pool.",
        help:
            "Registers you as open for business and sets the two numbers that are your entire offer " +
            "to the market. You must have bonded to yourself first.",
        source: "BondingManager.sol:transcoder",
        sender: "user",
        args: [
            {
                name: "_rewardCut",
                label: "Reward cut",
                type: "perc",
                divisor: PERC_STANDARD,
                default: "100000",
                help:
                    "The share of newly minted LPT you KEEP for yourself. Higher is worse for your " +
                    "delegators. 100000 = 10%, because percentages here are numerators over 1,000,000."
            },
            {
                name: "_feeShare",
                label: "Fee share",
                type: "perc",
                divisor: PERC_STANDARD,
                default: "500000",
                help:
                    "The share of ETH fees you PAY OUT to delegators. Higher is better for them. " +
                    "Note this is the mirror image of reward cut — the asymmetry catches everyone."
            }
        ],
        reverts: {
            "can't be updated during the lock period":
                "You're inside the round's lock period — the last stretch of a round when commission " +
                "changes are frozen so delegators can review terms. Advance to the next round first.",
            "transcoder must be registered":
                "Bond to your own address first, then register."
        }
    },
    {
        id: "reward",
        panel: "stake",
        contract: "BondingManager",
        method: "reward",
        label: "Call reward",
        blurb: "Claim this round's newly minted LPT.",
        help:
            "Mints your slice of the round's inflation and splits it with your delegators. Nothing " +
            "does this for you — miss a round and that LPT is gone for you and everyone bonded to you.",
        source: "BondingManager.sol:reward",
        sender: "user",
        args: [],
        reverts: {
            "caller has already called reward for the current round":
                "One reward call per orchestrator per round. Advance a round to call it again.",
            "transcoder must be active":
                "You're registered but not in the active set for this round. The set is frozen when a " +
                "round opens, so you join from the NEXT round after registering."
        }
    },
    {
        id: "rewardForTranscoder",
        panel: "stake",
        contract: "BondingManager",
        method: "rewardForTranscoder",
        label: "Call reward for someone",
        blurb: "Reward on another orchestrator's behalf.",
        help:
            "Lets a nominated hot wallet call reward for an orchestrator, so the keys controlling " +
            "millions in stake don't have to sit on an always-online server. Only works if that " +
            "orchestrator named you with setRewardCaller.",
        source: "BondingManager.sol:rewardForTranscoder",
        sender: "user",
        args: [
            {
                name: "_transcoder",
                label: "Orchestrator",
                type: "address",
                help: "Whose reward you're calling. They must have set you as their reward caller."
            }
        ],
        reverts: {
            "caller must be transcoder's reward caller":
                "That orchestrator hasn't nominated you. Have them run setRewardCaller first."
        }
    },
    {
        id: "setRewardCaller",
        panel: "stake",
        contract: "BondingManager",
        method: "setRewardCaller",
        label: "Nominate a reward caller",
        blurb: "Delegate the reward call to a hot wallet.",
        help:
            "Names an address allowed to call reward on your behalf. Pass the zero address to clear it. " +
            "This is the newest addition to the contract.",
        source: "BondingManager.sol:setRewardCaller",
        sender: "user",
        args: [
            {
                name: "_rewardCaller",
                label: "Reward caller",
                type: "address",
                default: ZERO,
                help: "The address you're trusting to call reward for you. Zero address unsets it."
            }
        ]
    },
    {
        id: "unbond",
        panel: "stake",
        contract: "BondingManager",
        method: "unbond",
        label: "Unbond",
        blurb: "Start withdrawing stake.",
        help:
            "Begins the exit. This creates an unbonding lock with a withdraw round set in the future — " +
            "seven rounds by default. The delay is a security mechanism: it means misbehaviour can be " +
            "caught before the collateral leaves.",
        source: "BondingManager.sol:unbond",
        sender: "user",
        args: [
            {
                name: "_amount",
                label: "Amount",
                type: "lpt",
                default: "100",
                help: "How much to start unbonding. You can unbond in several pieces; each gets its own lock."
            }
        ],
        reverts: {
            "unbond amount must be greater than 0": "Enter an amount above zero.",
            "amount is greater than bonded amount": "You're trying to unbond more than you have staked."
        }
    },
    {
        id: "rebond",
        panel: "stake",
        contract: "BondingManager",
        method: "rebond",
        label: "Rebond",
        blurb: "Cancel a pending unbond.",
        help: "Changes your mind about an unbonding lock and puts that stake back to work immediately.",
        source: "BondingManager.sol:rebond",
        sender: "user",
        args: [
            {
                name: "_unbondingLockId",
                label: "Lock ID",
                type: "uint",
                default: "0",
                help: "Which unbonding lock to cancel. IDs start at 0 and count up per delegator."
            }
        ]
    },
    {
        id: "withdrawStake",
        panel: "stake",
        contract: "BondingManager",
        method: "withdrawStake",
        label: "Withdraw stake",
        blurb: "Take LPT back after the waiting period.",
        help: "Moves the tokens from a matured unbonding lock back to your wallet.",
        source: "BondingManager.sol:withdrawStake",
        sender: "user",
        args: [
            {
                name: "_unbondingLockId",
                label: "Lock ID",
                type: "uint",
                default: "0",
                help: "Which matured lock to collect."
            }
        ],
        reverts: {
            "invalid unbonding lock ID":
                "There's no unbonding lock with that ID. Call Unbond first — that's what creates one — and note " +
                "IDs start at 0 and count up per delegator.",
            "withdraw round must be before or equal to the current round":
                "The unbonding period hasn't elapsed yet. Advance rounds on the TIME panel."
        }
    },
    {
        id: "withdrawFees",
        panel: "stake",
        contract: "BondingManager",
        method: "withdrawFees",
        label: "Withdraw fees",
        blurb: "Collect earned ETH.",
        help:
            "Pulls out the ETH you've earned from redeemed tickets. Fees accumulate as a pending " +
            "balance rather than being pushed to you — this is the claim step.",
        source: "BondingManager.sol:withdrawFees",
        sender: "user",
        args: [
            {name: "_recipient", label: "Send to", type: "address", default: "self", help: "Where the ETH goes."},
            {name: "_amount", label: "Amount", type: "eth", default: "0.01", help: "How much ETH to withdraw."}
        ],
        reverts: {
            "insufficient fees to withdraw":
                "You haven't earned that much yet. Redeem a winning ticket on the PAYMENTS panel first."
        }
    },
    {
        id: "claimEarnings",
        panel: "stake",
        contract: "BondingManager",
        method: "claimEarnings",
        label: "Claim earnings",
        blurb: "Fold pending rewards into your stake.",
        help:
            "Earnings are computed lazily — the protocol stores a per-round factor and works out your " +
            "share on demand. This settles the tally up to now so your bonded amount reflects it.",
        source: "BondingManager.sol:claimEarnings",
        sender: "user",
        args: [
            {
                name: "_endRound",
                label: "Through round",
                type: "uint",
                default: "0",
                help: "Kept for backwards compatibility — the contract always claims through the current round."
            }
        ]
    },

    // ─────────────────────────────────────────── TIME ───────────────────────
    {
        id: "initializeRound",
        panel: "time",
        contract: "RoundsManager",
        method: "initializeRound",
        label: "Initialize round",
        blurb: "Open the new round.",
        help:
            "Freezes the active set, decides how much LPT may be minted, and stores a block hash as the " +
            "round's randomness seed. Anyone may call it — on the real network a bot does. Nothing about " +
            "a new round takes effect until someone pays the gas for this.",
        source: "RoundsManager.sol:initializeRound",
        sender: "user",
        args: [],
        reverts: {
            "round already initialized": "This round is already open. Mine more blocks to reach the next one.",
            "function call to a non-contract account":
                "The L2LPTDataCache stub is missing — run the 'Deploy the L2 stub' step on SETUP."
        }
    },
    {
        id: "mineBlocks",
        panel: "time",
        contract: "RoundsManager",
        method: "mineBlocks",
        label: "Mine blocks",
        blurb: "Fast-forward the protocol clock.",
        help:
            "Only exists locally. The devnet deploys an AdjustableRoundsManager whose block number is a " +
            "variable you can bump, so a day of protocol time costs nothing instead of 5,760 real blocks.",
        source: "AdjustableRoundsManager.sol:mineBlocks",
        sender: "user",
        args: [
            {
                name: "_blocks",
                label: "Blocks",
                type: "uint",
                default: "5760",
                help: "5,760 blocks is one round. On Arbitrum these are counted in Ethereum L1 blocks, so a round runs about 19–20 hours at today\u2019s 12-second slots."
            }
        ]
    },
    {
        id: "setBlockHash",
        panel: "time",
        contract: "RoundsManager",
        method: "setBlockHash",
        label: "Set block hash",
        blurb: "Give rounds a non-zero randomness seed.",
        help:
            "Local-only. The AdjustableRoundsManager returns whatever hash you set here, and it starts at " +
            "zero. Tickets are rejected if their creation round has a zero block hash, so set this before " +
            "initializing any round you intend to build tickets against.",
        source: "AdjustableRoundsManager.sol:setBlockHash",
        sender: "user",
        args: [
            {
                name: "_hash",
                label: "Hash",
                type: "bytes32",
                default: "0x0000000000000000000000000000000000000000000000000000000000000001",
                help: "Any non-zero 32-byte value works locally."
            }
        ]
    },

    // ─────────────────────────────────────────── PAYMENTS ───────────────────
    {
        id: "fundDepositAndReserve",
        panel: "payments",
        contract: "TicketBroker",
        method: "fundDepositAndReserve",
        label: "Fund deposit and reserve",
        blurb: "Put ETH behind your tickets.",
        help:
            "Two pots. The deposit is ordinary spending money that winning tickets draw from. The reserve " +
            "is a backstop tapped when a winner is bigger than the remaining deposit, so orchestrators " +
            "aren't left holding a winner from an account that ran dry.",
        source: "MixinTicketBrokerCore.sol:fundDepositAndReserve",
        sender: "user",
        valueFrom: ["_depositAmount", "_reserveAmount"],
        args: [
            {name: "_depositAmount", label: "Deposit", type: "eth", default: "1", help: "Spending money for tickets."},
            {name: "_reserveAmount", label: "Reserve", type: "eth", default: "1", help: "Backstop for oversized winners."}
        ]
    },
    {
        id: "unlock",
        panel: "payments",
        contract: "TicketBroker",
        method: "unlock",
        label: "Request withdrawal",
        blurb: "Start the exit for your ETH.",
        help:
            "Begins the wait before you can take deposit and reserve back — the same slow-exit idea as " +
            "unbonding, so orchestrators aren't rugged mid-stream.",
        source: "MixinTicketBrokerCore.sol:unlock",
        sender: "user",
        args: []
    },
    {
        id: "cancelUnlock",
        panel: "payments",
        contract: "TicketBroker",
        method: "cancelUnlock",
        label: "Cancel withdrawal",
        blurb: "Change your mind and keep funding.",
        help: "Cancels a pending unlock so your deposit keeps backing tickets.",
        source: "MixinTicketBrokerCore.sol:cancelUnlock",
        sender: "user",
        args: []
    },
    {
        id: "withdraw",
        panel: "payments",
        contract: "TicketBroker",
        method: "withdraw",
        label: "Withdraw ETH",
        blurb: "Take deposit and reserve back.",
        help: "Collects everything once the unlock period has elapsed.",
        source: "MixinTicketBrokerCore.sol:withdraw",
        sender: "user",
        args: [],
        reverts: {
            "no unlock request in progress": "Call 'Request withdrawal' first, then wait out the unlock period.",
            "account is locked": "The unlock period hasn't elapsed. Advance rounds on the TIME panel."
        }
    },

    // ─────────────────────────────────────────── ACCOUNTS ───────────────────
    {
        id: "transferLPT",
        panel: "accounts",
        contract: "LivepeerToken",
        method: "transfer",
        label: "Send LPT",
        blurb: "Move fake tokens between accounts.",
        help:
            "Account #0 was minted 500,000 LPT at deploy time. Use this to fund the other test accounts " +
            "so they can act as delegators.",
        source: "LivepeerToken.sol:transfer",
        sender: "user",
        args: [
            {name: "_to", label: "To", type: "address", help: "Which account receives the tokens."},
            {name: "_amount", label: "Amount", type: "lpt", default: "1000", help: "How much LPT to send."}
        ],
        reverts: {
            "transfer amount exceeds balance": "This account doesn't hold that much. Send from account #0."
        }
    },
    {
        id: "faucetRequest",
        panel: "accounts",
        contract: "LivepeerTokenFaucet",
        method: "request",
        label: "Request from faucet",
        blurb: "Take the standard handout.",
        help:
            "The faucet holds 6,343,700 fake LPT and exists only on non-production deploys. It rate-limits " +
            "requests per address unless that address is whitelisted.",
        source: "LivepeerTokenFaucet.sol:request",
        sender: "user",
        args: [],
        reverts: {
            "must wait for request cooldown":
                "This account already took a handout recently. Use 'Send LPT' from account #0 instead."
        }
    },

    // ─────────────────────────────────────────── KNOBS ──────────────────────
    {
        id: "setNumActiveTranscoders",
        panel: "knobs",
        contract: "BondingManager",
        method: "setNumActiveTranscoders",
        label: "Active set size",
        blurb: "How many orchestrators can earn.",
        help:
            "Only the top N by total stake are active and eligible to earn in a round. Mainnet runs 100; a fresh " +
            "local deploy runs 10. Note this is strictly increase-only — the underlying sorted list refuses to " +
            "shrink, so you can raise the cap but never lower it. To see eviction, register more orchestrators " +
            "than there are slots and let them compete on stake.",
        source: "BondingManager.sol:setNumActiveTranscoders",
        sender: "owner",
        args: [
            {
                name: "_numActiveTranscoders",
                label: "Active set size",
                type: "uint",
                default: "15",
                help: "Number of slots. Must be greater than the current value — this knob only turns one way."
            }
        ],
        reverts: {
            "new max size must be greater than old max size":
                "The active set can only grow, never shrink — SortedDoublyLL.setMaxSize requires the new size to " +
                "exceed the old one. Enter a larger number, or create eviction pressure by registering more " +
                "orchestrators than there are slots."
        }
    },
    {
        id: "setUnbondingPeriod",
        panel: "knobs",
        contract: "BondingManager",
        method: "setUnbondingPeriod",
        label: "Unbonding period",
        blurb: "Rounds between unbond and withdraw.",
        help:
            "The security delay on exits. Seven rounds — about a week — on mainnet. Set it to 0 locally " +
            "if you want to watch a full bond/unbond/withdraw cycle without advancing time.",
        source: "BondingManager.sol:setUnbondingPeriod",
        sender: "owner",
        args: [{name: "_unbondingPeriod", label: "Rounds", type: "uint", default: "7", help: "Number of rounds to wait."}]
    },
    {
        id: "setTreasuryRewardCutRate",
        panel: "knobs",
        contract: "BondingManager",
        method: "setTreasuryRewardCutRate",
        label: "Treasury cut",
        blurb: "Share of rewards skimmed to the treasury.",
        help:
            "Taken off the top of every reward call before orchestrators and delegators split the rest. " +
            "10% on mainnet. Note this one uses the 27-digit precise divisor, not the usual 1,000,000. " +
            "It takes effect from the NEXT round, not immediately.",
        source: "BondingManager.sol:setTreasuryRewardCutRate",
        sender: "owner",
        args: [
            {
                name: "_cutRate",
                label: "Treasury cut",
                type: "perc",
                divisor: PERC_PRECISE,
                default: "100000000000000000000000000",
                help: "10% expressed over 10^27. The UI does the conversion for you."
            }
        ]
    },
    {
        id: "setTreasuryBalanceCeiling",
        panel: "knobs",
        contract: "BondingManager",
        method: "setTreasuryBalanceCeiling",
        label: "Treasury ceiling",
        blurb: "Auto-stop for treasury funding.",
        help:
            "When the treasury balance crosses this, the contract sets the cut rate to zero by itself and " +
            "stops skimming until governance turns it back on. A safety valve you can watch trigger.",
        source: "BondingManager.sol:setTreasuryBalanceCeiling",
        sender: "owner",
        args: [{name: "_ceiling", label: "Ceiling", type: "lpt", default: "750000", help: "Balance at which funding halts."}]
    },
    {
        id: "setRoundLength",
        panel: "knobs",
        contract: "RoundsManager",
        method: "setRoundLength",
        label: "Round length",
        blurb: "Blocks per round.",
        help:
            "5,760 blocks — and on Arbitrum these are Ethereum L1 blocks, because block.number reports the L1 " +
            "number there. That was a clean 24 hours at 15-second blocks; at today's 12-second slots a round runs " +
            "closer to 19–20 hours. Shorten it locally to make experiments run faster.",
        source: "RoundsManager.sol:setRoundLength",
        sender: "owner",
        args: [{name: "_roundLength", label: "Blocks", type: "uint", default: "5760", help: "Must be greater than zero."}]
    },
    {
        id: "setRoundLockAmount",
        panel: "knobs",
        contract: "RoundsManager",
        method: "setRoundLockAmount",
        label: "Round lock",
        blurb: "Freeze window at the end of a round.",
        help:
            "The tail fraction of each round during which orchestrators can't change commission or join " +
            "the pool, giving delegators a stable window to review terms. 100000 = 10% of the round.",
        source: "RoundsManager.sol:setRoundLockAmount",
        sender: "owner",
        args: [
            {
                name: "_roundLockAmount",
                label: "Lock fraction",
                type: "perc",
                divisor: PERC_STANDARD,
                default: "100000",
                help: "Share of the round that is locked, over 1,000,000."
            }
        ]
    },
    {
        id: "setTargetBondingRate",
        panel: "knobs",
        contract: "Minter",
        method: "setTargetBondingRate",
        label: "Target bonding rate",
        blurb: "The inflation thermostat's set point.",
        help:
            "Each round the Minter compares how much of the supply is staked against this target. Below " +
            "it, inflation rises to bribe more people into staking; above it, inflation falls. 50% on " +
            "mainnet. Watch the feedback loop on the chart when you move this.",
        source: "Minter.sol:setTargetBondingRate",
        sender: "owner",
        args: [
            {
                name: "_targetBondingRate",
                label: "Target",
                type: "perc",
                divisor: PERC_V2,
                default: "500000000",
                help: "50% over the Minter's 10^9 divisor. Different from the BondingManager's — check units."
            }
        ]
    },
    {
        id: "setInflationChange",
        panel: "knobs",
        contract: "Minter",
        method: "setInflationChange",
        label: "Inflation step",
        blurb: "How fast the thermostat reacts.",
        help:
            "How much the inflation rate moves each round when the bonding rate is off target. 500 over " +
            "10^9 on mainnet — 0.00005 percentage points per round. Crank it up to see the loop oscillate.",
        source: "Minter.sol:setInflationChange",
        sender: "owner",
        args: [
            {
                name: "_inflationChange",
                label: "Step per round",
                type: "perc",
                divisor: PERC_V2,
                default: "500",
                help: "Per-round adjustment, over 10^9."
            }
        ]
    },
    {
        id: "setUnlockPeriod",
        panel: "knobs",
        contract: "TicketBroker",
        method: "setUnlockPeriod",
        label: "Broker unlock period",
        blurb: "Rounds a gateway waits to withdraw ETH.",
        help: "The slow-exit delay on deposit and reserve, in rounds.",
        source: "MixinTicketProcessor.sol:setUnlockPeriod",
        sender: "owner",
        args: [{name: "_unlockPeriod", label: "Rounds", type: "uint", default: "2", help: "Rounds to wait."}]
    },
    {
        id: "setTicketValidityPeriod",
        panel: "knobs",
        contract: "TicketBroker",
        method: "setTicketValidityPeriod",
        label: "Ticket validity",
        blurb: "How long a ticket stays redeemable.",
        help:
            "A ticket expires this many rounds after its creation round, so orchestrators can't sit on " +
            "winners indefinitely.",
        source: "MixinTicketProcessor.sol:setTicketValidityPeriod",
        sender: "owner",
        args: [{name: "_ticketValidityPeriod", label: "Rounds", type: "uint", default: "2", help: "Must be greater than zero."}]
    },
    {
        id: "pause",
        panel: "knobs",
        contract: "Controller",
        method: "pause",
        label: "Pause protocol",
        blurb: "The global stop switch.",
        help:
            "Halts nearly every state-changing call across the whole protocol. This is the switch that " +
            "starts flipped on after deployment.",
        source: "Controller.sol:pause",
        sender: "owner",
        args: []
    },
    {
        id: "unpause",
        panel: "knobs",
        contract: "Controller",
        method: "unpause",
        label: "Unpause protocol",
        blurb: "Turn the protocol back on.",
        help: "Reverses the pause switch.",
        source: "Controller.sol:unpause",
        sender: "owner",
        args: []
    }
]

const BY_ID = Object.fromEntries(ACTIONS.map(a => [a.id, a]))

module.exports = {ACTIONS, BY_ID, PERC_STANDARD, PERC_V2, PERC_PRECISE, ZERO}
