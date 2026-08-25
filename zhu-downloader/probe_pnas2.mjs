// 探针2：PNAS PDF 获取 — A: 带Referer请求  B: DOM点击触发下载事件
import { chromium } from 'playwright';

const doi = process.argv[2] || '10.1073/pnas.2314359121';

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const pdfUrl = `https://www.pnas.org/doi/pdf/${doi}?download=true`;

  // A: 带 Referer 请求
  console.log('--- A: ctx.request + Referer ---');
  const resp = await ctx.request.get(pdfUrl, { timeout: 60000, headers: { Referer: page.url() } });
  const buf = await resp.body();
  const isPdfA = buf[0] === 0x25 && buf[1] === 0x50;
  console.log('状态:', resp.status(), '| 大小:', (buf.length / 1024).toFixed(0) + 'KB', '| 是PDF:', isPdfA);

  if (!isPdfA) {
    // B: DOM 点击触发下载事件
    console.log('--- B: evaluate(el=>el.click()) ---');
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      page.locator('a#downloadPdfUrl').evaluate(el => el.click()),
    ]);
    if (dl) {
      const p = await dl.path();
      const fs = await import('fs');
      const b = fs.readFileSync(p);
      console.log('下载事件触发 | 建议文件名:', dl.suggestedFilename(), '| 大小:', (b.length / 1024).toFixed(0) + 'KB', '| 是PDF:', b[0] === 0x25 && b[1] === 0x50);
    } else {
      console.log('未触发下载事件');
    }
  }
} finally {
  await browser.close();
}
