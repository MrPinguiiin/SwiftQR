let currentQRData = null;
let currentPayAmount = null;
let currentTransactionId = null;
let currentPaymentStatus = null;
let currentPaymentCreatedAt = null;
let currentGobizMatch = null;
let countdownInterval = null;
let paymentStatusInterval = null;
let gobizMatchInterval = null;
let postPaymentResetTimeout = null;
let timeLeft = 900; // 15 minutes

const DEFAULT_QRIS_UTAMA = '';
const QRIS_STORAGE_KEY = 'QRIS_Utama';

const urlParams = new URLSearchParams(window.location.search);

document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    initQrisConfigUI();
    initAmountFormUI();

    const qrisUtama = resolveQrisUtama();
    if (!qrisUtama) {
        renderAwaitingQrisState();
        showMessage('Upload gambar QRIS statis terlebih dahulu untuk memulai pembayaran.', 'warning');
        return;
    }

    const initialAmount = parsePayAmount(urlParams.get('pay'));
    if (!initialAmount) {
        renderEmptyAmountState();
        showMessage('Masukkan nominal pembayaran untuk membuat QR dinamis.', 'warning');
        return;
    }

    currentPayAmount = initialAmount;
    document.getElementById('amountInput').value = currentPayAmount;
    restartPaymentFlow(qrisUtama, currentPayAmount);
});

function initAmountFormUI() {
    const form = document.getElementById('amountForm');
    const input = document.getElementById('amountInput');
    if (!form || !input) {
        return;
    }

    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        const amount = parsePayAmount(input.value);
        if (!amount) {
            showMessage('Nominal tidak valid. Isi angka lebih dari 0.', 'danger');
            return;
        }

        const qrisUtama = resolveQrisUtama();
        if (!qrisUtama) {
            renderInvalidQrisState();
            showMessage('Payload QRIS statis tidak valid. Perbarui payload terlebih dahulu.', 'danger');
            return;
        }

        currentPayAmount = amount;
        syncUrlParams({ pay: String(amount) });
        await restartPaymentFlow(qrisUtama, amount);
        showMessage(`Nominal pembayaran diubah ke ${formatCurrency(amount)}.`, 'success');
    });
}

function initQrisConfigUI() {
    const qrisImageInput = document.getElementById('qrisImageInput');
    const extractButton = document.getElementById('extractQrisButton');
    const resetButton = document.getElementById('resetQrisButton');
    const qrisPreview = document.getElementById('qrisPreview');
    const extractedValue = document.getElementById('qrisExtractedValue');
    const status = document.getElementById('qrisValidationStatus');
    if (!qrisImageInput || !extractButton || !resetButton || !qrisPreview || !extractedValue || !status) {
        return;
    }

    const currentQris = localStorage.getItem(QRIS_STORAGE_KEY);
    extractedValue.value = currentQris || '';
    if (currentQris) {
        updateQrisValidationStatus(validateQrisPayload(currentQris));
    } else {
        updateQrisValidationStatus({ valid: false, error: 'belum ada, upload gambar QRIS dulu' });
    }

    qrisImageInput.addEventListener('change', async function() {
        const file = qrisImageInput.files && qrisImageInput.files[0];
        if (!file) {
            return;
        }

        try {
            const payload = await extractQrisPayloadFromImage(file);
            const validation = validateQrisPayload(payload);
            extractedValue.value = payload;
            updateQrisValidationStatus(validation);

            if (!validation.valid) {
                showMessage(`QR terdeteksi, tapi payload tidak valid: ${validation.error}`, 'danger');
                return;
            }

            localStorage.setItem(QRIS_STORAGE_KEY, validation.payload);
            extractedValue.value = validation.payload;
            showMessage('Payload QRIS berhasil dibaca dari gambar.', 'success');

            if (!currentPayAmount) {
                return;
            }

            await restartPaymentFlow(validation.payload, currentPayAmount);
        } catch (error) {
            updateQrisValidationStatus({ valid: false, error: error.message });
            showMessage(`Gagal membaca gambar QRIS: ${error.message}`, 'danger');
        }
    });

    extractButton.addEventListener('click', function() {
        const file = qrisImageInput.files && qrisImageInput.files[0];
        if (!file) {
            showMessage('Pilih gambar QRIS terlebih dahulu.', 'warning');
            return;
        }

        const reader = new FileReader();
        reader.onload = function(event) {
            qrisPreview.src = event.target.result;
            qrisPreview.style.display = 'block';
        };
        reader.readAsDataURL(file);

        qrisImageInput.dispatchEvent(new Event('change'));
    });

    resetButton.addEventListener('click', async function() {
        clearPostPaymentResetTimeout();
        localStorage.removeItem(QRIS_STORAGE_KEY);
        extractedValue.value = '';
        qrisImageInput.value = '';
        qrisPreview.style.display = 'none';
        qrisPreview.src = '';

        updateQrisValidationStatus({ valid: false, error: 'belum ada, upload gambar QRIS dulu' });
        showMessage('Payload direset. Silakan upload ulang gambar QRIS.', 'success');

        clearInterval(countdownInterval);
        stopPaymentStatusPolling();
        stopGobizMatchPolling();
        timeLeft = 900;
        currentQRData = null;
        currentTransactionId = null;
        currentPaymentStatus = null;
        currentPaymentCreatedAt = null;
        hideGobizMatchCard();

        renderAwaitingQrisState();
        document.getElementById('amountDisplay').textContent = formatCurrency(currentPayAmount || 0);
        document.getElementById('actionButtons').style.display = 'none';
        document.getElementById('merchantDisplay').style.display = 'none';
        setPaymentStatus('pending', 'Status pembayaran: Menunggu upload QRIS');

        if (!currentPayAmount) {
            return;
        }
    });
}

