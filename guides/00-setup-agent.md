# Setup instructions — for a coding agent

You are setting up a local Livepeer protocol devnet plus a web UI that drives it.
Follow these steps in order. Every command has been run and verified on macOS with
Node 22; nothing here touches a real network or costs money.

**Do not skip steps 5 and 6.** They are the two that the project's own README
does not mention, and without them the protocol appears deployed but every call
reverts.

---

## What you are building

Two processes:

| Process | What it is | Port |
|---|---|---|
| `hardhat node` | A private Ethereum running in memory on the laptop, with 250 pre-funded test accounts | 8545 |
| `livepeer-devnet-ui` | A Node server that drives the chain and serves a browser UI | 4000 |

The UI starts and stops the chain for you, so in normal use you only ever run
the UI.

---

## Step 1 — Check prerequisites

```bash
node --version      # need v18 or newer; v22 is fine
git --version
docker --version    # only needed for the ROLES panel; everything else works without it
```

If Node is missing, install it (`brew install node` on macOS).

### Do not put these repos in a cloud-synced folder

On macOS, **System Settings → Apple ID → iCloud → iCloud Drive → Desktop &
Documents Folders** is on by default. If it is, anything under `~/Documents` gets
synced — including `node_modules`, which is tens of thousands of small files.

iCloud evicts and re-downloads those files underneath running processes. The
result is not a clean failure: installs appear to corrupt, `package.json` files
read as invalid and then valid seconds later, and commands that took 15 seconds
start taking 10 minutes. It is very hard to diagnose from the symptoms.

**Use `~/code` or any path outside `~/Documents` and `~/Desktop`.**

## Step 2 — Lay out the two directories side by side

The UI expects the protocol checkout to be its sibling. This exact layout:

```
some-parent-dir/
  protocol/              <- livepeer/protocol
  livepeer-devnet-ui/    <- this folder
```

Clone both into the same parent directory:

```bash
mkdir -p ~/code && cd ~/code     # NOT ~/Documents — see the warning above
git clone https://github.com/emranemran/livepeer-devnet-ui.git
git clone https://github.com/livepeer/protocol.git
```

If you were handed `livepeer-devnet-ui` as a folder or zip instead, put it in the
parent directory and clone only the protocol next to it.

If the protocol lives somewhere else, edit `livepeer-devnet-ui/config.json` and
set `protocolDir` to its path (absolute paths are fine).

## Step 3 — Install and compile the protocol

```bash
cd protocol
cp .env.sample .env      # required to exist; leave every value empty for local work
yarn                     # a few minutes
yarn compile             # ~1 minute, downloads solc 0.8.9
```

Expected final line: `Solidity compilation finished successfully`.

Optional sanity check (takes ~2 minutes, 769 tests should pass):

```bash
yarn test:unit
```

## Step 4 — Install and start the UI

```bash
cd ../livepeer-devnet-ui
npm install              # one dependency: ethers v5
npm start
```

Expected output:

```
  Livepeer Devnet Terminal
  →  http://127.0.0.1:4000
  protocol repo: /path/to/protocol
```

Open <http://127.0.0.1:4000> in a browser. The top bar will read **CHAIN DOWN**.
That is correct — nothing is running yet.

## Step 5 — Bring the protocol up

In the UI, the **SETUP** panel has four steps. Either press **RESET EVERYTHING**,
which runs all of them, or press RUN on each in order. They correspond to these
commands, which you could equally run by hand in the `protocol` directory:

```bash
npx hardhat node --no-deploy                                          # 1
npx hardhat deploy --tags Contracts,Poll --network localhost          # 2
npx hardhat deploy --tags ARBITRUM_LPT_DUMMIES --network localhost    # 3
npx hardhat unpause --network localhost                               # 4
```

Wait until the top bar reads **CHAIN UP · PROTOCOL READY · LIVE**, all in green.

### Why steps 3 and 4 exist — do not skip them

- **Step 1 needs `--no-deploy`.** Without it, `hardhat-deploy` auto-runs every
  script in `deploy/` at startup, and `deploy_ai_service_registry.ts` assumes a
  Controller already exists, so the node dies with `HH604`.
- **Step 3** deploys a stub for `L2LPTDataCache`. On Arbitrum that contract
  reports how much LPT circulates on Ethereum; locally nothing provides it, so
  without the stub the Minter calls address zero and `initializeRound()` reverts
  with the very unhelpful `function call to a non-contract account`.
- **Step 4** exists because the Controller's constructor sets `paused = true` and
  the deploy script never turns it off. Until you unpause, nearly every call
  reverts with `system is paused`.

## Step 6 — Confirm it works

In the UI:

