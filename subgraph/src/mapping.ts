import {
  AgentRegistered,
  AgentUpdated,
  AgentActivated,
  AgentDeactivated,
} from "../generated/AgentRegistry/AgentRegistry";
import { Agent } from "../generated/schema";

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
