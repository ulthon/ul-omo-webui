/** 滚动事件下的跟随决策（2026-11-25 打开后视角跑上面修复）：scroll 事件本身不再解除
 *  跟随。离底只有两类来源——位置真的往上走（用户滚轮/触摸/回看键/拖滚动条；前三者另有
 *  直接解除通道，scroll 事件兜底同口径）解除；内容变高把视角顶离底部（位置不动、
 *  scrollHeight 涨）或浏览器滚动锚定补位（scrollTop 增大）保持跟随并回底。贴底一律恢复
 *  跟随。此前「离底即解除」把行高晚到（代码高亮、图片、测量修正）都当成用户上滚，
 *  打开会话后视角停在旧位置不再回底（11-24 实测 195 次打开 12 次无输入离底）。 */
export type FollowOnScrollInput = { follow: boolean; atBottom: boolean; movedUp: boolean };
export type FollowOnScrollDecision = { follow: boolean; changed: boolean; repin: boolean };

export function decideFollowOnScroll(input: FollowOnScrollInput): FollowOnScrollDecision {
  if (input.atBottom) return { follow: true, changed: !input.follow, repin: false };
  if (!input.follow) return { follow: false, changed: false, repin: false };
  if (input.movedUp) return { follow: false, changed: true, repin: false };
  return { follow: true, changed: false, repin: true };
}