1. **ACCOUNTS** → press **FUND 5 ACCOUNTS WITH 1,000 LPT**.
2. **STAKE** → *Bond LPT*, amount `1000`, delegate to `— acting account —`. Run it.
3. **STAKE** → *Become an orchestrator*, leave `100000` / `500000`. Run it.
4. **TIME** → press **+1 ROUND**, then **INITIALIZE ROUND**.
5. **STAKE** → press **CALL REWARD**.

The event tape at the bottom should show `stake +0.9786491 LPT`. That number is
the expected result on a fresh devnet with a 1,000 LPT self-stake and no other
orchestrators. If you see it, everything is correct.

---

## Step 7 — Optional: run the real go-livepeer daemon

Steps 1–6 give you a protocol you drive by hand. The **ROLES** panel (key `7`)
instead runs the actual `go-livepeer` binary in a Docker container, pointed at
your local chain — the same daemon orchestrators run in production, with the same
flags Livepeer's own end-to-end tests use.

Requirements: Docker Desktop running, and a one-time **~4.4 GB image pull**.

In the UI: **ROLES → Orchestrator → START**. The UI will pull the image, create
the daemon's Ethereum key, fund it from account #0, and launch the container.
When it's up you'll see its contract addresses resolve in the event tape and its
status go green.

Three things this setup handles that will otherwise waste your afternoon:

1. **Apple Silicon.** `livepeer/go-livepeer` publishes `linux/amd64` only. Without
   an explicit platform, Docker fails with `no matching manifest for
   linux/arm64/v8`. The UI pins `--platform linux/amd64`, so it runs under
   emulation.
2. **The keystore passphrase.** Left alone, the daemon finds no Ethereum account,
   decides to create one, and prompts for a passphrase on stdin — which in a
   container means it dies with `Error creating Ethereum account manager: EOF`.
   The UI writes the key first, so there is nothing to prompt for.
3. **The `input` vs `data` field.** This one is genuinely nasty. Modern
   go-ethereum sends call data in a field named `input`; hardhat 2.8.3, which
   this protocol repo pins, only reads `data`. Hardhat therefore sees an empty
   call and reports `function selector was not recognized and there's no fallback
   nor receive function` — which reads like a contract-version mismatch and sends
   you hunting in entirely the wrong place. The UI runs a small translating shim
   (`server/rpcshim.js`) on port 8546 and points containers at that.

Note that on a local devnet the daemon's round-initialisation loop watches for L1
blocks that never advance on their own, so it will sit idle until you mine blocks
from the TIME panel. That is expected.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `HH604: No deployment found for: Controller` | Started the node without `--no-deploy` | Use the SETUP panel, or add the flag |
| `function call to a non-contract account` | Skipped step 3 | Run the "Deploy the L2 stub" step |
| `system is paused` | Skipped step 4 | Run the "Unpause the protocol" step |
| `Port 4000 is already in use` | A UI is already running | `lsof -ti:4000 \| xargs kill` |
| Top bar says **STALE ADDRESSES** | The chain restarted but `deployments/localhost` survived, so every recorded address points at nothing | Press **RESET EVERYTHING** |
| Arithmetic underflow on initialize round | The chain starts at block zero and the contract reads the *previous* block's hash | Mine some blocks first — the UI's time controls do this for you |
| `ERC20: transfer amount exceeds balance` when bonding | That account has no LPT | Fund it from account #0 on the ACCOUNTS panel |
| `transcoder()` reverts, "lock period" | You're in the frozen tail of a round | Advance to the next round |
| `no matching manifest for linux/arm64/v8` | Apple Silicon; the image is amd64-only | Handled automatically; if pulling by hand add `--platform linux/amd64` |
| Daemon exits with `account manager: EOF` | It tried to prompt for a keystore passphrase | Use the ROLES panel, which writes the key first |
| `function selector was not recognized` from a daemon | go-ethereum sends `input`, hardhat 2.8.3 reads `data` | The RPC shim handles it; make sure port 8546 is free |
| Everything is 20× slower than it should be, installs corrupt | The repos are in an iCloud-synced folder | Move them outside `~/Documents` — see Step 1 |

## Notes for whoever runs this

- **Everything is fake.** The 250 accounts have publicly known private keys.
  Never send real funds to them.
- **The chain is in memory.** Stopping it erases all state. The UI's RESET button
  rebuilds everything in about 20 seconds.
- **The chain outlives the UI.** Restarting the UI adopts the running chain
  rather than killing it, so you don't lose an experiment.
- **The UI binds to 127.0.0.1 only.** It spawns processes and signs transactions
  for unlocked accounts; do not expose it to a network.
- **No video is involved.** This is the accounting and coordination layer only.
  Actual transcoding lives in a separate program, `go-livepeer`.
