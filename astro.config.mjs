import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://xinran.wiki',
  integrations: [sitemap()],
  redirects: { '/notes/': '/blog/' },
  markdown: { shikiConfig: { // 深色为默认：把深色主题放在“light”位（内联默认色），浅色主题放在“dark”位（存进 --shiki-dark）
    themes: { light: 'github-dark', dark: 'github-light' } } },
});
