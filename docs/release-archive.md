# 安装包与历史版本

当前手表版本为 **1.0.10 / 11**，修复动作单列表无法上下滑动。安卓侧配套沿用 1.0.8 修复 APK（显示版本 1.4.3，内部版本号 30）。两端沿用原正式签名。手表 1.0.9 / 10、1.0.8 / 9 及 1.0.7 安装包保存在本机各自目录。[下载 1.0.10 正式签名 RPK](https://raw.githubusercontent.com/nine-orders/openGym_REDMIWatch/e76842b28d59491e3a7860058882f690ddcf50fa/astrobox/openGym-RedmiWatch5-LTNS-1.0.10.rpk) · [首页实施记录](watch-home-v4-20261126.md) · [手机同步修复记录](phone-sync-fix-20261126.md)

开炼 1.0.10 已按免费快应用提交 AstroBox 官方源审核，适配红米 Watch 5（`xmrw5`）。[资源清单](https://github.com/nine-orders/openGym_REDMIWatch/blob/e76842b28d59491e3a7860058882f690ddcf50fa/manifest_v2.json) · [AstroBox 审核 PR #2493](https://github.com/AstralSightStudios/AstroBox-Repo/pull/2493)

## 历史归档

2026-11-26 将以下旧版产物归入本机 `watch-app/dist/archive/`。原包、对应预览图和发布清单一起保留。21 个迁移文件逐一核对了 SHA-256。

| 版本 | 归档目录 | 内容 |
|---|---|---|
| 1.0.0 调试稿 | `astrobox-debug-1.0.0/` | 原仓库根目录的 AstroBox 清单、调试 RPK、预览图和清单所需图标副本 |
| 1.0.0 正式稿 | `astrobox-release-1.0.0/` | 正式 APK 和 RPK、AstroBox 清单、图标与预览图 |
| 1.0.1 | `phone-pairing-test-1.0.1/` | 手机配对测试 RPK |
| 1.0.2 | `phone-auto-pairing-test-1.0.2/` | 手机自动配对测试 RPK |
| 1.0.3 | `pairing-ux-test-1.0.3/` | 配对界面测试 RPK 和预览 |
| 1.0.4 | `pairing-ux-test-1.0.4/` | 配对界面测试 RPK 和预览 |
| 1.0.5 | `routine-picker-test-1.0.5/` | 动作单选择测试 RPK 和预览 |
| 1.0.6 | `weight-display-test-1.0.6/` | 重量显示测试 RPK 和预览，手机同步故障排查时实际使用的手表包 |

`watch-app/dist/` 是 Git 忽略的本机产物目录。历史 AstroBox 调试稿的清单使用归档目录内的相对路径。需要回查之前的目录结构时，七个历史版本目录原位于 `watch-app/dist/`，调试稿的 `manifest_v2.json` 和 `astrobox/` 原位于仓库根目录。
