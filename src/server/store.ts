import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  realpathSync,
  statSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { HarnessEvent, ProjectState } from "../shared/types.ts";
import { projectIdentity } from "./project-path.ts";

export class ProjectStore {
  readonly root: string;
  private db: DatabaseSync;
  private lock: string;
  constructor(root: string) {
    this.root = realpathSync(root);
    if (!statSync(this.root).isDirectory())
      throw new Error("项目路径必须是目录");
    for (const dir of ["", ".session", "taskgraph", "reports"])
      mkdirSync(join(this.root, ".newharness", dir), { recursive: true });
    this.lock = join(this.root, ".newharness", "owner.lock");
    try {
      writeFileSync(this.lock, String(process.pid), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("项目锁损坏，请检查 .newharness/owner.lock");
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("此项目已由另一个 Harness 服务打开");
      unlinkSync(this.lock);
      writeFileSync(this.lock, String(process.pid), { flag: "wx" });
    }
    this.db = new DatabaseSync(join(this.root, ".newharness", "state.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)",
    );
  }
  load(): ProjectState {
    const row = this.db.prepare("SELECT value FROM state WHERE id=1").get();
    if (row) {
      const state = JSON.parse(String(row.value)) as ProjectState;
      state.project = { ...state.project, ...projectIdentity(this.root) };
      return state;
    }
    return {
      version: 1,
      project: { ...projectIdentity(this.root), name: basename(this.root) },
      sessions: [],
      graphs: [],
      letters: [],
      executions: [],
    };
  }
  save(
    state: ProjectState,
    event?: Omit<HarnessEvent, "id">,
  ): HarnessEvent | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(state));
      let saved: HarnessEvent | undefined;
      if (event) {
        const result = this.db
          .prepare("INSERT INTO events(value) VALUES(?)")
          .run(JSON.stringify(event));
        saved = { ...event, id: Number(result.lastInsertRowid) };
      }
      this.db.exec("COMMIT");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  events(
    filter: { sessionId?: string; graphId?: string; after?: number } = {},
  ): HarnessEvent[] {
    const ascending = !!filter.after;
    const rows = this.db
      .prepare(
        `SELECT id,value FROM events WHERE id>? AND (? IS NULL OR json_extract(value,'$.sessionId')=?) AND (? IS NULL OR json_extract(value,'$.graphId')=?) ORDER BY id ${ascending ? "ASC" : "DESC"} LIMIT 2000`,
      )
      .all(
        filter.after || 0,
        filter.sessionId ?? null,
        filter.sessionId ?? null,
        filter.graphId ?? null,
        filter.graphId ?? null,
      );
    if (!ascending) rows.reverse();
    return rows.map(
      (row) =>
        ({
          ...JSON.parse(String(row.value)),
          id: Number(row.id),
        }) as HarnessEvent,
    );
  }
  close() {
    this.db.close();
    unlinkSync(this.lock);
  }
}