async function extractQrisPayloadFromImage(file) {
    if (!file || !file.type.startsWith('image/')) {
        throw new Error('File harus berupa gambar.');
    }

    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImageFromDataUrl(dataUrl);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Canvas tidak tersedia di browser ini.');
    }

    const maxSize = 1400;
    const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.floor(image.width * scale));
    canvas.height = Math.max(1, Math.floor(image.height * scale));
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth'
    });

    if (!result || !result.data) {
        throw new Error('QR tidak terdeteksi. Pastikan gambar jelas dan tidak blur.');
    }

    return result.data;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = event => resolve(event.target.result);
        reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
        reader.readAsDataURL(file);
    });
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Gagal memproses gambar.'));
        image.src = dataUrl;
    });
}

function updateQrisValidationStatus(validation) {
    const status = document.getElementById('qrisValidationStatus');
    if (!status) {
        return;
    }

    status.classList.remove('valid', 'invalid');
    if (validation.valid) {
        status.classList.add('valid');
        status.textContent = 'Status payload: valid';
        return;
    }

    status.classList.add('invalid');
    if (validation.error === 'belum ada, upload gambar QRIS dulu') {
        status.textContent = 'Status payload: belum ada, upload gambar QRIS dulu';
        return;
    }
    status.textContent = `Status payload: tidak valid (${validation.error})`;
}

function setPaymentStatus(status, text) {
    const statusEl = document.getElementById('paymentStatus');
    if (!statusEl) {
        return;
    }

    statusEl.classList.remove('pending', 'paid', 'expired', 'failed');
    const normalized = String(status || '').toLowerCase();
    if (['pending', 'paid', 'expired', 'failed'].includes(normalized)) {
        statusEl.classList.add(normalized);
    }
    statusEl.textContent = text;
}

function stopPaymentStatusPolling() {
    if (paymentStatusInterval) {
        clearInterval(paymentStatusInterval);
        paymentStatusInterval = null;
    }
}

function handlePaymentStatus(status) {
    const nextStatus = String(status || '').toUpperCase();
    if (nextStatus === currentPaymentStatus) {
        return;
    }

    currentPaymentStatus = nextStatus;

    if (nextStatus === 'PAID') {
        setPaymentStatus('paid', 'Status pembayaran: Berhasil dibayar');
        clearInterval(countdownInterval);
        stopPaymentStatusPolling();
        stopGobizMatchPolling();
        showMessage('Pembayaran berhasil diterima.', 'success');
        return;
    }

    if (nextStatus === 'EXPIRED') {
        setPaymentStatus('expired', 'Status pembayaran: Kedaluwarsa');
        clearInterval(countdownInterval);
        stopPaymentStatusPolling();
        stopGobizMatchPolling();
        showMessage('Pembayaran kedaluwarsa. Silakan buat QR baru.', 'warning');
        return;
    }

    if (nextStatus === 'FAILED') {
        setPaymentStatus('failed', 'Status pembayaran: Gagal');
        clearInterval(countdownInterval);
        stopPaymentStatusPolling();
        stopGobizMatchPolling();
        showMessage('Pembayaran gagal. Silakan coba lagi.', 'danger');
        return;
    }

    setPaymentStatus('pending', 'Status pembayaran: Menunggu pembayaran');
}

