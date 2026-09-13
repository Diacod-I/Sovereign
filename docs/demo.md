# Sovereign: 4 minute demo runbook

The line to keep coming back to:

> A freelance marketplace of agents, for your agent.

One worker, hired once, graded once. The judges asked for a happy path and a
feedback loop, not a tour. Anything you add costs you the grading scene, and the
grading scene is the one that was asked for.

---

## Before you hit record

Top to bottom. Anything that fails here fails on camera.

**Deployment**

- [ ] `git push origin main`, Vercel shows the newest commit live
- [ ] `npm publish` done, `sovereign-mcp` is at 1.9.0 on npm
- [ ] `npm run preflight` prints `nothing blocking`
- [ ] Green in particular: Privy credentials ACCEPTED, Grading (Receipts contract), Circle API key, Durable storage

**The worker**

- [ ] The dead listing is in `NEXT_PUBLIC_HIDDEN_LISTINGS` and gone from the grid
- [ ] New listing created from the account you are logged into now
- [ ] Its `payTo` is the wallet your terminal is linked to
- [ ] Raw webhook returns real advisories for your demo input
- [ ] `/w/<slug>` unpaid returns **402**, not 500

**Buyer account**

- [ ] Embedded wallet funded with Arc USDC, for gas
- [ ] Agent spending balance at 2 USDC or more
- [ ] Worker allowlisted, with a per-call cap
- [ ] Daily budget comfortably above three runs
- [ ] World ID verified, badge visible

**Terminal**

- [ ] `npx -y sovereign-mcp@latest link --spend`, approved
- [ ] Claude Code fully quit and restarted after both the link and the publish
- [ ] Dry run returns `"blocking":[]`
- [ ] Font size up. Bigger than you think.

**Shot**

- [ ] Browser on the marketplace, logged in, scrolled to top
- [ ] Terminal cleared, in the repo root
- [ ] Notifications off, other tabs closed

---

## The script

Times are ends, not durations. Past a mark, cut talking, not scenes.

### 0:00 to 0:20 — the problem

> Agents can reason. They cannot pay for anything. So the moment your agent
> needs work it cannot do itself, a human has to stop, find a service, sign up,
> and put in a card. Sovereign is a marketplace where your agent hires another
> agent, pays per call, and the work builds a public track record.

Do not say x402 yet. Do not say nanopayments. Show it first.

### 0:20 to 0:55 — what a buyer sees

Browser. Scroll the grid once, then open one worker's profile. Point at, in
order:

1. What it does, and the price per call
2. Track record: calls served, how often it met expectations
3. The seller, and the World ID badge

> This is everything a buyer gets before spending anything. What it does, what
> it costs, and whether anyone has been happy with it before.

If it says unproven, say so out loud. It sets up the ending.

### 0:55 to 1:45 — your agent hires it

Terminal. One line, phrased like a person, not a command:

```
hire a vulnerability agent from Sovereign to check lodash 4.17.20
```

It searches, picks, pays, and answers without stopping. While it runs:

> It found the worker on chain, the worker quoted a price in a 402, and my
> wallet signed an authorization for exactly that amount. There is no key on
> this machine, no subscription, no card.

Land on the output and the settlement reference. Say the number:

> Ten cents. Settled on Arc through Circle Gateway.

### 1:45 to 2:15 — why it did not ask me

This beat is new and it is the strongest thirty seconds in the video. Say it
looking at the terminal, then cut to the dashboard:

> Notice it never asked my permission. It did not need to. I allowlisted that
> worker, set a per-call cap, and set a daily budget, and the server checks all
> three before it signs anything. The limits are the permission. That is what
> makes this delegation instead of a blank cheque.

Show the spend bar having moved. If you want a refusal on camera, set the
per-action limit below the price beforehand and run it once: it declines in one
line, in the terminal, with the reason.

### 2:15 to 3:00 — the feedback loop

The part the judges asked for. Back in the terminal, tell it your verdict and
let it file:

> The scan missed a known advisory, so I am grading it down. I say what I think,
> my agent files the receipt on chain, and it is signed by the wallet that
> actually paid. You cannot review something you did not buy.

Then refresh the worker's profile and show the record change.

**Do not hide a bad grade.** A first graded call that is an honest failure,
filed by the buyer who paid for it, proves the mechanism far better than a wall
of five star ratings does.

### 3:00 to 3:30 — the seller side

Do not build one live. Show the form and the finished listing:

> Anyone with a webhook becomes a paid worker. Paste the URL, set a price, and
> Sovereign puts the payment wall in front of it. The seller never implements
> x402 and never holds a key for it.

### 3:30 to 4:00 — sponsors, then close

One sentence each. This was explicitly asked for.

- **Arc and Circle**: the payment is the call. x402 with Circle Gateway settles
  a tenth of a cent with no subscription, which is the only way per-call hiring
  works at all.
- **World ID**: one human, one seller account. Reputation means nothing if a bad
  seller can start over for free.
- **The Graph**: track records are read from chain, so the record outlives the
  marketplace showing it.

Close on the line you opened with.

---

## Do not do these on camera

- Do not run `link --spend` live. Browser approval plus a restart.
- Do not create a listing live. The on-chain write takes as long as it takes.
- Do not hire a worker you have not run today.
- Do not open Privy or Vercel. Nothing good is in frame there.
- Do not say "it should" about anything. Cut the scene instead.

## If something breaks mid-take

Keep going and narrate it, or stop and cut. Do not debug on camera. Four minutes
with one clean paid call and one honest grade beats six minutes that show
everything and land nothing.
