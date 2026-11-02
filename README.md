# xinran.wiki

个人网站：博客、知识库、市场看板。基于 [Astro](https://astro.build)，部署在 Cloudflare。

## 本地开发

```bash
npm install
npm run fetch-data:demo   # 生成示例行情数据（离线预览）
npm run dev               # http://localhost:4321
```

## 写作

- 文章：`src/content/blog/*.md`（可用标签区分主题；改过的文章加 `updated` 日期）
- 字段说明见 `src/content.config.ts`；`draft: true` 的内容不会发布

## 行情看板

- 品种在 `src/data/markets.config.json` 里增删
- `npm run fetch-data` 从 Yahoo Finance 抓取，写入 `src/data/markets.json`
- GitHub Actions（`.github/workflows/update-data.yml`）工作日定时抓取并提交，Cloudflare 随后自动重新构建

## 部署（Cloudflare）

构建命令 `npm run build`，输出目录 `dist`，Node 版本 22。

## 批注

文章页读者可以选中文字写批注，作者在 `/admin/` 管理。部署前需要在 Cloudflare 里配置数据库、验证码和登录保护，步骤见 [docs/批注功能部署说明.md](docs/批注功能部署说明.md)。

## 私人资产页（/me/）

只有站长能看的资产看板：口令登录，数据存在 Cloudflare D1（不进仓库），页面里现算收益、年化、和沪深300 的对比以及操作建议。需要在 Cloudflare 里设置 Secret `ME_PASSWORD`（可选 `ME_UPLOAD_TOKEN`）后重新部署。设置步骤和数据格式见 [docs/私人资产页说明.md](docs/私人资产页说明.md)。
