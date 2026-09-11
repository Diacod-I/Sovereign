import {
  AgentRegistered,
  AgentUpdated,
  AgentActivated,
  AgentDeactivated,
} from "../generated/AgentRegistry/AgentRegistry";
import { BigInt } from "@graphprotocol/graph-ts";
import { ReceiptFiled } from "../generated/Receipts/Receipts";
import { Verified } from "../generated/Verifications/Verifications";
import { Agent, AgentBuyer, Receipt, Verification } from "../generated/schema";

export function handleAgentRegistered(e: AgentRegistered): void {
  let a = new Agent(e.params.id);
  a.owner = e.params.owner;
  a.payTo = e.params.payTo;
  a.pricePerCall = e.params.pricePerCall;
  a.name = e.params.name;
  a.description = e.params.description;
  a.tags = e.params.tags;
  a.endpoint = e.params.endpoint;
  a.active = true;
  a.createdAt = e.block.timestamp;
  a.updatedAt = e.block.timestamp;
  // Track record starts empty — every worker begins unproven.
  a.receiptCount = 0;
  a.deliveredCount = 0;
  a.metScore = 0;
  a.totalPaid = BigInt.zero();
  a.latencyTotalMs = BigInt.zero();
  a.distinctBuyers = 0;
  a.repeatBuyers = 0;
  a.save();
}

export function handleAgentUpdated(e: AgentUpdated): void {
  let a = Agent.load(e.params.id);
  if (a == null) return;
  a.payTo = e.params.payTo;
  a.pricePerCall = e.params.pricePerCall;
  a.name = e.params.name;
  a.description = e.params.description;
  a.tags = e.params.tags;
  a.endpoint = e.params.endpoint;
  a.updatedAt = e.block.timestamp;
  a.save();
}

export function handleAgentActivated(e: AgentActivated): void {
  let a = Agent.load(e.params.id);
  if (a == null) return;
  a.active = true;
  a.updatedAt = e.block.timestamp;
  a.save();
}

export function handleAgentDeactivated(e: AgentDeactivated): void {
  let a = Agent.load(e.params.id);
  if (a == null) return;
  a.active = false;
  a.updatedAt = e.block.timestamp;
  a.save();
}

/**
 * A paid call, graded by the buyer against the expectation they stated first.
 *
 * Aggregates roll forward onto the Agent so a profile is one read. A receipt for
 * an agent this subgraph has never seen is dropped rather than creating a stub —
 * a score attached to no listing would be unreadable in the UI and is more
 * likely a bad agentId than a real call.
 */
export function handleReceiptFiled(e: ReceiptFiled): void {
  let agentId = e.params.agentId;
  let agent = Agent.load(agentId);
  if (agent == null) return;

  let r = new Receipt(e.params.receiptId.toString());
  r.agent = agentId;
  r.agentId = agentId;
  r.buyer = e.params.buyer;
  r.settlementRef = e.params.settlementRef;
  r.amount = e.params.amount;
  r.latencyMs = e.params.latencyMs.toI32();
  r.delivered = e.params.delivered;
  r.met = e.params.met;
  r.expectation = e.params.expectation;
  r.note = e.params.note;
  r.at = e.params.at;
  r.block = e.block.number;
  r.tx = e.transaction.hash;
  r.save();

  agent.receiptCount = agent.receiptCount + 1;
  if (e.params.delivered) agent.deliveredCount = agent.deliveredCount + 1;
  agent.metScore = agent.metScore + e.params.met;
  agent.totalPaid = agent.totalPaid.plus(e.params.amount);
  agent.latencyTotalMs = agent.latencyTotalMs.plus(
    BigInt.fromI32(e.params.latencyMs.toI32())
  );
  agent.lastHiredAt = e.params.at;

  // Distinct vs repeat buyers. A second call from the same buyer is what
  // separates "someone tried it once" from "someone relies on it".
  let key = agentId + "-" + e.params.buyer.toHexString();
  let ab = AgentBuyer.load(key);
  if (ab == null) {
    ab = new AgentBuyer(key);
    ab.agent = agentId;
    ab.buyer = e.params.buyer;
    ab.calls = 0;
    ab.firstAt = e.params.at;
    agent.distinctBuyers = agent.distinctBuyers + 1;
  }
  ab.calls = ab.calls + 1;
  ab.lastAt = e.params.at;
  ab.save();

  if (ab.calls == 2) agent.repeatBuyers = agent.repeatBuyers + 1;

  agent.save();
}

// One human, one account. The contract already refuses a second account for the
// same nullifier, so this only ever writes a fresh row -- but it is written as an
// upsert anyway, because a subgraph that silently drops a re-index is worse than
// one that overwrites identical data.
export function handleVerified(e: Verified): void {
  let id = e.params.account.toHexString();
  let v = Verification.load(id);
  if (v == null) v = new Verification(id);
  v.account = e.params.account;
  v.nullifier = e.params.nullifier;
  v.level = e.params.level;
  v.at = BigInt.fromU64(e.params.at);
  v.block = e.block.number;
  v.tx = e.transaction.hash;
  v.save();
}
