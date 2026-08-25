// 统一文献下载工具 — 支持 Nature/PNAS/Science/IEEE
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DOI = process.argv[2];
const OUT_DIR = process.argv[3] || 'E:\\Qoder files\\download study';

if (!DOI) {
  console.log('用法: node pw_download.mjs <DOI> [输出目录]');
  console.log('示例: node pw_download.mjs 10.1038/nature14539');
  console.log('      node pw_download.mjs 10.1109/LRA.2022.3147245 E:\\Papers');
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`\n📄 ${DOI}`);
console.log(`📁 ${OUT_DIR}\n`);

// ====== 步骤1：识别出版商 ======
const resolveUrl = await (await fetch(`https://doi.org/${DOI}`, { 
  redirect: 'manual',
  headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' }
})).headers.get('location') || '';

const url = resolveUrl.toLowerCase();
console.log(`🔗 ${resolveUrl?.substring(0, 80)}`);

let publisher = 'unknown';
if (url.includes('nature.com')) publisher = 'nature';
else if (url.includes('pnas.org')) publisher = 'pnas';
else if (url.includes('science.org')) publisher = 'science';
else if (url.includes('ieeexplore.ieee.org')) publisher = 'ieee';
else if (url.includes('sciencedirect.com')) publisher = 'elsevier';
else if (url.includes('sagepub.com') || url.includes('cnpereading.com')) publisher = 'sage';

console.log(`🏷️ 出版商: ${publisher.toUpperCase()}`);

// ====== 日志 ======
const LOG = path.join(OUT_DIR, 'download.log');
const logEntry = (doi, pub, status, detail = '') => {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  const line = `[${ts}] ${doi} → ${pub.toUpperCase()} → ${status} ${detail}`;
  console.log(`  📝 ${line}`);
  fs.appendFileSync(LOG, line + '\n');
};

// ====== 步骤2：按出版商分发 ======
const start = Date.now();

try {
  switch (publisher) {
    case 'nature': await downloadNature(DOI, url, resolveUrl, OUT_DIR, start); break;
    case 'pnas':  await downloadPNAS(DOI, OUT_DIR, start); break;
    case 'science': await downloadScience(DOI, OUT_DIR, start); break;
    case 'ieee':  await downloadIEEE(DOI, OUT_DIR, start); break;
    case 'elsevier':
      console.log('⚠️ Elsevier 需要人工通过Cloudflare验证');
      console.log('   已打开Edge，请手动点击PDF并下载，完成后回复');
      execSync(`start msedge "${resolveUrl}"`, { stdio: 'ignore' });
      logEntry(DOI, 'elsevier', '需人工', 'Cloudflare验证');
      break;
    case 'sage':  await downloadSAGE(DOI, OUT_DIR, start); break;
    default:
      console.log(`❌ 不支持的出版商: ${publisher}`);
  }
} catch(e) {
  console.log(`❌ 下载失败: ${e.message}`);
  logEntry(DOI, publisher, '失败', e.message.substring(0, 80));
}

// ====== Nature: PowerShell 直下 ======
async function downloadNature(doi, lowUrl, fullUrl, outDir, start) {
  // Nature PDF URL: article-page-url + .pdf
  const articleId = (fullUrl || lowUrl).match(/articles\/([^/?]+)/)?.[1];
  if (!articleId) throw new Error('无法解析Nature文章ID');
  
  const pdfUrl = `https://www.nature.com/articles/${articleId}.pdf`;
  console.log(`📥 PowerShell: ${pdfUrl.substring(0, 70)}...`);
  
  const out = path.join(outDir, `${sanitize(doi)}.pdf`);
  const ps = `$wc=New-Object System.Net.WebClient;$wc.Headers.Add('User-Agent','Mozilla/5.0 Chrome/120');$wc.DownloadFile('${pdfUrl}','${out}')`;
  execSync(`powershell -Command "${ps}"`, { timeout: 30000, stdio: 'pipe' });

  if (isPdfFile(out)) { verify(out, start); return; }

  // 付费内容：nature.com 先做 cookie 检查，无 cookie 的裸请求被重定向回 HTML 文章页
  // (error=cookies_not_supported)，根本到不了 IP 鉴权。换带 cookie jar 的 curl 重试。
  console.log('🍪 被cookie检查弹回HTML，带cookie重试...');
  const jar = path.join(outDir, '.nature_cookies.txt');
  execSync(`curl -sL -c "${jar}" -b "${jar}" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" -o "${out}" "${pdfUrl}"`, { timeout: 60000, stdio: 'pipe' });
  fs.rmSync(jar, { force: true });

  verify(out, start);
}

