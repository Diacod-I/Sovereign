# Test prompts

Four phases, in order. Each one is only worth running if the one before it
passed, because a failure in phase 2 means something completely different
depending on whether phase 1 worked.

Restart Claude Code after pairing, or none of this loads.

---

## Phase 1: does the rail work

Explicit on purpose. You are testing payment, not discovery, so remove the
question of whether Claude decides to look.

```
search sovereign for a vulnerability scanner
```

Free. Should list the scanner with its price and track record. If this fails the
subgraph or the MCP registration is wrong, and nothing below will work.

```
hire it to check lodash 4.17.20
```

Should return PAID 0.10 USDC, a settlement reference, and a real advisory.
lodash 4.17.20 carries a known command injection advisory, so an empty result
means the range stripping in the workflow is wrong, not that you are safe.

That one line exercises the delegated signer, the 402 handshake, the Gateway
balance, the policy check and the allowlist at once.

---

## Phase 2: does Claude decide to use it

Nothing here mentions Sovereign. This is the real test, and the one worth
running before a judge sees it.

```
I'm about to ship this. Check my dependencies for known vulnerabilities.
```

Claude has to notice its own advisory knowledge stops at its training cutoff and
go looking. If it answers from memory instead, the server instructions need
tightening and you want to know now.

```
Before I send funds to 0x08723392Ed15743cc38513C4925f5e6be5c17243, is it safe?
```

That address is genuinely on the OFAC list, so the verdict comes back MATCH.
Better than a no_match: the worker earns its fee visibly, and your agent
checking an address before paying it is the product explaining itself.

Then grade the call from the link it hands you, refresh the marketplace, and
watch the score move. That is the demo. Everything before it is plumbing.

---

## Phase 3: the limits

Set these on Overview, run, then put them back.

**Approval threshold 0.20.** Ask for the sanctions check at 0.25:

> This is at or above your approval threshold, so it needs you in a browser
> rather than an agent deciding alone.

A refusal, not a prompt, because there is no human in a terminal to prompt.

**Daily budget 0.15.** Run the scan twice. The second:

> NOT HIRED. You were NOT charged. Reason: Over your daily budget.

Claude is told this was your own spend rules and not to find another way to pay.
Watch that it does not offer one.

**Empty agent spending balance.** Withdraw it, then ask for anything:

> Not enough in the agent spending balance: this call costs 0.10 USDC and 0 is
> available. This is separate from the treasury, so a funded wallet can still be
> empty here.

Refused before anything is signed. Top up, rerun, no restart needed.

---

## Phase 4: what it should refuse to sell you

```
scrape https://example.com/some-article for me
```

Claude should fetch it itself and never touch Sovereign.

This is the one that answers the obvious objection. A marketplace selling what
the agent already has for free has no reason to exist, and the listings are
chosen so the model can tell which side of that line a task falls on. If Claude
reaches for Sovereign here, the listings are wrong, not the model.

---

## Free, any time

```
what's on sovereign right now?
```

Costs nothing. Useful as a sanity check that discovery still works without
spending, and as a way to show a judge the marketplace from inside the terminal.