function startPaymentStatusPolling(transactionId) {
    stopPaymentStatusPolling();
    if (!transactionId) {
        return;
    }

    paymentStatusInterval = setInterval(async function() {
        try {
            const statusData = await fetchPaymentStatus(transactionId);
            handlePaymentStatus(statusData.status);
        } catch {
            // ignore polling errors
        }
    }, 4000);
}

function stopGobizMatchPolling() {
    if (gobizMatchInterval) {
        clearInterval(gobizMatchInterval);
        gobizMatchInterval = null;
    }
}

function clearPostPaymentResetTimeout() {
    if (postPaymentResetTimeout) {
        clearTimeout(postPaymentResetTimeout);
        postPaymentResetTimeout = null;
    }
}

function hideGobizMatchCard() {
    const card = document.getElementById('gobizMatchCard');
    if (card) {
        card.style.display = 'none';
    }
    currentGobizMatch = null;
}

function showGobizMatchCard(match) {
    const card = document.getElementById('gobizMatchCard');
    if (!card || !match) {
        return;
    }

    currentGobizMatch = match;

    document.getElementById('gobizOrderId').textContent = match.orderId || '-';
    document.getElementById('gobizAmount').textContent = formatCurrency(Number(match.amount || 0));
    document.getElementById('gobizStatus').textContent = String(match.status || '-').toUpperCase();
    document.getElementById('gobizSettlementTime').textContent = match.settlementTime
        ? new Date(match.settlementTime).toLocaleString('id-ID')
        : '-';
    document.getElementById('gobizGopayId').textContent = match.gopayTransactionId || '-';
    card.style.display = 'block';
    console.log('[GobizMatch] match ditemukan:', match);
}

function resetGeneratedPaymentState() {
    clearInterval(countdownInterval);
    stopPaymentStatusPolling();
    stopGobizMatchPolling();

    timeLeft = 900;
    currentQRData = null;
    currentPayAmount = null;
    currentTransactionId = null;
    currentPaymentStatus = null;
    currentPaymentCreatedAt = null;

    const amountInput = document.getElementById('amountInput');
    if (amountInput) {
        amountInput.value = '';
    }

    syncUrlParams({ pay: null });
    document.getElementById('amountDisplay').textContent = formatCurrency(0);
    document.getElementById('countdown').textContent = '15:00';

    const timerSection = document.getElementById('timerSection');
    timerSection.style.background = '';
    timerSection.style.color = '';

    document.getElementById('merchantDisplay').style.display = 'none';
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('qrContainer').innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-receipt" style="font-size: 2.4rem; color: var(--accent); margin-bottom: 12px;"></i>
            <p style="color: var(--text-secondary); margin-bottom: 6px;">Pembayaran selesai terdeteksi</p>
            <small style="color: var(--text-muted);">Masukkan nominal baru untuk membuat QRIS berikutnya.</small>
        </div>
    `;

    setPaymentStatus('pending', 'Status pembayaran: Siap untuk transaksi baru');
}

function schedulePostPaymentReset() {
    clearPostPaymentResetTimeout();
    postPaymentResetTimeout = setTimeout(() => {
        resetGeneratedPaymentState();
        showMessage('Transaksi selesai. Nominal dan QRIS dinamis sudah direset.', 'success');
    }, 2500);
}

function copyGobizReference() {
    const value =
        (currentGobizMatch && (currentGobizMatch.gopayTransactionId || currentGobizMatch.referenceId || currentGobizMatch.orderId)) || '';

    if (!value) {
        showMessage('Reference Gobiz belum tersedia.', 'warning');
        return;
    }

    navigator.clipboard.writeText(value)
        .then(() => showMessage('Reference Gobiz berhasil disalin.', 'success'))
        .catch(() => showMessage('Gagal menyalin reference Gobiz.', 'danger'));
}

async function fetchGobizMatch(amount, fromTimeISO, toTimeISO) {
    console.log('[GobizMatch] request', { amount, fromTimeISO, toTimeISO });
    const response = await fetch('/api/gobiz/journals/match', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount,
            fromTimeISO,
            toTimeISO,
            size: 20
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Gagal cek match Gobiz');
    }
    console.log('[GobizMatch] response', data);
    return data;
}

function startGobizMatchPolling(amount, createdAtISO) {
    stopGobizMatchPolling();
    if (!amount || !createdAtISO) {
        return;
    }

    const fromTimeISO = new Date(new Date(createdAtISO).getTime() - (2 * 60 * 1000)).toISOString();
    console.log('[GobizMatch] polling dimulai', { amount, createdAtISO, fromTimeISO });

    gobizMatchInterval = setInterval(async function() {
        try {
            const toTimeISO = new Date().toISOString();
            const matchData = await fetchGobizMatch(amount, fromTimeISO, toTimeISO);
            if (matchData.found && matchData.match) {
                showGobizMatchCard(matchData.match);
                setPaymentStatus('paid', 'Status pembayaran: Match ditemukan di Gobiz');
                currentPaymentStatus = 'PAID';
                stopGobizMatchPolling();
                schedulePostPaymentReset();
            } else {
                console.log('[GobizMatch] belum ada match');
            }
        } catch (error) {
            console.error('[GobizMatch] error polling', error);
        }
    }, 5000);
}

function renderAwaitingQrisState() {
    clearPostPaymentResetTimeout();
    document.getElementById('qrContainer').innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-image" style="font-size: 3rem; color: var(--primary); margin-bottom: 16px;"></i>
            <p style="color: var(--text-secondary); margin-bottom: 8px;">Upload gambar QRIS statis</p>
            <small style="color: var(--text-muted);">Setelah payload terbaca, QRIS dinamis akan dibuat otomatis.</small>
        </div>
    `;
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('merchantDisplay').style.display = 'none';
    hideGobizMatchCard();
    setPaymentStatus('pending', 'Status pembayaran: Menunggu upload QRIS');
}

