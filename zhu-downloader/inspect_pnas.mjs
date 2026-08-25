// 诊断：检查 PNAS 页面上 "Download PDF" 相关元素的实际状态
import { chromium } from 'playwright';

const doi = process.argv[2] || '10.1073/pnas.2314359121';

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

console.log('页面URL:', page.url());
console.log('页面标题:', await page.title());

// 列出所有含 "Download PDF" 或 PDF 相关的链接/按钮
const info = await page.evaluate(() => {
  const els = [...document.querySelectorAll('a, button')].filter(e =>
    /pdf/i.test(e.textContent || '') || /pdf/i.test(e.className || '') || /pdf/i.test(e.href || '')
  );
  return els.map(e => {
    const r = e.getBoundingClientRect();
    const style = getComputedStyle(e);
    return {
      tag: e.tagName,
      text: (e.textContent || '').trim().substring(0, 50),
      href: (e.href || '').substring(0, 100),
      cls: (e.className || '').substring(0, 60),
      visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    };
  });
});

console.log(`\n找到 ${info.length} 个 PDF 相关元素:`);
info.forEach((e, i) => console.log(`[${i}] ${e.visible ? '✅可见' : '❌隐藏'} <${e.tag}> "${e.text}" href=${e.href} cls=${e.cls} rect=${e.rect}`));

await browser.close();
