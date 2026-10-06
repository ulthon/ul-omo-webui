import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { LoginPage } from "@/pages/login";
import { AppShell } from "@/pages/shell";

// 极简路由：/login 登录页，其余回落主布局（server 侧 SPA fallback 保证任意路径拿到 index.html）。
// docs/02 依赖清单无路由库，两页场景不引入外部 router。
const path = window.location.pathname;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{path === "/login" ? <LoginPage /> : <AppShell />}</StrictMode>,
);