async function restartPaymentFlow(qrisUtama, amount) {
    clearPostPaymentResetTimeout();
    stopGobizMatchPolling();
    stopPaymentStatusPolling();
    clearInterval(countdownInterval);
    timeLeft = 900;
    currentQRData = null;
    currentPayAmount = amount;
    currentTransactionId = null;
    currentPaymentStatus = null;
    currentPaymentCreatedAt = null;
    hideGobizMatchCard();

    const timerSection = document.getElementById('timerSection');
    timerSection.style.background = '';
    timerSection.style.color = '';

    document.getElementById('merchantDisplay').style.display = 'none';
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('qrContainer').innerHTML = `
        <div class="loading-spinner">
            <div class="spinner"></div>
            <p>Generating QR Code...</p>
        </div>
    `;

    setPaymentStatus('pending', 'Status pembayaran: Menunggu pembayaran');

    const generated = await generateQRIS(qrisUtama, amount);
    if (generated) {
        startCountdown();
    }
}

function renderInvalidQrisState() {
    clearPostPaymentResetTimeout();
    document.getElementById('qrContainer').innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-triangle-exclamation" style="font-size: 3rem; color: var(--danger); margin-bottom: 16px;"></i>
            <p style="color: var(--text-secondary); margin-bottom: 8px;">Payload QRIS statis tidak valid</p>
            <small style="color: var(--danger);">Upload gambar QRIS statis yang valid pada bagian pengaturan.</small>
        </div>
    `;
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('merchantDisplay').style.display = 'none';
    hideGobizMatchCard();
}

function renderEmptyAmountState() {
    clearPostPaymentResetTimeout();
    document.getElementById('amountDisplay').textContent = formatCurrency(0);
    document.getElementById('qrContainer').innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-money-bill-wave" style="font-size: 3rem; color: var(--primary); margin-bottom: 16px;"></i>
            <p style="color: var(--text-secondary); margin-bottom: 8px;">Masukkan nominal pembayaran</p>
            <small style="color: var(--text-muted);">Contoh: 10000 atau nominal lain sesuai kebutuhan.</small>
        </div>
    `;
    document.getElementById('actionButtons').style.display = 'none';
    document.getElementById('merchantDisplay').style.display = 'none';
    hideGobizMatchCard();
    setPaymentStatus('pending', 'Status pembayaran: Isi nominal untuk mulai');
}

function resolveQrisUtama() {
    const candidates = [
        urlParams.get('qris'),
        localStorage.getItem(QRIS_STORAGE_KEY)
    ];

    for (const candidate of candidates) {
        const validation = validateQrisPayload(candidate);
        if (validation.valid) {
            localStorage.setItem(QRIS_STORAGE_KEY, validation.payload);
            return validation.payload;
        }
    }

    return null;
}

