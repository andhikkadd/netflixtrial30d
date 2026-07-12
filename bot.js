const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { chromium } = require('playwright');
const crypto = require('crypto');

// File paths
const CONFIG_FILE = path.join(__dirname, 'config.json');
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const USERS_DB = path.join(__dirname, 'db_users.json');
const VOUCHERS_DB = path.join(__dirname, 'db_vouchers.json');

// Load configurations
if (!fs.existsSync(CONFIG_FILE)) {
  console.error('❌ File config.json tidak ditemukan!');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));

if (config.botToken === 'PASTE_YOUR_BOT_TOKEN_HERE' || !config.botToken) {
  console.error('❌ Silakan masukkan botToken Anda di config.json sebelum menjalankan bot!');
  process.exit(1);
}

// Initialize SQLite Database
const Database = require('better-sqlite3');
const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);

// Create tables if they do not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT,
    credits INTEGER DEFAULT 0,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    code TEXT PRIMARY KEY,
    credits INTEGER,
    used INTEGER DEFAULT 0,
    used_by TEXT,
    used_at TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Initialize default settings
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('maintenance', 'false');

// Helper settings functions
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (err) {
    console.error('Gagal mengambil setting:', err);
    return null;
  }
}

function setSetting(key, value) {
  try {
    db.prepare('INSERT INTO settings (key, value) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value.toString(), value.toString());
  } catch (err) {
    console.error('Gagal menyimpan setting:', err);
  }
}

// Migration helper: Migrate JSON to SQLite on startup if old JSON files exist
if (fs.existsSync(USERS_DB)) {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_DB, 'utf-8'));
    const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, username, credits, created_at) VALUES (?, ?, ?, ?)');
    const transaction = db.transaction((data) => {
      for (const [userId, val] of Object.entries(data)) {
        insertUser.run(userId, val.username || 'User', val.credits || 0, val.createdAt || new Date().toISOString());
      }
    });
    transaction(users);
    fs.renameSync(USERS_DB, USERS_DB + '.bak');
    console.log('✅ Berhasil memigrasi db_users.json ke SQLite.');
  } catch (err) {
    console.error('⚠️ Gagal memigrasi db_users.json:', err);
  }
}

if (fs.existsSync(VOUCHERS_DB)) {
  try {
    const vouchers = JSON.parse(fs.readFileSync(VOUCHERS_DB, 'utf-8'));
    const insertVoucher = db.prepare('INSERT OR IGNORE INTO vouchers (code, credits, used, used_by, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction((data) => {
      for (const [code, val] of Object.entries(data)) {
        insertVoucher.run(
          code,
          val.credits || 0,
          val.used ? 1 : 0,
          val.usedBy ? val.usedBy.toString() : null,
          val.usedAt || null,
          val.createdAt || new Date().toISOString()
        );
      }
    });
    transaction(vouchers);
    fs.renameSync(VOUCHERS_DB, VOUCHERS_DB + '.bak');
    console.log('✅ Berhasil memigrasi db_vouchers.json ke SQLite.');
  } catch (err) {
    console.error('⚠️ Gagal memigrasi db_vouchers.json:', err);
  }
}

// Bot Instance
const bot = new Telegraf(config.botToken);

// Rate-limiting store for brute force protection
const failedAttempts = {};

// User states for wizards/prompts
const userStates = {};

