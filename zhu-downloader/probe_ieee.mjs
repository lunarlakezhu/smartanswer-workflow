// 探针：IEEE Xplore 页面 PDF 按钮实际结构
import { chromium } from 'playwright';

const doi = process.argv[2] || '10.1109/LRA.2023.3322071';

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等动态渲染
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    const found = await page.evaluate(() => {
      const els = [...document.querySelectorAll('a, button')].filter(e =>
        /stamp|getPDF|\.pdf/i.test(e.href || '') || /pdf/i.test(e.textContent || '')
      );
      return els.map(e => {
        const r = e.getBoundingClientRect();
        const style = getComputedStyle(e);
        return {
          tag: e.tagName,
          text: (e.textContent || '').trim().substring(0, 40),
          href: (e.href || '').substring(0, 110),
          visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        };
      });
    });
    console.log(`--- ${(i + 1) * 5}s 时 (${found.length} 个PDF相关元素) ---`);
    found.forEach((e, j) => console.log(`[${j}] ${e.visible ? '✅' : '❌'} <${e.tag}> "${e.text}" ${e.href}`));
    if (found.some(e => e.visible && /stamp|getPDF/i.test(e.href))) { console.log('>>> 找到 stamp/getPDF 链接'); break; }
  }
  console.log('最终URL:', page.url());
  console.log('标题:', await page.title());
} finally {
  await browser.close();
}
