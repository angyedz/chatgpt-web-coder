import { describe, expect, it } from "vitest";
import { parseSwarmDecision, swarmOrchestratorPrompt } from "../src/agent/swarm-orchestrator.js";
import type { SubagentSnapshot } from "../src/types.js";

const agents: SubagentSnapshot[] = ["1", "2"].map((id) => ({
  id, role: "Awaiting assignment", objective: "Improve storage", status: "preparing", workspace: "/project/" + id, toolCount: 0, startedAt: 0,
}));
const plan = {
  status: "continue", summary: "Split storage migration and compatibility work.",
  assignments: [
    { id: "1", role: "Migration owner", task: "Implement incremental storage migration with recovery." },
    { id: "2", role: "Compatibility owner", task: "Inspect old data formats and add compatibility handling." },
  ],
};

describe("Swarm orchestrator decisions", () => {
  it("accepts model-selected tasks for the actual requested count", () => {
    expect(parseSwarmDecision("```json\n" + JSON.stringify(plan) + "\n```", agents, true).assignments).toEqual(plan.assignments);
    const prompt = swarmOrchestratorPrompt("Improve storage", agents, true);
    expect(prompt).toContain("AVAILABLE WORKERS: 2");
    expect(prompt).toContain("Worker numbers have no predefined specializations");
    expect(() => parseSwarmDecision(JSON.stringify({ ...plan, assignments: plan.assignments.slice(0, 1) }), agents, true)).toThrow("every requested worker");
    const sequential = { ...plan, assignments: plan.assignments.slice(0, 1), waiting: [{ id: "2", reason: "Wait for the storage format before writing compatibility support." }] };
    expect(parseSwarmDecision(JSON.stringify(sequential), agents, true).waiting).toHaveLength(1);
  });

  it("rejects duplicate IDs, nonexistent workers and reassigning a busy worker", () => {
    expect(() => parseSwarmDecision(JSON.stringify({ ...plan, assignments: [plan.assignments[0], plan.assignments[0]] }), agents, true)).toThrow("distinct");
    expect(() => parseSwarmDecision(JSON.stringify({ ...plan, assignments: [{ ...plan.assignments[0], id: "5" }] }), agents, false)).toThrow("existing");
    expect(() => parseSwarmDecision(JSON.stringify(plan), [{ ...agents[0]!, status: "running" }, agents[1]!], false)).toThrow("running");
  });

  it("requires completed work and resolved conflicts before accepting completion", () => {
    const decision = JSON.stringify({ status: "complete", summary: "Verified migrated files and compatibility results." });
    expect(() => parseSwarmDecision(decision, agents, false)).toThrow("successful workers");
    const done = agents.map((agent) => ({ ...agent, status: "done" as const }));
    expect(parseSwarmDecision(decision, done, false).status).toBe("complete");
    expect(() => parseSwarmDecision(decision, [{ ...done[0]!, conflicts: ["storage.ts"] }, done[1]!], false)).toThrow("conflicts");
    expect(() => parseSwarmDecision(decision, [{ ...done[0]!, queuedInstructions: ["Verify again"] }, done[1]!], false)).toThrow("pending work");
  });

  it("allows a concrete startup blocker and refuses restarting a user-stopped worker", () => {
    const blocked = JSON.stringify({ status: "blocked", summary: "The required source project is not present." });
    expect(parseSwarmDecision(blocked, agents, true).status).toBe("blocked");
    expect(() => parseSwarmDecision(JSON.stringify(plan), [{ ...agents[0]!, status: "stopped" }, agents[1]!], false)).toThrow("stopped");
  });
});
