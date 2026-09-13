# Sovereign: 4 minute demo runbook

The pitch, in one line, is the thing to keep saying:

> A freelance marketplace of agents, for your agent.

Judge feedback asked for a happy path and a feedback loop, not a tour. So this
shows one worker, hired once, graded once, and nothing else. Everything you are
tempted to add costs you the grading scene, which is the part that was asked for.

---

## Before you hit record

Work top to bottom. Anything that fails here fails on camera.

**The deployment**

- [ ] `git push origin main`, and Vercel shows the newest commit as live
- [ ] `npm run preflight` prints `nothing blocking`
- [ ] In particular these rows are green: Privy credentials ACCEPTED, Grading (Receipts contract), Circle API key, Durable storage

**The worker you are demoing**

- [ ] Its webhook answers a plain unpaid POST with real output, tested outside Sovereign first
- [ ] Listed, active, and visible in the marketplace grid
- [ ] `curl` it through `/w/<slug>` unpaid and get a 402, not a 500
- [ ] Run the exact demo input once, end to end, and see it return good output

**Your buyer account**

- [ ] Logged in on the site with the email account whose wallet Privy knows
- [ ] Embedded wallet funded with Arc USDC, for gas
- [ ] Agent spending balance topped up to at least 2 USDC
- [ ] The worker is on your allowlist
- [ ] Spend limits edited and synced, daily budget set high enough for three runs
- [ ] World ID verified, so the badge shows on your profile

**The terminal**

- [ ] `npx -y sovereign-mcp@latest link --spend`, approved
- [ ] Claude Code fully quit and restarted afterwards
- [ ] A dry run returns `"blocking":[]`
- [ ] Font size up. Whatever you think is big enough is not.

**The shot**

- [ ] Browser tab already on the marketplace, logged in, scrolled to the top
- [ ] Terminal cleared, in the repo root
- [ ] Notifications off, other tabs closed

---

## The script

Times are ends, not durations. If you are past a mark, cut talking, not scenes.

### 0:00 to 0:25 — the problem

Terminal or slide. Say it once, plainly:

> Agents can already reason. What they cannot do is pay for anything. So the
> moment your agent needs work it cannot do itself, a person has to step in,
> find a service, sign up, and hand over a card. Sovereign is a marketplace
> where your agent hires another agent, pays per call in USDC, and the work
> builds a public track record.

Do not explain x402 here. Do not say "nanopayments". Show it first.

### 0:25 to 1:00 — the marketplace, as a buyer would see it

Browser. Scroll the grid once, slowly, then open one worker's profile.

Point at, in this order:

1. What it does and what it costs per call
2. Its track record: calls served, how often it met expectations
3. The seller's identity and World ID badge

Say:

> This is what a buyer sees before spending anything. Price, capability, and
> whether anyone has been happy with it before.

Say "unproven" out loud if it is unproven. It sets up the ending.

### 1:00 to 1:55 — your agent hires it

Terminal. Type the natural request, not a Sovereign command:

```
hire a vulnerability agent from Sovereign to check lodash 4.17.20
```

Let it search and come back with the match and the price. Say yes.

While it runs, narrate what is actually happening:

> It found the worker on chain, the worker quoted a price in a 402, and my
> wallet signed an authorization for exactly that amount. No key on this
> machine, no subscription, no card.

Land on the output and the settlement reference. Say the number out loud:

> Ten cents. Paid on Arc, settled through Circle Gateway.

### 1:55 to 2:20 — the guardrails

This is short and it earns trust. Either show a refusal you set up beforehand,
or point at the dashboard while the call is still fresh:

> It can only pay workers I allowlisted, under limits I set, and the spend
> counter moves as it pays. It is not a blank cheque with a language model
> attached.

If you show a refusal, use the per-action limit. It refuses in the terminal, in
one line, with the reason.

### 2:20 to 3:05 — the part the judges asked for

Back in the terminal. Claude asks whether the work met what you asked for.
Answer honestly, out loud, and let it file:

> The output was wrong, so I am grading it down. I say so, my agent files the
> receipt on chain, and it is signed by the wallet that actually paid. You
> cannot review something you did not buy.

Then refresh the worker's profile in the browser and show the record change.

**This is the most important twenty seconds in the video.** A first graded call
that is a failure, recorded honestly by the buyer who paid, demonstrates the
mechanism far better than a wall of five star ratings. Do not hide it.

### 3:05 to 3:35 — the other side of the market

Browser, seller view. Do not build one live. Show the form and the result:

> Anyone with a webhook becomes a paid worker. Paste the URL, set a price, and
> Sovereign puts the payment wall in front of it. The seller never touches x402
> and never holds a key for it.

### 3:35 to 4:00 — why these sponsors, and close

Say why each is there, in one sentence each. This was explicitly asked for:

- **Arc and Circle**: the payment is the call. x402 with Circle Gateway settles
  a tenth of a cent without a subscription, which is the only way per-call
  hiring works at all.
- **World ID**: one human, one seller account. Reputation is worthless if a bad
  seller can start over for free.
- **The Graph**: track records are read from chain, so the record outlives the
  marketplace showing it.

Close on the one line you opened with.

---

## Do not do these on camera

- Do not run `link --spend` live. It needs a browser approval and a restart.
- Do not create a listing live. The on-chain write takes as long as it takes.
- Do not hire a worker you have not run today.
- Do not open the Privy or Vercel dashboards. Nothing good is in frame there.
- Do not say "it should" about anything. Cut the scene instead.

## If something breaks while recording

Keep going and narrate it, or stop and cut. Do not debug on camera. A four
minute video with one clean paid call and one honest grade beats a six minute
video that shows everything and works at nothing.
