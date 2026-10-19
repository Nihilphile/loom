import { z } from "zod/v4";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const uuid = z.uuid();
const requestId = z.string().trim().min(1).max(200);
const offset = z.int().min(0).max(1_000_000).default(0);
const page = { after: uuid.optional(), limit: z.int().min(1).max(50).default(20) };
const task = z.strictObject({
  id: id.optional(), title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(64_000), deps: z.array(id).max(100), taskTypeId: id,
});

export const controllerCommandSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("connect"), create: z.boolean().default(false),
    title: z.string().trim().min(1).max(200).optional(),
    threadId: z.string().trim().min(1).max(200).optional() }),
  z.strictObject({ op: z.literal("state"), graphId: uuid.optional(), ...page }),
  z.strictObject({ op: z.literal("task_types"), ...page, after: id.optional() }),
  z.strictObject({ op: z.literal("graph_create"), requestId, name: z.string().trim().min(1).max(200),
    tasks: z.array(task).min(1).max(100), concurrency: z.int().min(1).max(8).default(2),
    subscription: z.enum(["blocked", "completed", "review"]).default("completed") }),
  z.strictObject({ op: z.literal("graph_control"), graphId: uuid,
    action: z.enum(["run", "pause", "resume", "resolve"]),
    mode: z.enum(["soft", "hard"]).optional(), taskId: id.optional() }),
  z.strictObject({ op: z.literal("reports"), graphId: uuid, reportId: uuid.optional(), offset, ...page }),
  z.strictObject({ op: z.literal("inbox"), graphId: uuid.optional(), letterId: uuid.optional(),
    includeAcknowledged: z.boolean().default(false), offset, ...page }),
  z.strictObject({ op: z.literal("ack"), graphId: uuid, letterId: uuid }),
  z.strictObject({ op: z.literal("send_feedback"), requestId, graphId: uuid, taskId: id, unitId: id,
    title: z.string().trim().min(1).refine((s) => [...s].length <= 20),
    content: z.string().trim().min(1).max(64_000), mode: z.enum(["auto", "followup", "steer"]).default("followup") }),
]);
export type ControllerCommand = z.infer<typeof controllerCommandSchema>;
export type ControllerOperation = ControllerCommand["op"];
export const controllerDescriptions: Record<ControllerOperation, string> = {
  connect: "Bind the configured free session to Desktop, or explicitly create it. Ownership persists after disconnect.",
  state: "Read bounded summaries of this controller's graphs. Read one graph for task and delivery details.",
  task_types: "List existing TaskTypes available for graph creation. Does not change the catalog.",
  graph_create: "Create a graph from existing TaskTypes and bind it to this controller. Retry with the same requestId.",
  graph_control: "Run, pause, resume or resolve an owned graph. Loom schedules its Units.",
  reports: "List submission references, or read a submission content window by reportId. Reports are not delivery receipts.",
  inbox: "Poll durable controller Letters. Reading never acknowledges or wakes Desktop. Read content by letterId.",
  ack: "Explicitly acknowledge one Letter in its graph. Retrying preserves the first acknowledgement timestamp.",
  send_feedback: "Send bounded inline Mailbox feedback to an agent Unit in an owned graph. Retry with the same requestId.",
};
export class ControllerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function contentWindow(content: string, offset: number) {
  const text = content.slice(offset, offset + 16_000);
  return { content: text, offset, totalLength: content.length,
    nextOffset: offset + text.length < content.length ? offset + text.length : null };
}
export function controllerPage<T extends { id: string }>(items: T[], after: string | undefined, limit: number, include?: (item: T) => boolean) {
  const index = after ? items.findIndex((item) => item.id === after) : -1;
  if (after && index < 0) throw new ControllerError("INVALID_CURSOR", "Cursor is outside this selection", 400);
  const remaining = items.slice(index + 1).filter((item) => !include || include(item));
  const selected = remaining.slice(0, limit);
  return { items: selected, next: remaining.length > limit ? selected.at(-1)?.id : null };
}
