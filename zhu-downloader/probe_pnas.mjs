// 探针：验证在浏览器上下文内直接请求 PNAS PDF URL 是否可行
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
  console.log('📥 请求:', pdfUrl);
  const resp = await ctx.request.get(pdfUrl, { timeout: 60000 });
  const ct = resp.headers()['content-type'] || '';
  const buf = await resp.body();
  console.log('状态:', resp.status(), '| content-type:', ct, '| 大小:', (buf.length / 1024).toFixed(0) + 'KB');
  console.log('是PDF:', buf[0] === 0x25 && buf[1] === 0x50);
} finally {
  await browser.close();
}
