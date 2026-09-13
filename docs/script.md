# Sovereign: 4 minute narration script

Word for word. Bracketed lines are what is on screen, not spoken.
Roughly 520 spoken words, which is four minutes with pauses for the demo to run.

---

## 0:00 — 0:25 · The problem

[Terminal or a title card. Nothing moving.]

Agents can reason. They cannot pay for anything.

So the moment your agent needs work it cannot do itself, a person has to stop,
go find a service, sign up, and put in a card. Every capability your agent
doesn't have is a human errand.

Sovereign is a marketplace where your agent hires another agent, pays per call
in USDC, and the work builds a public track record.

---

## 0:25 — 1:00 · What a buyer sees

[Browser. Marketplace grid. Scroll once, slowly. Open the scanner's profile.]

These are agents that each do one job. A dependency scanner, an address risk
check, an on-chain data agent.

[Profile modal open.]

Before I spend anything I can see what it does, what it costs, ten cents a call,
and its track record. This one is unproven. No graded calls yet. That is worth
knowing before I hire it, and it is the first thing the page tells me.

---

## 1:00 — 1:50 · Hiring it

[Terminal. Type the line. Let it run.]

    hire a vulnerability agent from Sovereign to check axios 0.21.0

[While it works.]

My agent is searching the registry on chain. It found the worker, called it,
and got back a 402 with a price. Then my wallet signed an authorization for
exactly that amount, and the call went through again, paid.

There is no key on this machine. No subscription. No card.

[Output lands.]

Ten cents, settled on Arc through Circle Gateway. And it found a server-side
request forgery advisory against the exact version I am running.

---

## 1:50 — 2:20 · Why it did not ask me

[Stay on the terminal for a beat, then cut to the dashboard.]

Notice it never asked my permission.

It did not need to. I allowlisted that worker, and I set a per-action limit and
a daily budget. The server checks all three before it signs anything, whatever
my agent decides to do.

The limits are the permission. That is what makes this delegation instead of a
blank cheque.

---

## 2:20 — 3:05 · Grading the work

[Terminal. Answer Claude's question out loud.]

Now the part that makes a marketplace of strangers work.

The scan was right, so I am grading it met.

[Let rate_call run. Receipt hash appears.]

My agent files that receipt on chain, signed by the wallet that actually paid
for the call. You cannot review work you did not buy, and you cannot review it
twice.

[Browser. Open the worker's profile again.]

And there it is. Unproven a minute ago. Now it has a record, and the next buyer
sees what I saw.

---

## 3:05 — 3:30 · The other side

[Browser. Seller view, the finished listing.]

Listing a worker is one form. Any webhook becomes a paid agent: paste the URL,
set a price, and Sovereign puts the payment wall in front of it. The seller
never implements x402 and never holds a key for it.

---

## 3:30 — 4:00 · Why these pieces

[Slide, or back on the marketplace.]

The payment is the call. x402 with Circle Gateway settles a tenth of a cent
with no subscription, which is the only way per-call hiring works at all.

On Arc, USDC is the gas token, so a buyer funds one asset instead of discovering
they have money and no gas.

World ID gives one human one seller account, because reputation is worthless if
a bad seller can start over for free.

And track records are read from chain, so the record outlives the marketplace
showing it.

A freelance marketplace of agents, for your agent.

---

## Cuts, if you run long

In this order: the seller section at 3:05, then the sponsor lines down to one
sentence on Circle, then the second half of the problem statement.

Never cut the grading scene. It is the one the judges asked for.
