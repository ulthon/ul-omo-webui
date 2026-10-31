// boulder-store 单测（暂停/恢复控制面，方案 b）：mtime 缓存读、绑定定位、状态改写、
// 原子写与只改单字段的写面收敛。全走 mkdtemp 隔离目录，不触碰真实 agent 目录。
import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBoulderCacheForTest, getBoundWork, readBoulder, setBoundWorkStatus } from "../src/api/boulder-store";

const tempRoots: string[] = [];
afterEach(() => {
  clearBoulderCacheForTest();
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "boulder-store-"));
  tempRoots.push(dir);
  return dir;
}

const ID = "01a17aca-809a-7984-a8fe-8c286eaf9caf";

function writeBoulder(dir: string, state: unknown): void {
  // mtime 缓存以 mtimeMs 判等：快速连写可能落在同一时间片，测试显式清缓存保证确定性
  clearBoulderCacheForTest();
  mkdirSync(join(dir, ".omo"), { recursive: true });
  writeFileSync(join(dir, ".omo", "boulder.json"), JSON.stringify(state));
}

function boundBoulder(): Record<string, unknown> {
  return {
    schema_version: 2,
    active_work_id: "w",
    works: {
      w: {
        work_id: "w",
        active_plan: ".omo/plans/w.md",
        plan_name: "w-plan",
        session_ids: [`senpi:${ID}`],
        status: "active",
        stale_since: "2026-10-30T00:00:00.000Z",
      },
    },
  };
}

describe("readBoulder：缺失/损坏/形状非法 → null（引擎同语义：视为无 boulder）", () => {
  test("无文件 / 损坏 JSON / 数组 / 非对象 / 空对象边界", async () => {
    const dir = makeProject();
    expect(await readBoulder(dir)).toBeNull();
    writeBoulder(dir, "{not json");
    expect(await readBoulder(dir)).toBeNull();
    writeBoulder(dir, [1, 2]);
    expect(await readBoulder(dir)).toBeNull();
    writeBoulder(dir, '"just a string"');
    expect(await readBoulder(dir)).toBeNull();
    writeBoulder(dir, {});
    expect(await readBoulder(dir)).toEqual({});
  });

  test("mtime 变化后重读拿到新内容（缓存失效）", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    expect(((await readBoulder(dir)) as { active_work_id: string }).active_work_id).toBe("w");
    writeBoulder(dir, { ...boundBoulder(), active_work_id: "changed" });
    expect(((await readBoulder(dir)) as { active_work_id: string }).active_work_id).toBe("changed");
  });

  test("缓存命中：mtime 未变时返回同一解析对象（不重复 parse）", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    const a = await readBoulder(dir);
    const b = await readBoulder(dir);
    expect(b).toBe(a);
  });
});

describe("getBoundWork：绑定定位（与 matchBoundWork 同口径）", () => {
  test("senpi: 前缀精确匹配 + status 透传", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    expect(await getBoundWork(dir, ID)).toEqual({ workId: "w", status: "active" });
  });

  test("无绑定 / 无 works → null；status 缺失 → null", async () => {
    const dir = makeProject();
    writeBoulder(dir, { works: {} });
    expect(await getBoundWork(dir, ID)).toBeNull();
    writeBoulder(dir, { active_work_id: null });
    expect(await getBoundWork(dir, ID)).toBeNull();
    writeBoulder(dir, { works: { w: { session_ids: [`senpi:${ID}`], active_plan: "p.md" } } });
    expect(await getBoundWork(dir, ID)).toEqual({ workId: "w", status: null });
  });
});

describe("setBoundWorkStatus：状态改写与写面收敛", () => {
  test("pause：只改 status，其余字段与其余 work 原样保留", async () => {
    const dir = makeProject();
    const boulder = boundBoulder() as { works: Record<string, Record<string, unknown>> };
    boulder.works.other = { work_id: "other", session_ids: ["senpi:someone-else"], status: "active" };
    writeBoulder(dir, boulder);

    expect(await setBoundWorkStatus(dir, ID, "user_paused")).toEqual({ workId: "w" });
    const raw = JSON.parse(await readFile(join(dir, ".omo", "boulder.json"), "utf8"));
    expect(raw.works.w.status).toBe("user_paused");
    expect(raw.works.w.stale_since).toBe("2026-10-30T00:00:00.000Z"); // pause 不碰 stale_since
    expect(raw.works.other.status).toBe("active");
    expect(raw.schema_version).toBe(2);
  });

  test("resume：改回 active + 清 stale_since + 刷 updated_at", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    expect(await setBoundWorkStatus(dir, ID, "active")).toEqual({ workId: "w" });
    const raw = JSON.parse(await readFile(join(dir, ".omo", "boulder.json"), "utf8"));
    expect(raw.works.w.status).toBe("active");
    expect("stale_since" in raw.works.w).toBe(false);
    expect(typeof raw.works.w.updated_at).toBe("string");
    expect(new Date(raw.works.w.updated_at as string).getTime()).not.toBeNaN();
  });

  test("无绑定 / boulder 缺失 → null（不写盘、不建目录）", async () => {
    const dir = makeProject();
    expect(await setBoundWorkStatus(dir, ID, "user_paused")).toBeNull();
    expect(existsSync(join(dir, ".omo"))).toBe(false);
  });

  test("原子写：不留临时文件（tmp+rename 成功路径）", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    await setBoundWorkStatus(dir, ID, "user_paused");
    const entries = readdirSync(join(dir, ".omo"));
    expect(entries).toEqual(["boulder.json"]);
  });

  test("写后立即可见（自身缓存失效）：连续 pause→resume 不读旧值", async () => {
    const dir = makeProject();
    writeBoulder(dir, boundBoulder());
    await setBoundWorkStatus(dir, ID, "user_paused");
    expect((await getBoundWork(dir, ID))?.status).toBe("user_paused");
    await setBoundWorkStatus(dir, ID, "active");
    expect((await getBoundWork(dir, ID))?.status).toBe("active");
  });

  test("多 work 同绑一会话：active_work_id 优先被改写", async () => {
    const dir = makeProject();
    writeBoulder(dir, {
      active_work_id: "later",
      works: {
        early: { session_ids: [`senpi:${ID}`], active_plan: "a.md", status: "active" },
        later: { session_ids: [`senpi:${ID}`], active_plan: "b.md", status: "active" },
      },
    });
    expect(await setBoundWorkStatus(dir, ID, "user_paused")).toEqual({ workId: "later" });
    const raw = JSON.parse(await readFile(join(dir, ".omo", "boulder.json"), "utf8"));
    expect(raw.works.later.status).toBe("user_paused");
    expect(raw.works.early.status).toBe("active");
  });
});