// Middleware to register users in DB when they interact & handle maintenance mode
bot.use((ctx, next) => {
  if (ctx.from) {
    const userId = ctx.from.id.toString();
    const username = ctx.from.username || ctx.from.first_name || 'User';

    // Log interaksi ke console agar admin bisa tahu ID mereka dengan mudah
    console.log(`🔔 Interaksi dari: ${ctx.from.first_name} (@${ctx.from.username || 'no_username'}) | ID Telegram: ${userId}`);

    // SQLite upsert: Insert user if not exists, otherwise update username
    db.prepare(`
      INSERT INTO users (id, username, credits, created_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(id) DO UPDATE SET username = ?
    `).run(userId, username, new Date().toISOString(), username);

    // Cek Mode Maintenance (kecuali untuk admin)
    const isMaintenance = getSetting('maintenance') === 'true';
    const isAdminUser = userId === config.adminId.toString();

    if (isMaintenance && !isAdminUser) {
      return ctx.replyWithMarkdown(`
⚠️ *BOT MAINTENANCE* ⚠️
━━━━━━━━━━━━━━━━━━━━━━━━━━
Maaf, bot saat ini sedang dalam pemeliharaan (maintenance) / pembaruan sistem oleh Admin.

Silakan coba lagi beberapa saat lagi ya. Terima kasih!
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
    }
  }
  return next();
});

// Middleware: Deteksi status wizard
bot.use((ctx, next) => {
  if (ctx.message && ctx.message.text) {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id.toString();

    // Batalkan state jika user mengetik /cancel
    if (text === '/cancel') {
      if (userStates[userId]) {
        delete userStates[userId];
        return ctx.reply('❌ Perintah telah dibatalkan.');
      }
    }

    // Batalkan state jika user mengklik command atau tombol menu utama apa pun
    if (text.startsWith('/') || ['🎬 Buat Akun Netflix', '🔑 Redeem Voucher', '🪙 Cek Kredit', '🛒 Beli Kredit', 'ℹ️ Bantuan'].includes(text)) {
      delete userStates[userId];
      return next();
    }

    // 1. Deteksi State Menunggu Email
    if (userStates[userId] === 'WAITING_FOR_EMAIL') {
      // Validasi format email sederhana
      if (!text.includes('@')) {
        return ctx.replyWithMarkdown(`
❌ *Format Email Salah*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Format email yang kamu kirim ga valid. 

Tolong kirim ulang email yang benar ya (contoh: \`emailkamu@gmail.com\`):
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
      }
      delete userStates[userId];
      return addToTrialQueue(ctx, text);
    }

    // 2. Deteksi State Menunggu Voucher
    if (userStates[userId] === 'WAITING_FOR_VOUCHER') {
      delete userStates[userId];
      return redeemCode(ctx, text);
    }

    // 3. Admin: Deteksi State Menunggu Pesan Broadcast
    if (userStates[userId] === 'ADMIN_WAITING_FOR_BC') {
      delete userStates[userId];
      return handleAdminBroadcast(ctx, text);
    }

    // 4. Admin: Deteksi State Menunggu Nominal Bagi Kredit ke Semua
    if (userStates[userId] === 'ADMIN_WAITING_FOR_GIVEALL') {
      delete userStates[userId];
      return handleAdminGiveAll(ctx, text);
    }
  }
  return next();
});

// Helper: Get user details
function getUser(userId) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId.toString());
  if (row) {
    return {
      username: row.username,
      credits: row.credits,
      createdAt: row.created_at
    };
  }
  return { credits: 0 };
}

// Helper: Update user credits
function updateUserCredits(userId, amount) {
  const uId = userId.toString();
  const user = db.prepare('SELECT credits FROM users WHERE id = ?').get(uId);
  if (user) {
    let newCredits = user.credits + amount;
    if (newCredits < 0) newCredits = 0;
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(newCredits, uId);
    return newCredits;
  }
  return 0;
}

// Commands: /start & /help
bot.start((ctx) => {
  const user = getUser(ctx.from.id);
  const welcomeMessage = `
⚡ *Netflix Auto Trial 30D* ⚡
━━━━━━━━━━━━━━━━━━━━━━━━━━
Bot buat akun Netflix Premium 30 Hari instan pake email kamu sendiri! Bebas domain apa aja.

💳 *SALDO KAMU:*
• Saldo Kredit: \`${user.credits} CR\` (1 CR = 1 Akun)
• ID Telegram: \`${ctx.from.id}\`
━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  ctx.replyWithMarkdown(welcomeMessage, Markup.keyboard([
    ['🎬 Buat Akun Netflix'],
    ['🔑 Redeem Voucher', '🪙 Cek Kredit'],
    ['🛒 Beli Kredit', 'ℹ️ Bantuan']
  ]).resize());
});

// Reply Keyboard Button Handlers
bot.hears('🎬 Buat Akun Netflix', (ctx) => {
  const userId = ctx.from.id.toString();
  const user = getUser(ctx.from.id);

  if (user.credits <= 0) {
    return ctx.replyWithMarkdown(`
❌ *Saldo Kredit Habis*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Saldo kamu saat ini \`0 CR\`. 

Kamu bisa membeli kredit secara otomatis 24/7 melalui Bot Auto-Order kami di:
👉 @tuntungpedia\\_bot

Setelah mendapat kode voucher, masukkan di menu *🔑 Redeem Voucher* ya!
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  }

  userStates[userId] = 'WAITING_FOR_EMAIL';
  ctx.replyWithMarkdown(`
🎬 *BUAT AKUN NETFLIX*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Kirimlkan email kamu di sini ya:

━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

bot.hears('🔑 Redeem Voucher', (ctx) => {
  const userId = ctx.from.id.toString();
  userStates[userId] = 'WAITING_FOR_VOUCHER';
  ctx.replyWithMarkdown(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔑 *REDEEM VOUCHER*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Kirim kode voucher kamu di sini ya:
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

bot.hears('🪙 Cek Kredit', (ctx) => {
  const user = getUser(ctx.from.id);
  ctx.replyWithMarkdown(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 *SALDO KREDIT*
━━━━━━━━━━━━━━━━━━━━━━━━━━
• ID Telegram: \`${ctx.from.id}\`
• Saldo Kamu: \`${user.credits} CR\`
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

bot.hears('🛒 Beli Kredit', (ctx) => {
  ctx.replyWithMarkdown(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
🛒 *BELI KREDIT (24/7)*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Kamu bisa membeli kredit secara otomatis 24/7 melalui Bot Auto-Order kami di:
👉 @tuntungpedia\\_bot
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

bot.hears('ℹ️ Bantuan', (ctx) => {
  ctx.replyWithMarkdown(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
ℹ️ *PANDUAN BOT*
━━━━━━━━━━━━━━━━━━━━━━━━━━
*1. Cara Beli Kredit*
Klik menu *🛒 Beli Kredit*, silakan beli lewat Bot Auto-Order kami, lalu kembali ke bot ini untuk redeem kodenya.

*2. Cara Redeem Kode*
Klik menu *🔑 Redeem Voucher* dan kirim kode voucher yang sudah Anda beli.

*3. Cara Buat Akun Netflix*
Pastikan kamu punya minimal \`1 CR\`. Klik menu *🎬 Buat Akun Netflix*, kirim email kamu, lalu tunggu bot selesai memproses.
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

bot.command(['help', 'bantuan'], (ctx) => {
  ctx.replyWithMarkdown(`
━━━━━━━━━━━━━━━━━━━━━━━━━━
ℹ️  *PANDUAN BANTUAN & SUPPORT*  ℹ️
━━━━━━━━━━━━━━━━━━━━━━━━━━
*1. Bagaimana cara membeli kredit?*
Anda bisa membeli kredit secara otomatis 24/7 melalui Bot Auto-Order di:
👉 @tuntungpedia\\_bot

*2. Bagaimana cara redeem kode?*
Ketik perintah berikut:
\`\`/redeem NF-XXXXX-XXXXX\`\`

*3. Bagaimana cara generate trial Netflix?*
Pastikan saldo Anda minimal \`1 CR\`. Ketik perintah berikut:
\`\`/trial emailanda@domain.com\`\`

*Kontak Support:*
💬 Hubungi Admin jika Anda mengalami kendala teknis.
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

// Command: /kredit or /balance
bot.command(['kredit', 'balance'], (ctx) => {
  const user = getUser(ctx.from.id);
  ctx.replyWithMarkdown(`🪙 Saldo Kredit Anda saat ini: \`${user.credits} CR (Credit)\``);
});

// Helper: Proses redeem kode voucher
function redeemCode(ctx, voucherCode) {
  voucherCode = voucherCode.trim().toUpperCase();
  const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(voucherCode);

  if (!voucher) {
    return ctx.replyWithMarkdown('❌ *Redeem Gagal!*\nKode voucher tidak valid.');
  }

  if (voucher.used === 1) {
    return ctx.replyWithMarkdown('❌ *Redeem Gagal!*\nKode voucher ini sudah terpakai.');
  }

  // Redeem proses
  const creditsToAdd = voucher.credits;
  const newBalance = updateUserCredits(ctx.from.id, creditsToAdd);

  // Tandai voucher sudah terpakai
  db.prepare('UPDATE vouchers SET used = 1, used_by = ?, used_at = ? WHERE code = ?')
    .run(ctx.from.id.toString(), new Date().toISOString(), voucherCode);

  ctx.replyWithMarkdown(`
🎉 *REDEEM BERHASIL!*
━━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 Saldo masuk: \`+${creditsToAdd} CR\`
💳 Saldo Kamu sekarang: \`${newBalance} CR\`
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

// Command: /redeem <KODE>
bot.command('redeem', (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.replyWithMarkdown('⚠️ *Format salah!*\n\nGunakan perintah: `/redeem <KODE_VOUCHER>`\nContoh: `/redeem NF-ABCD-EFGH`');
  }
  redeemCode(ctx, args[1]);
});

// Auto-Redeem jika user paste kode berawalan NF- langsung ke chat
bot.hears(/^NF-[A-Z0-9-]+$/i, (ctx) => {
  const code = ctx.message.text.trim();
  if (code.length >= 8 && code.length <= 25) {
    redeemCode(ctx, code);
  }
});

// FIFO Queue for processing trial account requests sequentially
const trialQueue = [];
let isProcessingQueue = false;

// Trigger processing of the next job in the queue
async function processQueue() {
  if (isProcessingQueue || trialQueue.length === 0) return;
  isProcessingQueue = true;

  const job = trialQueue[0];
  try {
    await handleTrialFlow(job.ctx, job.emailAddress);
  } catch (err) {
    console.error('❌ Error executing queue job:', err);
  } finally {
    trialQueue.shift(); // Remove the finished job
    isProcessingQueue = false;

    // Notify the next in line that their position has advanced
    for (let i = 0; i < trialQueue.length; i++) {
      try {
        const nextJob = trialQueue[i];
        const newPos = i + 1;
        await nextJob.ctx.replyWithMarkdown(`🔔 *Update Antrean:* Posisi Anda sekarang naik ke nomor *${newPos}* dalam antrean.`);
      } catch (err) {
        // Ignore notification delivery errors
      }
    }

    // Process next item
    processQueue();
  }
}

// Helper: Push trial request to queue
async function addToTrialQueue(ctx, emailAddress) {
  const userId = ctx.from.id;
  const user = getUser(userId);

  // 1. Validasi format email sederhana
  if (!emailAddress.includes('@')) {
    return ctx.replyWithMarkdown('❌ *Format email tidak valid!*\nHarus mengandung karakter "@". Contoh: `user@domain.com`');
  }

  // 2. Cek kredit awal (sebelum masuk antrean)
  if (user.credits <= 0) {
    return ctx.replyWithMarkdown('❌ *Kredit Tidak Mencukupi!*\nSaldo Anda saat ini: `0 CR`. Silakan beli dan redeem voucher terlebih dahulu.');
  }

  // 3. Cek cookies.json
  if (!fs.existsSync(COOKIES_FILE)) {
    return ctx.replyWithMarkdown('❌ *System Error!*\nCookies Netflix tidak tersedia di server. Silakan hubungi admin.');
  }

  let cookies;
  try {
    cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
    if (!Array.isArray(cookies)) throw new Error();
  } catch {
    return ctx.replyWithMarkdown('❌ *System Error!*\nFile cookies.json di server rusak atau tidak valid.');
  }

  // 4. Masukkan ke antrean
  trialQueue.push({ ctx, emailAddress });
  const position = trialQueue.length;

  if (position > 1) {
    await ctx.replyWithMarkdown(`⏳ *Permintaan Anda masuk antrean ke-${position}...*\nMohon tunggu sebentar, bot sedang memproses permintaan pengguna lain.`);
  }

  // 5. Jalankan queue processor
  processQueue();
}

// Helper: Buat progress bar teks premium
function getProgressBar(percent) {
  const totalBlocks = 10;
  const filledBlocks = Math.round((percent / 100) * totalBlocks);
  const emptyBlocks = totalBlocks - filledBlocks;
  const bar = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
  return `\`[${bar}]\` *${percent}%*`;
}

// Helper: Alur pendaftaran Netflix Trial
async function handleTrialFlow(ctx, emailAddress) {
  // Validasi format email sederhana
  if (!emailAddress.includes('@')) {
    return ctx.replyWithMarkdown('❌ *Format email tidak valid!*\nHarus mengandung karakter "@". Contoh: `user@domain.com`');
  }

  const userId = ctx.from.id;
  const user = getUser(userId);

  // Cek kredit
  if (user.credits <= 0) {
    return ctx.replyWithMarkdown('❌ *Kredit Tidak Mencukupi!*\nSaldo Anda saat ini: `0 CR`. Silakan beli dan redeem voucher terlebih dahulu.');
  }

  // Cek cookies.json
  if (!fs.existsSync(COOKIES_FILE)) {
    return ctx.replyWithMarkdown('❌ *System Error!*\nCookies Netflix tidak tersedia di server. Silakan hubungi admin.');
  }

  let cookies;
  try {
    cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
    if (!Array.isArray(cookies)) throw new Error();
  } catch {
    return ctx.replyWithMarkdown('❌ *System Error!*\nFile cookies.json di server rusak atau tidak valid.');
  }

  // Kirim status awal ke Telegram
  const statusMsg = await ctx.replyWithMarkdown(`⏳ *Proses pendaftaran sedang berjalan...*\n${getProgressBar(10)}`);

  // Fungsi pembantu untuk mengupdate status pesan di Telegram
  async function updateStatus(input) {
    try {
      let text;
      if (typeof input === 'number') {
        text = `⏳ *Proses pendaftaran sedang berjalan...*\n${getProgressBar(input)}`;
      } else {
        text = input;
      }
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text, { parse_mode: 'Markdown' });
    } catch (err) {
      // Abaikan error edit jika teks sama
    }
  }

  let browser;
  let page;
  try {
    // Kurangi 1 kredit
    const remainingCredits = updateUserCredits(userId, -1);
    await updateStatus(25);

    // Ambil opsi headless dari config
    const isHeadless = config.headless !== undefined ? config.headless : true;

    // Launch Playwright Browser (mencoba Google Chrome terlebih dahulu)
    let launchArgs;
    if (isHeadless) {
      launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--ignore-certificate-errors',
        '--disable-gpu',
        '--disable-software-rasterizer'
      ];
    } else {
      launchArgs = [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled'
      ];
    }

    try {
      browser = await chromium.launch({
        headless: isHeadless,
        channel: 'chrome',
        args: launchArgs
      });
    } catch (chromeError) {
      console.log('⚠️ Google Chrome tidak ditemukan. Menggunakan Chromium bawaan...');
      browser = await chromium.launch({
        headless: isHeadless,
        args: launchArgs
      });
    }

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    };
    if (isHeadless) {
      contextOptions.viewport = { width: 1280, height: 800 };
    } else {
      contextOptions.viewport = null;
    }

    const context = await browser.newContext(contextOptions);

    // Stealth tingkat lanjut: Bypass Akamai Bot Manager (WebGL, Chrome APIs, Plugins, Webdriver)
    await context.addInitScript(() => {
      // 1. Sembunyikan navigator.webdriver secara total dari prototype
      const newProto = Object.getPrototypeOf(navigator);
      delete newProto.webdriver;
      navigator.webdriver = false;

      // 2. Mock window.chrome agar tidak terdeteksi sebagai headless
      window.chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
        },
        runtime: {
          OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
          PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
          RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
        }
      };

      // 3. Mock navigator.plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const mockPlugin = (name, filename, description) => ({
            name,
            filename,
            description,
            length: 0,
            item: () => null,
            namedItem: () => null
          });
          const pluginsList = [
            mockPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
            mockPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
            mockPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format')
          ];
          return Object.assign(pluginsList, {
            item: (idx) => pluginsList[idx],
            namedItem: (nm) => pluginsList.find(p => p.name === nm) || null,
            refresh: () => { }
          });
        }
      });

      // 4. Mock WebGL & WebGL2 Renderer ke Kartu Grafis Asli (menghindari SwiftShader/VMware driver)
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function (parameter) {
        if (parameter === 37445) return 'Google Inc. (NVIDIA)';
        if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameter.apply(this, arguments);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function (parameter) {
          if (parameter === 37445) return 'Google Inc. (NVIDIA)';
          if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return getParameter2.apply(this, arguments);
        };
      }

      // 5. Mock navigator.platform agar selalu 'Win32' meskipun berjalan di Linux VPS
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });

      // 6. Mock navigator.userAgentData untuk menyembunyikan flag "HeadlessChrome"
      if (navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({
            brands: [
              { brand: 'Not/A)Brand', version: '8' },
              { brand: 'Chromium', version: '124' },
              { brand: 'Google Chrome', version: '124' }
            ],
            mobile: false,
            platform: 'Windows'
          })
        });
      }

      // 7. Mock hardware specs & languages
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });

      // 8. Mock window outer dimensions & screen dimensions
      Object.defineProperties(window, {
        outerWidth: { get: () => 1280 },
        outerHeight: { get: () => 800 }
      });
      Object.defineProperties(window.screen, {
        width: { get: () => 1280 },
        height: { get: () => 800 },
        availWidth: { get: () => 1280 },
        availHeight: { get: () => 800 }
      });
    });

    page = await context.newPage();

    // Clear Cookies
    await updateStatus(45);
    await page.goto('https://www.netflix.com/clearcookies', { waitUntil: 'commit' });
    await page.waitForTimeout(2000);

    // Injeksi Cookies
    await updateStatus(60);
    const formattedCookies = cookies.map(cookie => {
      let domain = cookie.domain || '.netflix.com';
      if (!domain.startsWith('.') && !domain.includes('localhost') && domain.includes('.')) {
        domain = `.${domain}`;
      }

      let sameSite = 'Lax';
      if (cookie.sameSite) {
        const ss = cookie.sameSite.toLowerCase();
        if (ss === 'no_restriction') sameSite = 'None';
        else if (ss === 'lax') sameSite = 'Lax';
        else if (ss === 'strict') sameSite = 'Strict';
      }

      return {
        name: cookie.name,
        value: cookie.value,
        domain: domain,
        path: cookie.path || '/',
        expires: cookie.expirationDate ? Math.round(cookie.expirationDate) : (cookie.expires || undefined),
        httpOnly: cookie.httpOnly !== undefined ? cookie.httpOnly : true,
        secure: cookie.secure !== undefined ? cookie.secure : true,
        sameSite: sameSite
      };
    });

    await context.addCookies(formattedCookies);

    // Buka Halaman Utama
    await updateStatus(75);
    await page.goto('https://www.netflix.com', { waitUntil: 'commit' });

    // Cari Input Email
    const emailSelector = 'input[type="email"], input[name="email"], #id_email_hero_fuji';
    await page.waitForSelector(emailSelector, { timeout: 8000 });

    // Isi Email secara Human-Like (Ketik satu per satu karakter)
    const emailInput = page.locator(emailSelector).first();
    let typedSuccessfully = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await emailInput.focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
      await page.keyboard.type(emailAddress, { delay: 80 });
      await page.waitForTimeout(500);

      const val = await emailInput.inputValue();
      if (val === emailAddress) {
        typedSuccessfully = true;
        break;
      } else {
        await page.waitForTimeout(1000);
      }
    }

    if (!typedSuccessfully) {
      throw new Error('Gagal mengisi email karena terhapus oleh framework halaman.');
    }

    // Kirim Form dengan menekan ENTER (lebih aman dari deteksi click bot)
    await updateStatus(85);
    await page.keyboard.press('Enter');

    // Tunggu 3 detik untuk membiarkan halaman merespons / redirect
    await page.waitForTimeout(3000);

    // Deteksi dini pemblokiran IP atau pengalihan ke halaman Login
    const earlyUrl = page.url();
    if (earlyUrl.includes('/login')) {
      throw new Error('Email sudah terdaftar (dialihkan ke login) ATAU IP server diblokir oleh Netflix.');
    }

    // Cek apakah ada banner error merah dari Netflix (indikasi cookies limit / diblokir)
    const errorBannerSelector = '.ui-message-error, [data-uia="text"], .message-container';
    const errorElements = page.locator(errorBannerSelector);
    const count = await errorElements.count();
    for (let i = 0; i < count; i++) {
      const text = await errorElements.nth(i).innerText();
      if (text.includes('Terjadi kesalahan') || text.includes('error') || text.includes('maaf') || text.includes('Maaf') || text.includes('Something went wrong') || text.includes('try again in a few minutes')) {
        throw new Error(`Netflix Error: ${text.trim()}`);
      }
    }

    const currentUrl = page.url();
    if (currentUrl.includes('netflix.com') && !currentUrl.includes('/signup') && !currentUrl.includes('/login')) {
      const submitButtonSelector = 'form button[type="submit"], button:has-text("Get Started"), button:has-text("Mulai"), button:has-text("Coba 30 Hari seharga Rp0")';
      const submitButton = page.locator(submitButtonSelector).first();
      if (await submitButton.isVisible()) {
        await submitButton.hover();
        await page.waitForTimeout(200);
        await submitButton.click();
        await page.waitForTimeout(3000);

        // Cek kembali setelah klik tombol fisik
        const checkUrlPostClick = page.url();
        if (checkUrlPostClick.includes('/login')) {
          throw new Error('Email sudah terdaftar (dialihkan ke login) ATAU IP server diblokir oleh Netflix.');
        }

        // Cek kembali error banner setelah klik tombol fisik
        const countAfterClick = await errorElements.count();
        for (let i = 0; i < countAfterClick; i++) {
          const text = await errorElements.nth(i).innerText();
          if (text.includes('Terjadi kesalahan') || text.includes('error') || text.includes('maaf') || text.includes('Maaf') || text.includes('Something went wrong') || text.includes('try again in a few minutes')) {
            throw new Error(`Netflix Error: ${text.trim()}`);
          }
        }
      }
    }

    // Tunggu halaman berikutnya & proses verifikasi step-by-step
    await updateStatus(90);

    const reEnterEmailSelector = 'input[name="userLoginId"], input[data-uia="field-userLoginId"]';
    const continueBtnSelector = 'button[data-uia="continue-button"], button:has-text("Lanjutkan"), button:has-text("Continue")';
    const successSelector = 'h1:has-text("email"), h1:has-text("Email"), h1:has-text("Link"), h1:has-text("link"), :has-text("Ketuk link dalam email"), :has-text("Check your email"), :has-text("Tap the link in the email")';
    const sendLinkSelector = [
      'button[data-uia*="send-email"]',
      'button[data-uia*="send-link"]',
      'button[data-uia*="action-send-email"]',
      'button:has-text("Send Link")',
      'button:has-text("Send Email")',
      'button:has-text("Kirim Link")',
      'button:has-text("Kirim Email")',
      'button:has-text("Kirim email masuk")',
      'button:has-text("Send sign-in link")'
    ].join(', ');

    let flowSuccess = false;

    for (let step = 1; step <= 4; step++) {
      await updateStatus(90);

      // Cek status halaman saat ini di awal step
      const stepUrl = page.url();
      if (stepUrl.includes('/login')) {
        throw new Error('Email sudah terdaftar (dialihkan ke login) ATAU IP server diblokir oleh Netflix.');
      }

      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (bodyText.includes('Something went wrong') || bodyText.includes('try again in a few minutes')) {
        throw new Error('Terdeteksi bot/IP server diblokir oleh Netflix (Something went wrong).');
      }

      // Tunggu salah satu dari keempat selector muncul (max 15 detik)
      const matchedSelector = await Promise.race([
        page.waitForSelector(reEnterEmailSelector, { timeout: 15000 }).then(() => 're_enter'),
        page.waitForSelector(sendLinkSelector, { timeout: 15000 }).then(() => 'send_link'),
        page.waitForSelector(continueBtnSelector, { timeout: 15000 }).then(() => 'continue_only'),
        page.waitForSelector(successSelector, { timeout: 15000 }).then(() => 'success'),
        page.waitForTimeout(15000).then(() => 'timeout')
      ]);

            // Pengaman: Periksa innerText body halaman untuk memastikan apakah sudah sukses
      const successCheckText = await page.locator('body').innerText().catch(() => '');
      if (successCheckText.includes('Ketuk link dalam email') || successCheckText.includes('Check your email') || successCheckText.includes('link untuk membuat akunmu')) {
        flowSuccess = true;
        break;
      }

      if (matchedSelector === 'success') {
        flowSuccess = true;
        break;
      }
      else if (matchedSelector === 're_enter') {
        // Isi ulang email
        const inputField = page.locator(reEnterEmailSelector).first();

        let retyped = false;
        for (let att = 1; att <= 3; att++) {
          await inputField.focus();
          await page.keyboard.press('Control+A');
          await page.keyboard.press('Backspace');
          await page.waitForTimeout(200);
          await page.keyboard.type(emailAddress, { delay: 80 });
          await page.waitForTimeout(500);
          const val = await inputField.inputValue();
          if (val === emailAddress) {
            retyped = true;
            break;
          }
        }

        const btn = page.locator(continueBtnSelector).first();
        await btn.hover();
        await page.waitForTimeout(200);
        await btn.click();
        await page.waitForTimeout(3000);
      }
      else if (matchedSelector === 'continue_only') {
        // Klik Lanjutkan (Tinjau untuk melanjutkan)
        const btn = page.locator(continueBtnSelector).first();
        await btn.hover();
        await page.waitForTimeout(200);
        await btn.click();
        await page.waitForTimeout(3000);
      }
      else if (matchedSelector === 'send_link') {
        // Halaman akhir: Kirim Link
        const sendLinkBtn = page.locator(sendLinkSelector).first();
        await sendLinkBtn.hover();
        await page.waitForTimeout(500);
        await sendLinkBtn.click();
        await page.waitForTimeout(3000); // Tunggu sebentar agar request selesai
        flowSuccess = true;
        break;
      }
      else {
        break;
      }
    }

    if (!flowSuccess) {
      throw new Error('Proses otomatis tidak berhasil sampai ke halaman sukses.');
    }

    await updateStatus(`
🎉 *Pendaftaran Sukses!*

📧 *Email:* \`${emailAddress}\`
📬 Silakan cek inbox/spam email anda.
`);

  } catch (error) {
    console.error('❌ Error during trial automation:', error);

    // Ambil screenshot dari page jika error
    let screenshotBuffer = null;
    if (page) {
      try {
        screenshotBuffer = await page.screenshot({ type: 'png' });
      } catch (err) {
        console.error('Gagal mengambil screenshot:', err);
      }
    }

    // Kembalikan kredit jika gagal
    const refundedCredits = updateUserCredits(userId, 1);

    // Pesan ramah non-teknis untuk pengguna
    await updateStatus(`
❌ *Pendaftaran Gagal*

Terjadi kendala teknis saat memproses pendaftaran Anda. Saldo kredit telah dikembalikan.
🪙 *Sisa Saldo:* \`${refundedCredits} CR\`
`);

    // Kirim notifikasi error detail & screenshot ke Admin (jika adminId diset)
    if (config.adminId) {
      const adminId = config.adminId.toString();
      const adminErrorMsg = `⚠️ *REPORT ERROR OTOMASI*
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *User:* ${ctx.from.first_name} (@${ctx.from.username || 'no_username'}) [\`${userId}\`]
📧 *Email:* \`${emailAddress}\`
❌ *Error:* \`${error.message || 'Timeout'}\`
━━━━━━━━━━━━━━━━━━━━━━━━━━`;

      try {
        await ctx.telegram.sendMessage(adminId, adminErrorMsg, { parse_mode: 'Markdown' });
        if (screenshotBuffer) {
          await ctx.telegram.sendPhoto(adminId, { source: screenshotBuffer }, { caption: `📸 Screenshot error dari pendaftaran email: ${emailAddress}` });
        }
      } catch (adminErr) {
        console.error('Gagal mengirim notifikasi error ke admin:', adminErr);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Command: /trial <email>
bot.command('trial', async (ctx) => {
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.replyWithMarkdown('⚠️ *Format salah!*\n\nGunakan perintah: `/trial <email>`\nContoh: `/trial budi@gaugai.my.id`');
  }
  const emailAddress = args[1].trim();
  await addToTrialQueue(ctx, emailAddress);
});

// ADMIN COMMANDS (Hanya untuk Admin ID)
function isAdmin(ctx) {
  return ctx.from.id.toString() === config.adminId.toString();
}

// Admin Panel Helper Function
function showAdminPanel(ctx, isEdit = false) {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalVouchers = db.prepare('SELECT COUNT(*) as count FROM vouchers').get().count;
  const activeVouchers = db.prepare('SELECT COUNT(*) as count FROM vouchers WHERE used = 0').get().count;
  const usedVouchers = totalVouchers - activeVouchers;
  const isMaint = getSetting('maintenance') === 'true';

  const adminMessage = `
⚙️  *ADMIN CONTROL PANEL*  ⚙️
━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 *Statistik Bot:*
👥 Total Pengguna: \`${totalUsers} orang\`
🎫 Total Voucher Dibuat: \`${totalVouchers} buah\`
🟢 Voucher Aktif: \`${activeVouchers} buah\`
🔴 Voucher Terpakai: \`${usedVouchers} buah\`

🔧 *Status Maintenance:* ${isMaint ? '🟢 *AKTIF*' : '🔴 *NONAKTIF*'}
━━━━━━━━━━━━━━━━━━━━━━━━━━
*Pilih tindakan di bawah ini:*
`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📣 Broadcast Pesan', 'admin_broadcast')],
    [Markup.button.callback('💸 Bagi Kredit ke Semua', 'admin_giveall')],
    [Markup.button.callback(isMaint ? '🔴 Nonaktifkan Maintenance' : '🟢 Aktifkan Maintenance', 'admin_toggle_maintenance')],
    [Markup.button.callback('🎫 List Voucher Aktif', 'admin_listvouchers')]
  ]);

  if (isEdit) {
    return ctx.editMessageText(adminMessage, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup }).catch(() => {});
  } else {
    return ctx.replyWithMarkdown(adminMessage, keyboard);
  }
}

