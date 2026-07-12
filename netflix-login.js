const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

// File cookies.json & credits.json harus ada di folder yang sama
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const CREDITS_FILE = path.join(__dirname, 'credits.json');

// Fungsi pembantu untuk meminta input dari terminal
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

// Fungsi untuk membaca kredit saat ini
function getCredits() {
  if (!fs.existsSync(CREDITS_FILE)) {
    fs.writeFileSync(CREDITS_FILE, JSON.stringify({ credits: 0 }, null, 2));
    return 0;
  }
  try {
    const data = JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8'));
    return typeof data.credits === 'number' ? data.credits : 0;
  } catch {
    return 0;
  }
}

// Fungsi untuk menyimpan kredit baru
function saveCredits(amount) {
  fs.writeFileSync(CREDITS_FILE, JSON.stringify({ credits: amount }, null, 2));
}

async function run() {
  console.log('==================================================');
  console.log('    NETFLIX TRIAL COOKIE & EMAIL AUTO-SUBMITTER   ');
  console.log('==================================================\n');

  // 1. Cek Saldo Kredit Terlebih Dahulu
  let currentCredits = getCredits();
  console.log(`🪙 Saldo Kredit Anda saat ini: ${currentCredits}`);
  
  if (currentCredits <= 0) {
    console.error('❌ Error: Kredit Anda tidak mencukupi (0 Kredit).');
    console.log('💡 Petunjuk: Silakan isi ulang kredit Anda dengan mengedit file "credits.json".');
    process.exit(1);
  }

  // 2. Cek apakah file cookies.json ada
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`❌ Error: File 'cookies.json' tidak ditemukan!`);
    console.log(`💡 Petunjuk:`);
    console.log(`   1. Copy file 'cookies.json.example' menjadi 'cookies.json'`);
    console.log(`   2. Letakkan cookies trial Anda ke dalam file 'cookies.json'`);
    console.log(`   3. Jalankan kembali program ini.`);
    process.exit(1);
  }

  // 3. Baca & parse cookies
  let cookies;
  try {
    const rawData = fs.readFileSync(COOKIES_FILE, 'utf-8');
    cookies = JSON.parse(rawData);
    if (!Array.isArray(cookies)) {
      throw new Error('Data cookie di dalam JSON harus berupa Array [...]');
    }
  } catch (err) {
    console.error(`❌ Gagal membaca atau mem-parse 'cookies.json':`, err.message);
    process.exit(1);
  }

  // 4. Minta input email
  const emailAddress = await askQuestion('📧 Masukkan alamat email untuk didaftarkan: ');
  if (!emailAddress) {
    console.error('❌ Error: Email tidak boleh kosong!');
    process.exit(1);
  }

  // 5. Potong 1 Kredit setelah email dimasukkan
  currentCredits -= 1;
  saveCredits(currentCredits);
  console.log(`💸 1 Kredit berhasil dipotong! Sisa kredit Anda: ${currentCredits}`);

  console.log(`\n✔ Email target disimpan: ${emailAddress}`);
  console.log(`✔ Berhasil memuat ${cookies.length} cookie dari cookies.json`);
  console.log('🚀 Membuka browser Google Chrome...');

  try {
    // 4. Launch browser Google Chrome lokal
    const browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      viewport: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    // Stealth tingkat lanjut: Bypass Akamai Bot Manager (WebGL, Chrome APIs, Plugins, Webdriver)
    await context.addInitScript(() => {
      // 1. Sembunyikan navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

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
            refresh: () => {}
          });
        }
      });

      // 4. Mock WebGL Renderer ke Kartu Grafis Asli (menghindari SwiftShader/VMware driver)
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) {
          return 'Google Inc. (NVIDIA)';
        }
        if (parameter === 37446) {
          return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        return getParameter.apply(this, arguments);
      };
    });

    const page = await context.newPage();

    // 5. Masuk ke netflix.com/clearcookies untuk membersihkan session cookies
    console.log('🧹 Membersihkan session via netflix.com/clearcookies...');
    await page.goto('https://www.netflix.com/clearcookies', { waitUntil: 'commit' });

    // Tunggu 2 detik untuk memastikan proses pembersihan selesai di sisi server
    await page.waitForTimeout(2000);

    // 6. Inject cookies ke context browser
    console.log('🔑 Menginjeksikan cookies trial Anda...');
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

    try {
      await context.addCookies(formattedCookies);
      console.log('✔ Cookies berhasil diinjeksi!');
    } catch (cookieError) {
      console.error('❌ Gagal menginjeksi cookies. Format tidak valid:', cookieError.message);
      await browser.close();
      process.exit(1);
    }

    // 7. Buka halaman utama Netflix
    console.log('🌐 Menavigasi ke halaman utama Netflix...');
    await page.goto('https://www.netflix.com', { waitUntil: 'commit' });

    // 8. Tunggu form email muncul dan isi otomatis
    try {
      console.log('🔍 Mencari input email di halaman utama...');
      const emailSelector = 'input[type="email"], input[name="email"], #id_email_hero_fuji';

      // Tunggu selector muncul max 8 detik
      await page.waitForSelector(emailSelector, { timeout: 8000 });
      const emailInput = page.locator(emailSelector).filter({ visible: true }).first();

      console.log(`✍ Mengisi email secara otomatis (typing simulation): ${emailAddress}`);
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
          console.log(`✔ Email berhasil terisi secara utuh (percobaan ${attempt})!`);
          break;
        } else {
          console.log(`⚠️ Input kosong / terhapus oleh React (percobaan ${attempt}, isi: "${val}"). Mencoba ulang...`);
          await page.waitForTimeout(1000);
        }
      }

      if (!typedSuccessfully) {
        throw new Error('Gagal mengisi email karena selalu terhapus oleh framework halaman.');
      }

      console.log('⌨ Mengirimkan form dengan menekan ENTER...');
      await page.keyboard.press('Enter');

      // Tunggu 3 detik untuk membiarkan halaman merespons / redirect
      await page.waitForTimeout(3000);

      // Cek apakah ada banner error merah dari Netflix (indikasi cookies limit / diblokir)
      const errorBannerSelector = '.ui-message-error, [data-uia="text"], .message-container';
      const errorElements = page.locator(errorBannerSelector);
      const count = await errorElements.count();
      for (let i = 0; i < count; i++) {
        const text = await errorElements.nth(i).innerText();
        if (text.includes('Terjadi kesalahan') || text.includes('error') || text.includes('maaf') || text.includes('Maaf')) {
          console.log('\n❌ ERROR DARI NETFLIX:');
          console.log(`> "${text.trim()}"`);
          console.log('Kemungkinan cookies trial Anda limit / diblokir sementara oleh Netflix.\n');
          throw new Error(`Netflix Error Banner: ${text.trim()}`);
        }
      }

      const currentUrl = page.url();
      if (currentUrl.includes('netflix.com') && !currentUrl.includes('/signup') && !currentUrl.includes('/login')) {
        console.log('🖱 Menekan ENTER tidak memicu navigasi. Mencoba mengeklik tombol "Coba 30 Hari seharga Rp0" secara langsung...');
        const submitButtonSelector = 'form button[type="submit"], button:has-text("Get Started"), button:has-text("Mulai"), button:has-text("Coba 30 Hari seharga Rp0")';
        const submitButton = page.locator(submitButtonSelector).filter({ visible: true }).first();
        if (await submitButton.isVisible()) {
          await submitButton.hover();
          await page.waitForTimeout(200);
          await submitButton.click();
          await page.waitForTimeout(3000);

          // Cek kembali error banner setelah klik tombol fisik
          const countAfterClick = await errorElements.count();
          for (let i = 0; i < countAfterClick; i++) {
            const text = await errorElements.nth(i).innerText();
            if (text.includes('Terjadi kesalahan') || text.includes('error') || text.includes('maaf') || text.includes('Maaf')) {
              console.log('\n❌ ERROR DARI NETFLIX (setelah klik tombol):');
              console.log(`> "${text.trim()}"`);
              console.log('Kemungkinan cookies trial Anda limit / diblokir sementara oleh Netflix.\n');
              throw new Error(`Netflix Error Banner: ${text.trim()}`);
            }
          }
        }
      }

      // 9. Tunggu dan proses halaman verifikasi step-by-step
      console.log('🔍 Menunggu halaman berikutnya memuat...');
      
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
        console.log(`⚡ Memproses langkah verifikasi ke-${step}...`);
        
        // Tunggu salah satu dari keempat selector muncul (max 15 detik)
        const matchedSelector = await Promise.race([
          page.waitForSelector(reEnterEmailSelector, { timeout: 15000 }).then(() => 're_enter').catch(() => new Promise(() => {})),
          page.waitForSelector(sendLinkSelector, { timeout: 15000 }).then(() => 'send_link').catch(() => new Promise(() => {})),
          page.waitForSelector(continueBtnSelector, { timeout: 15000 }).then(() => 'continue_only').catch(() => new Promise(() => {})),
          page.waitForSelector(successSelector, { timeout: 15000 }).then(() => 'success').catch(() => new Promise(() => {})),
          page.waitForTimeout(15000).then(() => 'timeout')
        ]);

        console.log(`📍 Deteksi tipe halaman: ${matchedSelector}`);

        // Pengaman: Periksa innerText body halaman untuk memastikan apakah sudah sukses
        const bodyText = await page.locator('body').innerText().catch(() => '');
        if (bodyText.includes('Ketuk link dalam email') || bodyText.includes('Check your email') || bodyText.includes('link untuk membuat akunmu')) {
          console.log('\n==================================================');
          console.log('🎉 BERHASIL!');
          console.log('Link pendaftaran telah berhasil dikirim ke email Anda!');
          console.log('Silakan cek kotak masuk email Anda.');
          console.log('==================================================\n');
          flowSuccess = true;
          break;
        }

        if (matchedSelector === 'success') {
          console.log('\n==================================================');
          console.log('🎉 BERHASIL!');
          console.log('Link pendaftaran telah berhasil dikirim ke email Anda!');
          console.log('Silakan cek kotak masuk email Anda.');
          console.log('==================================================\n');
          flowSuccess = true;
          break;
        }
        else if (matchedSelector === 're_enter') {
          // Isi ulang email
          console.log('✍ Mengisi ulang email di halaman verifikasi...');
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
          
          console.log('🖱 Mengeklik tombol Lanjutkan...');
          const btn = page.locator(continueBtnSelector).first();
          await btn.hover();
          await page.waitForTimeout(200);
          await btn.click();
          await page.waitForTimeout(3000);
        }
        else if (matchedSelector === 'continue_only') {
          // Klik Lanjutkan (Tinjau untuk melanjutkan)
          console.log('🖱 Halaman tinjauan/lanjutan terdeteksi. Mengeklik Lanjutkan...');
          const btn = page.locator(continueBtnSelector).first();
          await btn.hover();
          await page.waitForTimeout(200);
          await btn.click();
          await page.waitForTimeout(3000);
        }
        else if (matchedSelector === 'send_link') {
          // Halaman akhir: Kirim Link
          console.log('🖱 Mengeklik tombol "Send Link" secara otomatis...');
          const sendLinkBtn = page.locator(sendLinkSelector).first();
          await sendLinkBtn.hover();
          await page.waitForTimeout(500);
          await sendLinkBtn.click();
          await page.waitForTimeout(3000);

          console.log('\n==================================================');
          console.log('🎉 BERHASIL!');
          console.log('Email berhasil diisi dan link pendaftaran telah dikirim!');
          console.log('Silakan cek kotak masuk email Anda.');
          console.log('==================================================\n');
          flowSuccess = true;
          break;
        }
        else {
          console.log('⚠️ Tidak mendeteksi perubahan halaman baru atau proses terhambat.');
          break;
        }
      }

      if (!flowSuccess) {
        throw new Error('Proses otomatis tidak mencapai halaman sukses.');
      }

    } catch (formError) {
      console.log(`\n❌ Gagal: ${formError.message}`);
      console.log('Kemungkinan cookies trial tidak aktif / diblokir, atau UI Netflix berbeda.\n');
    }

    // Menjaga agar browser tetap terbuka
    browser.on('disconnected', () => {
      console.log('👋 Browser ditutup. Program selesai.');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Terjadi kesalahan saat menjalankan browser:', error);
  }
}

run();
