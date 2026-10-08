import { createHash, randomUUID } from "node:crypto";
import type {
  Preparation,
  ProjectState,
  ResolvedConfig,
  ResolvedContextItem,
  RuntimeAcceptance,
  Session,
} from "../shared/types.ts";

export function contextItem(
  id: string,
  kind: ResolvedContextItem["kind"],
  content: string,
  extra: Partial<ResolvedContextItem> = {},
): ResolvedContextItem {
  return {
    id,
    kind,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    ...extra,
  };
}

export class SessionInputs {
  constructor(private readonly state: ProjectState) {}

  prepare(
    session: Session,
    executionId: string,
    config: ResolvedConfig,
    candidates: ResolvedContextItem[],
    instruction: string,
    steer = false,
  ): Preparation {
    if (
      this.state.preparations.some(
        (p) => p.sessionId === session.id && p.receipt.status === "uncertain",
      )
    )
      throw new Error(
        "存在接收结果未知的输入，请检查运行记录后显式确认，不能自动重发",
      );
    const history = this.state.preparations.filter(
      (p) => p.sessionId === session.id && p.receipt.status === "accepted",
    );
    const accepted = new Map(
      history.flatMap((p) => p.inputs.map((i) => [i.id, i.digest] as const)),
    );
    const inputs = candidates.filter((i) => accepted.get(i.id) !== i.digest);
    const unique = new Set<string>();
    const content = inputs
      .map((i) => {
        if (unique.has(i.digest) && i.kind !== "letter") return "";
        unique.add(i.digest);
        return i.content;
      })
      .filter(Boolean);
    const preparation: Preparation = {
      id: randomUUID(),
      executionId,
      sessionId: session.id,
      mode: steer
        ? "steer"
        : session.acceptedConfig
          ? "continue"
          : "initialize",
      createdAt: new Date().toISOString(),
      config: structuredClone(config),
      inputs: structuredClone(inputs),
      prompt: [...content, instruction].filter(Boolean).join("\n\n"),
      receipt: { status: "prepared" },
    };
    this.state.preparations.push(preparation);
    return preparation;
  }

  accept(
    session: Session,
    preparation: Preparation,
    receipt: RuntimeAcceptance,
  ) {
    preparation.receipt = receipt;
    if (receipt.status !== "accepted") return;
    session.threadId = receipt.threadId;
    if (preparation.mode !== "steer")
      session.acceptedConfig = structuredClone(preparation.config);
  }

  occupiedLetter(sessionId: string, letterId: string): boolean {
    return this.state.preparations.some(
      (p) =>
        p.sessionId === sessionId &&
        p.receipt.status !== "rejected" &&
        p.inputs.some((i) => i.letterId === letterId),
    );
  }
}