function isPdfFile(file) {
  if (!fs.existsSync(file)) return false;
  const h = Buffer.alloc(4);
  fs.readSync(fs.openSync(file, 'r'), h, 0, 4, 0);
  return h[0] === 0x25 && h[1] === 0x50;
}

// ====== PNAS: Playwright 点击 PDF 按钮 ======
async function downloadPNAS(doi, outDir, start) {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    console.log('🌐 打开DOI...');
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    console.log('🖱️ 点击 Download PDF...');
    // a#downloadPdfUrl 是页面规范元素；物理点击会被遮罩拦截，直接请求 PDF 端点返回 403，
    // 必须用 DOM click 走真实下载事件
    await page.waitForSelector('a#downloadPdfUrl', { timeout: 15000 });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      page.locator('a#downloadPdfUrl').evaluate(el => el.click()),
    ]);

    if (dl) {
      const out = path.join(outDir, `${sanitize(doi)}.pdf`);
      await dl.saveAs(out);
      verify(out, start);
    } else {
      console.log('❌ 未触发下载');
    }
  } finally {
    await browser.close();
  }
}

// ====== Science: Playwright reader页面 + get_app ======
async function downloadScience(doi, outDir, start) {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    console.log('🌐 打开 reader...');
    await page.goto(`https://www.science.org/doi/reader/${doi}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000);

    console.log('🖱️ 点击 get_app...');
    await page.waitForSelector('a[href*="/doi/pdf/"][href*="download=true"]', { timeout: 15000 });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      page.click('a[href*="/doi/pdf/"][href*="download=true"]'),
    ]);

    if (dl) {
      const out = path.join(outDir, `${sanitize(doi)}.pdf`);
      await dl.saveAs(out);
      verify(out, start);
    } else {
      console.log('❌ 未触发下载');
    }
  } finally {
    await browser.close();
  }
}

// ====== IEEE: Playwright route.fetch (timeout:0) ======
async function downloadIEEE(doi, outDir, start) {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    let pdf = null;

    await page.route('**/getPDF.jsp*', async route => {
      try {
        const r = await route.fetch({ timeout: 0 });
        if (r.headers()['content-type']?.includes('pdf')) {
          pdf = Buffer.from(await r.body());
          await route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
          return;
        }
      } catch(e) {}
      await route.continue();
    });

    console.log('🌐 打开DOI...');
    // IEEE 页面后台请求不断，networkidle 永不满足；改用 domcontentloaded
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    console.log('🖱️ 点击 PDF...');
    await page.waitForSelector('a[href*="/stamp/"]', { timeout: 30000 });
    await page.click('a[href*="/stamp/"]');

    console.log('⏳ 下载中(IEEE较慢)...');
    for (let i = 0; i < 120 && !pdf; i++) await page.waitForTimeout(1000);

    if (pdf && pdf[0] === 0x25) {
      const out = path.join(outDir, `${sanitize(doi)}.pdf`);
      fs.writeFileSync(out, pdf);
      verify(out, start);
    } else {
      console.log(`❌ ${pdf ? pdf.length + 'B非PDF' : '超时'}`);
    }

    await page.unrouteAll({ behavior: 'ignoreErrors' });
  } finally {
    await browser.close();
  }
}

// ====== SAGE (cnpereading 代理): 点击 PDF 按钮 ======
async function downloadSAGE(doi, outDir, start) {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

    console.log('🌐 打开DOI...');
    await page.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);

    console.log('🖱️ 点击 PDF...');
    await page.waitForSelector('text=PDF', { timeout: 15000 });

    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      page.click('text=PDF'),
    ]);

    if (dl) {
      const out = path.join(outDir, `${sanitize(doi)}.pdf`);
      await dl.saveAs(out);
      verify(out, start);
    } else {
      console.log('❌ 未触发下载');
    }
  } finally {
    await browser.close();
  }
}

// ====== 辅助 ======
function verify(file, start, doi = DOI, pub = publisher) {
  if (!fs.existsSync(file)) { console.log('❌ 文件不存在'); logEntry(doi, pub, '失败', '文件未生成'); return false; }
  const s = fs.statSync(file);
  const h = Buffer.alloc(4);
  fs.readSync(fs.openSync(file, 'r'), h, 0, 4, 0);
  const ok = h[0] === 0x25 && h[1] === 0x50;
  const kb = (s.size/1024).toFixed(0);
  const sec = ((Date.now()-start)/1000).toFixed(1);
  console.log(`\n${ok ? '🎉 成功' : '❌ 无效'} ${path.basename(file)} ${kb}KB ${sec}s`);
  logEntry(doi, pub, ok ? '成功' : '无效', `${kb}KB ${sec}s`);
  return ok;
}

function sanitize(doi) {
  return doi.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 80);
}
