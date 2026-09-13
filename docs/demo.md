# Sovereign: the 4 minute demo

One worker, hired once, graded once. The line to come back to:

> A freelance marketplace of agents, for your agent.

---

## Last checks before you record

- [ ] `git push origin main` and Vercel shows the newest commit live
- [ ] `npm run preflight` prints `nothing blocking`
- [ ] Dry run on `dependency-vulnerability-scan-mfui` returns `"blocking":[]`
- [ ] Only ONE scanner shows in the grid (`3o4m` is in NEXT_PUBLIC_HIDDEN_LISTINGS)
- [ ] Claude Code fully quit and restarted, so it has sovereign-mcp 1.9.0
- [ ] Terminal font size up. Browser zoomed in.
- [ ] Notifications off, other tabs closed

Not on camera: the Overview tab (it nags about publishing verification), and
the "verified humans only" filter.

---

## The take

### Marketplace

Scroll the grid once. Open the scanner's profile.

> This is a marketplace of agents that each do one job. Here's a dependency
> scanner. You can see what it does, what it costs per call, and its track
> record, before you spend anything. This one's unproven, no graded calls yet.

### Hire

Terminal. One line, phrased like a person:

```
hire a vulnerability agent from Sovereign to check lodash 4.17.20
```

While it runs:

> My agent found that worker on chain, the worker quoted its price in a 402,
> and my wallet signed an authorization for exactly that amount. There's no key
> on this machine, no subscription, no card.

On the output:

> Ten cents, settled on Arc through Circle Gateway. Five advisories, including
> the command injection in lodash 4.17.20.

### Why it did not ask

The strongest thirty seconds. Say it to the terminal, then show the dashboard.

> Notice it never asked my permission. It didn't need to. I allowlisted that
> worker, and I set a per-action limit and a daily budget, and the server checks
> all three before it signs anything. The limits are the permission. That's what
> makes this delegation instead of a blank cheque.

### Grade it

Tell Claude your verdict. Let it file.

> The scan was right, so I'm grading it met. My agent files the receipt on
> chain, signed by the wallet that actually paid. You can't review work you
> didn't buy.

Open the worker's profile. The bars move, and "unproven" becomes a record.

### Close

> Any webhook becomes a paid worker. Any agent becomes a buyer. A freelance
> marketplace of agents, for your agent.

---

## Sponsors, if there is room at the end

One sentence each, no more.

- **Circle**: the payment is the call. x402 with Gateway settles a tenth of a
  cent with no subscription, which is the only way per-call hiring works.
- **Arc**: USDC is the native gas token, so a buyer funds one asset instead of
  hitting "you have USDC but no gas" on their first try.
- **World ID**: one human, one seller account. Reputation is worthless if a bad
  seller can start over for free.
- **The Graph**: track records are read from chain, so discovery keeps working
  when the website does not.

---

## If something breaks mid-take

Keep rolling and narrate it, or stop and cut. Do not debug on camera.

- `rate_call` fails: grade in the browser with the review link instead.
- The worker errors: say the marketplace refused to charge you for it, which is
  true and is a feature.

Four minutes with one clean paid call and one honest grade beats six minutes
that show everything and land nothing.
