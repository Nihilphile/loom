import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTemplate, TaskType, UnitConfig } from "../shared/types.ts";

export class Catalog {
  agents: AgentTemplate[];
  taskTypes: TaskType[];
  constructor(private file = join(homedir(), ".newharness", "catalog.json")) {
    const unit = (id: string, readOnly = false): UnitConfig => ({
      id,
      name: id,
      kind: "agent",
      templateId: id,
      skills: [],
      prompt:
        id === "reviewer"
          ? "独立审查实现并提供证据。只读代码，返回 approved 或 changes_requested。"
          : "完成任务并验证，通过 CLI 交卷。",
      readOnly,
      context: { goal: true, dependencies: true, previousResult: true },
    });
    this.agents = ["worker", "reviewer", "explorer"].map((id) => ({
      id,
      name: id,
      version: 1,
      skills: [],
      prompt: unit(id).prompt,
      readOnly: id !== "worker",
    }));
    this.taskTypes = [
      {
        id: "direct",
        name: "直接交付",
        version: 1,
        units: [unit("worker")],
        start: ["worker"],
        rules: [
          { from: "worker", outcome: "ready", action: { type: "finish" } },
        ],
        maxRounds: 3,
        maxReportRetries: 2,
      },
      {
        id: "reviewed",
        name: "实现与审查",
        version: 1,
        units: [unit("worker"), unit("reviewer", true)],
        start: ["worker"],
        rules: [
          {
            from: "worker",
            outcome: "ready",
            action: { type: "activate", unit: "reviewer" },
          },
          { from: "reviewer", outcome: "approved", action: { type: "finish" } },
          {
            from: "reviewer",
            outcome: "changes_requested",
            action: { type: "activate", unit: "worker" },
          },
        ],
        maxRounds: 3,
        maxReportRetries: 2,
      },
    ];
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      this.agents = data.agents;
      this.taskTypes = data.taskTypes;
    }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = this.file + ".tmp";
    writeFileSync(
      temp,
      JSON.stringify(
        { agents: this.agents, taskTypes: this.taskTypes },
        null,
        2,
      ),
    );
    renameSync(temp, this.file);
  }
}
