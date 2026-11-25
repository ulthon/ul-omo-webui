// 滚动事件下的跟随决策（2026-11-25 打开后视角跑上面修复）纯函数四态：
// - 贴底 → 恢复跟随（原非跟随时记翻转）；
// - 非跟随且离底 → 保持非跟随（位置往哪走都不改）；
// - 跟随且离底且位置真的往上走（用户回看：滚轮/触摸/回看键/拖滚动条）→ 解除；
// - 跟随且离底且位置没往上走（内容变高把视角顶离底部、浏览器滚动锚定补位）→ 保持跟随并回底。
// 旧实现「离底即解除」落在第四态，把行高晚到当成用户上滚——本修复要消灭的行为。
// 纯函数，无 DOM 依赖。
import { describe, expect, test } from "vitest";
import { decideFollowOnScroll } from "@/components/chat/scroll-follow";

describe("decideFollowOnScroll：scroll 事件下的跟随决策四态", () => {
  test("贴底：一律跟随；原非跟随时记翻转，不回底", () => {
    expect(decideFollowOnScroll({ follow: false, atBottom: true, movedUp: false })).toEqual({
      follow: true,
      changed: true,
      repin: false,
    });
    expect(decideFollowOnScroll({ follow: true, atBottom: true, movedUp: false })).toEqual({
      follow: true,
      changed: false,
      repin: false,
    });
  });

  test("非跟随且离底：保持非跟随，位置往哪走都不改、不回底", () => {
    expect(decideFollowOnScroll({ follow: false, atBottom: false, movedUp: true })).toEqual({
      follow: false,
      changed: false,
      repin: false,
    });
    expect(decideFollowOnScroll({ follow: false, atBottom: false, movedUp: false })).toEqual({
      follow: false,
      changed: false,
      repin: false,
    });
  });

  test("跟随且离底且位置往上走（用户回看）→ 解除跟随", () => {
    expect(decideFollowOnScroll({ follow: true, atBottom: false, movedUp: true })).toEqual({
      follow: false,
      changed: true,
      repin: false,
    });
  });

  test("跟随且离底且位置没往上走（内容变高顶离底部）→ 保持跟随并回底；旧实现在此解除", () => {
    expect(decideFollowOnScroll({ follow: true, atBottom: false, movedUp: false })).toEqual({
      follow: true,
      changed: false,
      repin: true,
    });
  });
});