function normalizeQrisPayload(rawPayload) {
    if (!rawPayload) {
        return '';
    }

    return String(rawPayload).replace(/[\r\n\t]/g, '').trim();
}

function calculateCrc16Ccitt(input) {
    let crc = 0xFFFF;
    for (let i = 0; i < input.length; i++) {
        crc ^= input.charCodeAt(i) << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function validateQrisPayload(rawPayload) {
    const payload = normalizeQrisPayload(rawPayload);

    if (!payload) {
        return { valid: false, error: 'Payload kosong.' };
    }

    if (payload.length < 20) {
        return { valid: false, error: 'Payload terlalu pendek.' };
    }

    if (!payload.startsWith('000201')) {
        return { valid: false, error: 'Header EMV tidak dikenali.' };
    }

    const crcTagIndex = payload.lastIndexOf('6304');
    if (crcTagIndex < 0) {
        return { valid: false, error: 'Tag CRC (6304) tidak ditemukan.' };
    }

    if (crcTagIndex + 8 !== payload.length) {
        return { valid: false, error: 'CRC harus berada di akhir payload.' };
    }

    const expectedCrc = payload.slice(crcTagIndex + 4).toUpperCase();
    if (!/^[0-9A-F]{4}$/.test(expectedCrc)) {
        return { valid: false, error: 'Format CRC tidak valid.' };
    }

    const payloadForChecksum = payload.slice(0, crcTagIndex + 4);
    const calculatedCrc = calculateCrc16Ccitt(payloadForChecksum);

    if (expectedCrc !== calculatedCrc) {
        return { valid: false, error: `CRC tidak cocok (expected ${calculatedCrc}).` };
    }

    return { valid: true, payload };
}

function parsePayAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 1) {
        return null;
    }
    return Math.floor(amount);
}

function syncUrlParams(updates) {
    const nextParams = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === '') {
            nextParams.delete(key);
            urlParams.delete(key);
        } else {
            nextParams.set(key, value);
            urlParams.set(key, value);
        }
    }

    const nextQuery = nextParams.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
}

function sanitizeFileName(input) {
    const normalized = String(input || 'Merchant').trim().toLowerCase();
    const cleaned = normalized
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return cleaned || 'merchant';
}

// Theme
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeIcon(savedTheme);
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeIcon(newTheme);
}

function updateThemeIcon(theme) {
    const icon = document.querySelector('#themeToggle i');
    icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}

// Countdown
function startCountdown() {
    updateCountdownDisplay();
    countdownInterval = setInterval(() => {
        timeLeft--;
        updateCountdownDisplay();

        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            stopPaymentStatusPolling();
            stopGobizMatchPolling();
            setPaymentStatus('expired', 'Status pembayaran: Kedaluwarsa');
            showMessage('QR Code telah kedaluwarsa. Silakan masukkan ulang nominal atau refresh halaman.', 'warning');
            document.getElementById('qrContainer').innerHTML = `
                <div style="text-align: center;">
                    <i class="fas fa-clock" style="font-size: 3rem; color: var(--warning); margin-bottom: 16px;"></i>
                    <p style="color: var(--text-secondary); margin-bottom: 16px;">QR Code Kedaluwarsa</p>
                    <button onclick="location.reload()" class="btn-action btn-download">
                        <i class="fas fa-redo"></i>
                        <span>Refresh</span>
                    </button>
                </div>
            `;
            document.getElementById('actionButtons').style.display = 'none';
        }
    }, 1000);
}

function updateCountdownDisplay() {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    const countdownEl = document.getElementById('countdown');
    countdownEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    const timerSection = document.getElementById('timerSection');
    if (timeLeft <= 60) {
        timerSection.style.background = '#FFE6E6';
        timerSection.style.color = '#D63031';
        if (document.documentElement.getAttribute('data-theme') === 'dark') {
            timerSection.style.background = 'rgba(255, 107, 107, 0.15)';
            timerSection.style.color = '#FF6B6B';
        }
    }
}

// Format Currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(amount);
}

