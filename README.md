# Livepeer Devnet Terminal

A local, terminal-style web UI for driving and understanding a Livepeer protocol
devnet. Every command-line operation is exposed as a labelled control, every
parameter carries a plain-English explanation, and every button will show you the
exact code it stands in for.

Nothing here touches a real network. Fake money, disposable state, localhost only.

## Quick start

```bash
# the protocol checkout must be a sibling directory (or set config.json)
git clone https://github.com/livepeer/protocol.git
cd protocol && cp .env.sample .env && yarn && yarn compile

cd ../livepeer-devnet-ui
npm install
npm start          # → http://127.0.0.1:4000
```

Then press **RESET EVERYTHING** on the SETUP panel and wait ~20 seconds.

Full instructions, including the three non-obvious steps the protocol README
doesn't mention, are in **[SETUP-AGENT.md](SETUP-AGENT.md)** — written so you can
hand it to a coding agent and have it do the work.

## The guides

Three self-contained HTML field guides live in [`guides/`](guides). Download and
open in a browser — they're designed to be read in this order, and to be re-read.

| Guide | What it covers |
|---|---|
| [01 — The Livepeer protocol](guides/01-protocol-field-guide.html) | What the contracts actually do, written for someone new to crypto. Two currencies, staking and delegation, rounds and inflation, the payment lottery, and how upgrades work. |
| [02 — What runs locally](guides/02-local-devnet.html) | What a "local blockchain" actually is, which command creates which piece, and what evaporates when you close the terminal. |
| [03 — This UI](guides/03-devnet-ui-guide.html) | A tour of the six panels, what to try first, and a copy-paste prompt for handing setup to a coding agent. |

## Panels

| Panel | What it's for |
|---|---|
| **SETUP** | The four lifecycle commands, each shown verbatim, with live process output |
| **TIME** | Rounds: mine blocks, open a round, auto-run many rounds at once |
| **STAKE** | Bond, delegate, register as an orchestrator, call reward; active set and stake charts |
| **PAYMENTS** | The probabilistic micropayment lottery — sign a batch of tickets, redeem winners |
| **KNOBS** | Every governance-owned parameter, with the inflation feedback loop visualised |
| **ACCOUNTS** | All 250 test accounts, balances, roles, and who you're acting as |

## How it's built

No framework, no bundler, no build step.

- `server/` — Node's built-in `http`, one dependency (`ethers` v5). Manages the
  chain process, talks to it, and serves the UI.
- `server/catalog.js` — one declarative table describing every exposed action:
  arguments, units, help text, the equivalent code, and the plain-English meaning
  of each revert. The browser renders its forms from this, and the server
  validates every request against it. **Adding a control is one entry here.**
- `public/` — vanilla ES modules. The browser never loads ethers; it just
  `fetch`es and listens to a server-sent event stream.

Chain interaction happens entirely server-side using the devnet's unlocked
accounts, so no private key is ever handled.

## Configuration

`config.json`:

```json
{
  "protocolDir": "../protocol",
  "port": 4000,
  "rpcUrl": "http://127.0.0.1:8545",
  "network": "localhost"
}
```

## Safety

- Binds to `127.0.0.1` only. It spawns child processes and signs transactions for
  unlocked accounts — do not expose it.
- The 250 test accounts have publicly known private keys. Never send real funds.
