# task-6 PWA QA 证据 (2026-10-22)

## dist public 资产清单
-rw-r--r-- 1 root root 12853 Oct 22 16:30 web/dist/apple-touch-icon.png
-rw-r--r-- 1 root root   786 Oct 22 16:30 web/dist/manifest.webmanifest

web/dist/icons/:
total 224
drwxr-xr-x 2 root root   4096 Oct 22 16:30 .
drwxr-xr-x 4 root root   4096 Oct 22 16:30 ..
-rw-r--r-- 1 root root  23388 Oct 22 16:30 icon-192.png
-rw-r--r-- 1 root root 109370 Oct 22 16:30 icon-512.png
-rw-r--r-- 1 root root  14503 Oct 22 16:30 icon-maskable-192.png
-rw-r--r-- 1 root root  67949 Oct 22 16:30 icon-maskable-512.png

## 哈希 (sha256)
2cfecaf19f2f91b071f3839934b2624fc018f588f930306d26a9bf97f915f22f  web/dist/assets/index-Bs7Re0LF.js
70a8428040081c0f7f108e4488c36d7387c33cd7d28cb36e9686baaf2f29dd7b  web/dist/manifest.webmanifest
dbb682a6f8e667d6543800157e14b48152094c893b65353ecbceb63484622935  web/dist/icons/icon-192.png
7554c53b5d6f004f129eb88916f3c2c81f0d1cd65fed9cf0dedbe0827c5b2910  web/dist/icons/icon-512.png
53395e65796dc9100ec7bb31b408e2a25bb379504dd5cc47037edd9f2cfcd997  web/dist/icons/icon-maskable-192.png
fe1e3abb4e4fca594f2d9cdd13880b07c29f5990c233016ab670bab1bcc8570c  web/dist/icons/icon-maskable-512.png
9b5fa120d5a236fa2d76074a6f6ed205d45d14b711f725063aedaea71db1f38f  web/dist/apple-touch-icon.png

## curl 输出 (静态伺服 :18923, dist 全量构建)
--- GET /manifest.webmanifest
{
  "name": "ul-omo webui",
  "short_name": "ul-omo",
  "description": "ul-omo webui - 本地会话界面",
  "start_url": "/",
  "display": "standalone",
  "orientation": "any",
  "theme_color": "#0a0a0a",
  "background_color": "#ffffff",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-maskable-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "maskable"
    },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}

--- 图标状态
icons/icon-192.png 200 23388B
icons/icon-512.png 200 109370B
icons/icon-maskable-192.png 200 14503B
icons/icon-maskable-512.png 200 67949B
apple-touch-icon.png 200 12853B
--- index.html PWA 相关标签
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#ffffff" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content" />

## 失败面: 移除 manifest 后页面仍 200 (渐进增强)
page without manifest: 200
manifest absent: 404

## 严格校验
JSON.parse ok; keys: name,short_name,description,start_url,display,orientation,theme_color,background_color,icons

## 待真机验证项
- safe-area-inset-bottom 实际生效 (iOS Safari 真机, viewport-fit=cover 生效后 env() 非 0) — device-verification-pending