// Admin Panel Dashboard Command
bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('❌ Anda tidak memiliki izin untuk menggunakan perintah ini!');
  return showAdminPanel(ctx);
});

// Inline Action Handlers
bot.action('admin_broadcast', (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Akses ditolak');
  const userId = ctx.from.id.toString();
  userStates[userId] = 'ADMIN_WAITING_FOR_BC';
  ctx.replyWithMarkdown(`
📣 *BROADCAST PESAN*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Silakan kirimkan pesan/teks yang ingin disebarkan ke semua pengguna bot.

*Ketik /cancel untuk membatalkan.*
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  ctx.answerCbQuery();
});

bot.action('admin_giveall', (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Akses ditolak');
  const userId = ctx.from.id.toString();
  userStates[userId] = 'ADMIN_WAITING_FOR_GIVEALL';
  ctx.replyWithMarkdown(`
💸 *BAGI KREDIT KE SEMUA*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Silakan kirimkan jumlah nominal kredit yang ingin dibagikan secara gratis ke SEMUA pengguna bot.
Contoh: \`1\`

*Ketik /cancel untuk membatalkan.*
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
  ctx.answerCbQuery();
});

bot.action('admin_toggle_maintenance', (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Akses ditolak');
  const currentVal = getSetting('maintenance') === 'true';
  const newVal = !currentVal;
  setSetting('maintenance', newVal ? 'true' : 'false');
  
  ctx.answerCbQuery(`🔧 Maintenance: ${newVal ? 'AKTIF' : 'NONAKTIF'}`);
  return showAdminPanel(ctx, true);
});

bot.action('admin_listvouchers', (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('❌ Akses ditolak');
  ctx.answerCbQuery();
  
  const activeVouchers = db.prepare('SELECT code, credits FROM vouchers WHERE used = 0').all();
  if (activeVouchers.length === 0) {
    return ctx.reply('📭 Tidak ada voucher aktif yang belum terpakai.');
  }

  ctx.replyWithMarkdown(`
🎁 *VOUCHER AKTIF BELUM TERPAKAI*
━━━━━━━━━━━━━━━━━━━━━━━━━━
${activeVouchers.map(v => `🔑 \`${v.code}\` (\`${v.credits} CR\`)`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

// Admin Helper Handler: Broadcast message
async function handleAdminBroadcast(ctx, messageText) {
  const users = db.prepare('SELECT id FROM users').all();
  const statusMsg = await ctx.reply(`📣 Memulai pengiriman siaran (broadcast) ke ${users.length} pengguna...`);

  let successCount = 0;
  let failCount = 0;

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, messageText, { parse_mode: 'Markdown' });
      successCount++;
    } catch (mdErr) {
      try {
        await ctx.telegram.sendMessage(user.id, messageText, { parse_mode: 'HTML' });
        successCount++;
      } catch (htmlErr) {
        try {
          await ctx.telegram.sendMessage(user.id, messageText);
          successCount++;
        } catch (plainErr) {
          failCount++;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `📣 *SIARAN SELESAI!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Sukses Terkirim: \`${successCount} user\`\n❌ Gagal (Blokir/Deaktif): \`${failCount} user\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'Markdown' }
  ).catch(() => {
    ctx.replyWithMarkdown(`📣 *SIARAN SELESAI!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Sukses Terkirim: \`${successCount} user\`\n❌ Gagal (Blokir/Deaktif): \`${failCount} user\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  });
}

// Admin Helper Handler: Give all users credits
async function handleAdminGiveAll(ctx, text) {
  const amount = parseInt(text);
  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Jumlah kredit harus berupa angka positif!');
  }

  const users = db.prepare('SELECT id FROM users').all();
  
  // Update DB in transaction
  const updateQuery = db.prepare('UPDATE users SET credits = credits + ?');
  const transaction = db.transaction((amt) => {
    updateQuery.run(amt);
  });
  transaction(amount);

  const statusMsg = await ctx.reply(`💸 Membagikan +${amount} CR ke semua (${users.length}) pengguna...`);

  let successCount = 0;
  let failCount = 0;

  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.id, `
🎁 *Kado Spesial dari Admin!*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Anda mendapatkan bonus sebesar \`+${amount} CR\` gratis!
💳 Cek saldo Anda sekarang menggunakan menu *🪙 Cek Kredit*.
━━━━━━━━━━━━━━━━━━━━━━━━━━
`, { parse_mode: 'Markdown' });
      successCount++;
    } catch (err) {
      failCount++;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `💸 *PEMBAGIAN SELESAI!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Berhasil Dikirim: \`${successCount} user\`\n❌ Gagal (Blokir/Deaktif): \`${failCount} user\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'Markdown' }
  ).catch(() => {
    ctx.replyWithMarkdown(`💸 *PEMBAGIAN SELESAI!*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n✅ Berhasil Dikirim: \`${successCount} user\`\n❌ Gagal (Blokir/Deaktif): \`${failCount} user\`\n━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  });
}

// Admin: /genvoucher <kredit> <jumlah>
bot.command('genvoucher', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ Anda tidak memiliki izin untuk menggunakan perintah ini!');
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.replyWithMarkdown('⚠️ *Format salah!*\n\nGunakan: `/genvoucher <kredit_per_voucher> <jumlah_voucher>`\nContoh:\n• `/genvoucher 1 50` (Buat 50 voucher, masing-masing isi 1 CR)\n• `/genvoucher 10 10` (Buat 10 voucher, masing-masing isi 10 CR)');
  }

  const credits = parseInt(args[1]);
  const count = parseInt(args[2]);

  if (isNaN(credits) || isNaN(count) || credits <= 0 || count <= 0) {
    return ctx.reply('❌ Input jumlah kredit dan jumlah voucher harus berupa angka positif!');
  }

  const createdCodes = [];
  const insertVoucher = db.prepare('INSERT INTO vouchers (code, credits, used, used_by, used_at, created_at) VALUES (?, ?, 0, NULL, NULL, ?)');

  const transaction = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      // Generate secure 10-character code: NF-XXXXX-XXXXX
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let randCode = '';
      const bytes = crypto.randomBytes(10);
      for (let j = 0; j < 10; j++) {
        randCode += chars[bytes[j] % chars.length];
      }
      const code = `NF-${randCode.substring(0, 5)}-${randCode.substring(5, 10)}`;

      insertVoucher.run(code, credits, new Date().toISOString());
      createdCodes.push(code);
    }
  });

  transaction();

  const replyMessage = `
🎁 *VOUCHER BERHASIL DIBUAT!*
━━━━━━━━━━━━━━━━━━━━━━━━━━
🪙 Nilai Voucher: \`${credits} CR (Credit)\`
📦 Jumlah Voucher: \`${count} Buah\`
 
*Silakan salin kode voucher di bawah:*
${createdCodes.map(c => `🔑 \`${c}\` (\`${credits} CR\`)`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  ctx.replyWithMarkdown(replyMessage);
});

// Admin: /addcredits <userid> <kredit>
bot.command('addcredits', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('❌ Anda tidak memiliki izin untuk menggunakan perintah ini!');
  }

  const args = ctx.message.text.split(' ');
  if (args.length < 3) {
    return ctx.replyWithMarkdown('⚠️ *Format salah!*\n\nGunakan: `/addcredits <telegram_user_id> <jumlah_kredit>`\nContoh: `/addcredits 123456789 5`');
  }

  const targetUserId = args[1].trim();
  const credits = parseInt(args[2]);

  if (isNaN(credits)) {
    return ctx.reply('❌ Jumlah kredit harus berupa angka!');
  }

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
  if (!user) {
    return ctx.reply('❌ User ID tersebut tidak ditemukan! User tersebut harus men-start bot ini terlebih dahulu.');
  }

  const newBalance = updateUserCredits(targetUserId, credits);
  ctx.replyWithMarkdown(`
💸 *PENGISIAN KREDIT BERHASIL!*
━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 User ID: \`${targetUserId}\`
🪙 Kredit Masuk: \`+${credits} CR\`
💳 Total Saldo User: \`${newBalance} CR\`
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  // Kirim notifikasi ke user target
  ctx.telegram.sendMessage(targetUserId, `
🎁 *Kredit Masuk dari Admin!*
━━━━━━━━━━━━━━━━━━━━━━━━━━
Anda menerima \`+${credits} CR\` dari Admin.
💳 Saldo Anda sekarang: \`${newBalance} CR\`
━━━━━━━━━━━━━━━━━━━━━━━━━━
`, { parse_mode: 'Markdown' }).catch(() => { });
});

// Admin: /listvouchers
bot.command('listvouchers', (ctx) => {
  if (!isAdmin(ctx)) return;
  const activeVouchers = db.prepare('SELECT code, credits FROM vouchers WHERE used = 0').all();

  if (activeVouchers.length === 0) {
    return ctx.reply('📭 Tidak ada voucher aktif yang belum terpakai.');
  }

  ctx.replyWithMarkdown(`
🎁 *VOUCHER AKTIF BELUM TERPAKAI*
━━━━━━━━━━━━━━━━━━━━━━━━━━
${activeVouchers.map(v => `🔑 \`${v.code}\` (\`${v.credits} CR\`)`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
});

// Daftarkan menu perintah (command list autocomplete)
bot.telegram.setMyCommands([
  { command: 'start', description: 'Mulai bot & Tampilkan Menu Utama' },
  { command: 'trial', description: 'Buat akun Netflix Trial 30 Hari' },
  { command: 'redeem', description: 'Redeem kode voucher kredit' },
  { command: 'kredit', description: 'Cek sisa saldo kredit kamu' },
  { command: 'bantuan', description: 'Panduan cara menggunakan bot' }
]).then(() => {
  console.log('✅ Menu perintah autocomplete berhasil didaftarkan.');
}).catch(err => {
  console.error('❌ Gagal mendaftarkan menu perintah:', err);
});

// Start Bot
bot.launch().then(() => {
  console.log('==================================================');
  console.log('      BOT TELEGRAM NETFLIX AUTO-TRIAL AKTIF!      ');
  console.log('==================================================');
  console.log(`Username Bot: Silakan cek di Telegram.`);
  console.log(`Admin ID yang terdaftar: ${config.adminId}`);
  console.log('--------------------------------------------------');
});

// Enable graceful stop
process.once('SIGINT', () => {
  try { bot.stop('SIGINT'); } catch (e) { }
});
process.once('SIGTERM', () => {
  try { bot.stop('SIGTERM'); } catch (e) { }
});
