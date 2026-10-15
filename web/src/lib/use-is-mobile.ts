// 断点判定 hook：缺省 <lg（1024px，手机档顶栏/StatusBar 等），可传自定义查询（如
// composer 手机胶囊档 <sm）。订阅 matchMedia change：跨断点（转屏/窗口拉伸）即时
// 重渲染（N3）。本应用无 SSR，window 直接可用（shell.tsx 折叠态初值同款先例）。
// 条件渲染而非 hidden lg:block——CSS 隐藏 DOM 仍在，与"手机档 DOM 不渲染"断言互斥。
import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 1023.98px)";

export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
}