// Show Message
function showMessage(text, type = 'danger') {
    const alertClass = type === 'success' ? 'alert-success' :
        type === 'warning' ? 'alert-warning' : 'alert-danger';
    const icon = type === 'success' ? 'check-circle' :
        type === 'warning' ? 'exclamation-triangle' : 'times-circle';

    document.getElementById('messageContainer').innerHTML = `
        <div class="alert ${alertClass}" role="alert">
            <i class="fas fa-${icon}" style="margin-right: 8px;"></i>${text}
        </div>
    `;

    setTimeout(() => {
        const alert = document.querySelector('.alert');
        if (alert) {
            alert.style.opacity = '0';
            alert.style.transition = 'opacity 0.3s ease';
            setTimeout(() => alert.remove(), 300);
        }
    }, 4000);
}

async function createPayment(qrisPayload, amount) {
    const response = await fetch('/api/payments/create', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount,
            qrisPayload
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Gagal membuat pembayaran');
    }
    return data;
}

async function fetchPaymentStatus(transactionId) {
    const response = await fetch(`/api/payments/${encodeURIComponent(transactionId)}/status`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Gagal cek status pembayaran');
    }
    return data;
}

// Generate QRIS
async function generateQRIS(qrisUtama, amount) {
    try {
        document.getElementById('amountDisplay').textContent = formatCurrency(amount);

        const data = await createPayment(qrisUtama, amount);
        console.log('[Payment] create response', data);
        const qrString = data.qrString;
        if (!qrString) {
            throw new Error('QR string tidak tersedia');
        }

        currentTransactionId = data.transactionId || null;
        currentPaymentStatus = data.status || 'PENDING';
        currentPaymentCreatedAt = data.createdAt || new Date().toISOString();
        currentQRData = qrString;
        handlePaymentStatus(currentPaymentStatus);

        if (data.merchant) {
            document.getElementById('displayMerchantName').textContent = data.merchant;
            document.getElementById('merchantDisplay').style.display = 'flex';
        }

        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, qrString, {
            width: 240,
            margin: 2,
            color: { dark: '#1A1D3D', light: '#FFFFFF' },
            errorCorrectionLevel: 'H'
        });

        const qrContainer = document.getElementById('qrContainer');
        qrContainer.style.opacity = '0';
        qrContainer.innerHTML = '';
        qrContainer.appendChild(canvas);

        requestAnimationFrame(() => {
            qrContainer.style.transition = 'opacity 0.4s ease';
            qrContainer.style.opacity = '1';
        });

        document.getElementById('actionButtons').style.display = 'grid';
        startPaymentStatusPolling(currentTransactionId);
        startGobizMatchPolling(amount, currentPaymentCreatedAt);
        return true;
    } catch (error) {
        document.getElementById('qrContainer').innerHTML = `
            <div style="text-align: center;">
                <i class="fas fa-exclamation-circle" style="font-size: 3rem; color: var(--danger); margin-bottom: 16px;"></i>
                <p style="color: var(--text-secondary); margin-bottom: 8px;">Gagal membuat QR Code</p>
                <small style="color: var(--danger);">${error.message}</small>
                <button onclick="location.reload()" class="btn-action btn-download" style="margin-top: 16px;">
                    <i class="fas fa-redo"></i>
                    <span>Coba Lagi</span>
                </button>
            </div>
        `;
        showMessage(`Terjadi kesalahan: ${error.message}`);
        return false;
    }
}

// Download QR
function downloadQR() {
    const canvas = document.querySelector('#qrContainer canvas');
    if (canvas && currentPayAmount) {
        const merchant = document.getElementById('displayMerchantName').textContent || 'Merchant';
        const safeMerchant = sanitizeFileName(merchant);
        const link = document.createElement('a');
        link.download = `qris-${safeMerchant}-${currentPayAmount}.png`;
        link.href = canvas.toDataURL();
        link.click();
        showMessage('QR Code berhasil didownload!', 'success');
    }
}

// Copy QR
function copyQRCode() {
    if (currentQRData) {
        navigator.clipboard.writeText(currentQRData)
            .then(() => showMessage('Kode QRIS berhasil disalin!', 'success'))
            .catch(() => showMessage('Gagal menyalin kode QRIS'));
    }
}

// Share QR
function shareQR() {
    if (navigator.share && currentQRData && currentPayAmount) {
        navigator.share({
            title: 'QRIS Payment - mrpinguiiin',
            text: `Pembayaran ${formatCurrency(currentPayAmount)} via QRIS`,
            url: window.location.href
        });
    } else {
        navigator.clipboard.writeText(window.location.href).then(() => {
            showMessage('Link pembayaran berhasil disalin!', 'success');
        });
    }
}
