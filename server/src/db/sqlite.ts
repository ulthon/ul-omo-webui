// node:sqlite 适配层：对齐原 bun:sqlite 在本仓使用到的 API 子集。
// - Database(path, { create }) / exec / run(sql, params) / query(sql).get|all / transaction(fn).immediate / close
// - SQLiteError：node:sqlite 抛的是普通 Error（带 errcode），此处统一包装为本类，
//   消费方（REST 层与测试）按 instanceof SQLiteError 语义不变。
// node:sqlite 要求 node >= 22.5（engines 声明 >= 24）。
import { DatabaseSync } from "node:sqlite";

export type SQLQueryBindings = string | number | bigint | Uint8Array | null;

export class SQLiteError extends Error {
  /** sqlite 原生错误码名（如 SQLITE_BUSY）；无法识别时为 undefined */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "SQLiteError";
    this.code = code;
  }
}

/** node:sqlite 错误 → SQLiteError（errcode 数字映射到 SQLITE_XX 码名尽力而为） */
function normalizeError(err: unknown): unknown {
  if (err instanceof SQLiteError) return err;
  if (err instanceof Error) {
    const e = err as Error & { errcode?: number; code?: string };
    if (typeof e.errcode === "number" || typeof e.code === "string") {
      return new SQLiteError(e.message, typeof e.code === "string" ? e.code : `SQLITE_ERR_${e.errcode}`);
    }
    return new SQLiteError(e.message);
  }
  return err;
}

interface StatementLike {
  get(...params: SQLQueryBindings[]): unknown;
  all(...params: SQLQueryBindings[]): unknown[];
  run(...params: SQLQueryBindings[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  finalize?(): void;
}

export class Database {
  private readonly db: DatabaseSync;
  /** 预编译语句缓存（对齐 bun query() 的缓存语义，热路径免重复 prepare） */
  private readonly stmts = new Map<string, StatementLike>();

  constructor(path: string, _options?: { create?: boolean }) {
    // node:sqlite 缺省 READWRITE|CREATE：文件不存在即创建，与 bun { create: true } 等价
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    try {
      this.db.exec(sql);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  private stmt(sql: string): StatementLike {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql) as unknown as StatementLike;
      this.stmts.set(sql, s);
    }
    return s;
  }

  /** 形态对齐 bun: db.run(sql, params[])（params 为数组，可空） */
  run(sql: string, params: SQLQueryBindings[] = []): void {
    try {
      this.stmt(sql).run(...params);
    } catch (err) {
      throw normalizeError(err);
    }
  }

  query(sql: string): { get(...params: SQLQueryBindings[]): unknown; all(...params: SQLQueryBindings[]): unknown[] } {
    const s = this.stmt(sql);
    return {
      get: (...params: SQLQueryBindings[]) => {
        try {
          return s.get(...params);
        } catch (err) {
          throw normalizeError(err);
        }
      },
      all: (...params: SQLQueryBindings[]) => {
        try {
          return s.all(...params);
        } catch (err) {
          throw normalizeError(err);
        }
      },
    };
  }

  /** 手写事务（node:sqlite 无 bun 的 transaction 包装）：
   * immediate = BEGIN IMMEDIATE ... COMMIT / ROLLBACK。
   * 约束：不得嵌套（本仓全部调用点均为顶层单层，meta.ts 已核实）。 */
  transaction<T>(fn: () => T): { immediate(): T } {
    return {
      immediate: (): T => {
        this.exec("BEGIN IMMEDIATE");
        let result: T;
        try {
          result = fn();
        } catch (err) {
          try {
            this.exec("ROLLBACK");
          } catch {
            // 回滚失败不掩盖业务异常
          }
          throw err;
        }
        this.exec("COMMIT");
        return result;
      },
    };
  }

  close(): void {
    for (const s of this.stmts.values()) {
      try {
        s.finalize?.();
      } catch {
        // 语句已失效
      }
    }
    this.stmts.clear();
    this.db.close();
  }
}
