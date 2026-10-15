// <lg（1024px）断点判定 hook：手机档顶栏/StatusBar 等按 JS 条件渲染退役的前提
// （不用 hidden lg:block——CSS 隐藏 DOM 仍在，与"手机档 DOM 不渲染"断言互斥）。
// 订阅 matchMedia change：跨断点（转屏/窗口拉伸）即时重渲染（N3）。本应用无 SSR，
// window 直接可用（shell.tsx 折叠态初值同款先例）。
import { useEffect, useState } from "react";

const MOBILE_QUERY = "(max-width: 1023.98px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}
