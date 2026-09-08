// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Sovereign AgentRegistry
/// @notice On-chain catalog of agents. Metadata lives on-chain (cheap on Arc);
///         The Graph indexes the events below as the fast read layer.
contract AgentRegistry {
    struct Agent {
        address owner;
        address payTo;
        uint256 pricePerCall; // USDC, 6 decimals
        string name;
        string description;
        string tags;      // comma-separated
        string endpoint;  // x402-gated HTTP endpoint
        bool active;
    }

    mapping(string => Agent) public agents; // slug => Agent
    string[] public agentIds;

    // `id` is intentionally NOT indexed so the subgraph receives the readable slug.
    event AgentRegistered(string id, address indexed owner, address payTo, uint256 pricePerCall, string name, string description, string tags, string endpoint);
    event AgentUpdated(string id, address payTo, uint256 pricePerCall, string name, string description, string tags, string endpoint);
    event AgentActivated(string id);
    event AgentDeactivated(string id);

    modifier onlyOwner(string calldata id) {
        require(agents[id].owner == msg.sender, "not owner");
        _;
    }

    function register(
        string calldata id,
        address payTo,
        uint256 pricePerCall,
        string calldata name,
        string calldata description,
        string calldata tags,
        string calldata endpoint
    ) external {
        require(agents[id].owner == address(0), "id taken");
        require(payTo != address(0), "payTo required");
        agents[id] = Agent(msg.sender, payTo, pricePerCall, name, description, tags, endpoint, true);
        agentIds.push(id);
        emit AgentRegistered(id, msg.sender, payTo, pricePerCall, name, description, tags, endpoint);
    }

    function update(
        string calldata id,
        address payTo,
        uint256 pricePerCall,
        string calldata name,
        string calldata description,
        string calldata tags,
        string calldata endpoint
    ) external onlyOwner(id) {
        Agent storage a = agents[id];
        a.payTo = payTo;
        a.pricePerCall = pricePerCall;
        a.name = name;
        a.description = description;
        a.tags = tags;
        a.endpoint = endpoint;
        emit AgentUpdated(id, payTo, pricePerCall, name, description, tags, endpoint);
    }

    function setActive(string calldata id, bool active) external onlyOwner(id) {
        agents[id].active = active;
        if (active) emit AgentActivated(id);
        else emit AgentDeactivated(id);
    }

    function count() external view returns (uint256) {
        return agentIds.length;
    }
}
