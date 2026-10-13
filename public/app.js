const form = document.querySelector('#registerForm');
const statusBox = document.querySelector('#status');
const message = document.querySelector('#formMessage');
const submitBtn = document.querySelector('#submitBtn');
const numberInput = form.querySelector('[name="number"]');
const clock = document.querySelector('#clock');
const countdown = document.querySelector('#countdown');
const clockLabel = document.querySelector('#clockLabel');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let paymentKey = '';
let isClosed = false;
let clockState = null; // { secs: segundos del día en el servidor, at: Date.now() al consultarlo }

/* ---------- Estado de la jornada y cuenta regresiva ---------- */
function toSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
function pad(n) { return String(n).padStart(2, '0'); }
function tick() {
  if (!clockState) return;
  const now = clockState.secs + (Date.now() - clockState.at) / 1000;
  const left = Math.floor(19 * 3600 - now);
  if (left <= 0) {
    if (!isClosed) loadStatus();
    return;
  }
  countdown.textContent = `${pad(Math.floor(left / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  clock.classList.toggle('low', left <= 900);
}
function applyClosed(closed) {
  isClosed = closed;
  clock.classList.toggle('closed', closed);
  if (closed) { countdown.textContent = 'Jornada cerrada'; clockLabel.textContent = 'Vuelve mañana'; clock.classList.remove('low'); }
  else clockLabel.textContent = 'Tiempo para el cierre';
  submitBtn.disabled = closed;
  submitBtn.textContent = closed ? 'Jornada cerrada' : 'Enviar registro';
}
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    if (!res.ok) throw new Error(s.error || 'Error');
    paymentKey = s.brebValue;
    document.querySelector('#brebLabel').textContent = s.brebLabel;
    document.querySelector('#brebValue').textContent = s.brebValue;
    clockState = { secs: toSeconds(s.time), at: Date.now() };
    applyClosed(s.closed);
    statusBox.textContent = s.closed
      ? `La jornada de hoy (${s.date}) cerró a las 7:00 p. m. Los registros no se trasladan al día siguiente: vuelve mañana con un nuevo registro y pago.`
      : `Jornada de hoy: ${s.date}. Recibimos registros y verificamos pagos hasta las 7:00 p. m. (hora de Colombia).`;
    statusBox.className = `notice ${s.closed ? 'warning' : 'success'}`;
    tick();
  } catch (err) {
    statusBox.textContent = 'No pudimos consultar el estado del servicio. Recarga la página en unos segundos.';
    statusBox.className = 'notice warning';
  }
}
setInterval(tick, 1000);

/* ---------- Copiar llave ---------- */
document.querySelector('#copyKey').addEventListener('click', async e => {
  try {
    await navigator.clipboard.writeText(paymentKey);
    e.target.textContent = '¡Copiada!';
    setTimeout(() => { e.target.textContent = 'Copiar llave'; }, 2000);
  } catch {
    alert(`Copia manualmente la llave: ${paymentKey}`);
  }
});

/* ---------- Boleto con los dígitos ---------- */
function renderDigits(container, value, animate) {
  container.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const d = document.createElement('div');
    d.className = 'digit' + (value[i] ? '' : ' empty');
    d.textContent = value[i] || '0';
    if (animate && i === value.length - 1) d.classList.add('pop');
    container.appendChild(d);
  }
}
const ticketDigits = document.querySelector('#digits');
renderDigits(ticketDigits, '', false);
numberInput.addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5);
  renderDigits(ticketDigits, e.target.value, true);
  setTimeout(() => ticketDigits.querySelector('.pop')?.classList.remove('pop'), 150);
});
form.querySelector('[name="phone"]').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
});

/* ---------- Comprobante: se reduce para caber en Firestore ---------- */
const MAX_BYTES = 780 * 1024;
let receiptFile = null;
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) return new File([blob], 'comprobante.jpg', { type: 'image/jpeg' });
    }
    scale *= 0.75;
  }
  throw new Error('No se pudo reducir la imagen. Usa una captura de pantalla más liviana.');
}
form.querySelector('[name="receipt"]').addEventListener('change', async e => {
  const f = e.target.files[0];
  receiptFile = null;
  if (!f) return;
  try {
    if (f.type === 'application/pdf') {
      if (f.size > MAX_BYTES) throw new Error('El PDF supera 780 KB. Envía una captura de pantalla (JPG o PNG) del comprobante.');
      receiptFile = f;
    } else if (f.type === 'image/jpeg' || f.type === 'image/png') {
      receiptFile = f.size > MAX_BYTES ? await shrinkImage(f) : f;
    } else throw new Error('Solo se permiten JPG, PNG o PDF.');
    message.textContent = ''; message.className = 'notice';
  } catch (err) {
    e.target.value = '';
    message.textContent = err.message;
    message.className = 'notice error';
  }
});

/* ---------- Agradecimiento: tarjeta + confeti ---------- */
const overlay = document.querySelector('#success');
const closeBtn = document.querySelector('#closeSuccess');
const canvas = document.querySelector('#confetti');
let confettiRaf = 0;
function launchConfetti() {
  if (reduceMotion) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#ffc82e', '#ff5a5f', '#16b47c', '#4b2fd0', '#ffffff', '#5cc8ff'];
  const parts = Array.from({ length: 150 }, (_, i) => ({
    x: innerWidth * (i % 2 ? 0.15 : 0.85), y: innerHeight * 0.55,
    vx: (Math.random() - 0.5) * 16 + (i % 2 ? 4 : -4), vy: -Math.random() * 17 - 6,
    w: 6 + Math.random() * 7, h: 9 + Math.random() * 8, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
    color: colors[i % colors.length], life: 0
  }));
  const start = performance.now();
  cancelAnimationFrame(confettiRaf);
  (function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.38; p.vx *= 0.992; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (4200 - t) / 900));
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (t < 4200) confettiRaf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}
function showThanks(number, id) {
  renderDigits(document.querySelector('#thanksDigits'), number, false);
  document.querySelector('#thanksCode').textContent = `Código de registro: ${id}`;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  launchConfetti();
  closeBtn.focus();
}
function hideThanks() {
  overlay.classList.add('hidden');
  document.body.style.overflow = '';
  cancelAnimationFrame(confettiRaf);
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}
closeBtn.addEventListener('click', hideThanks);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.classList.contains('hidden')) hideThanks(); });

/* ---------- Envío ---------- */
form.addEventListener('submit', async e => {
  e.preventDefault();
  if (isClosed) return;
  message.textContent = 'Enviando tu registro…';
  message.className = 'notice';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Enviando…';
  try {
    const data = new FormData(form);
    if (receiptFile) data.set('receipt', receiptFile, receiptFile.name);
    const registered = numberInput.value;
    const res = await fetch('/api/register', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'No se pudo registrar.');
    message.textContent = '';
    message.className = 'notice';
    form.reset();
    receiptFile = null;
    renderDigits(ticketDigits, '', false);
    showThanks(registered, result.id);
    await loadStatus();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'notice error';
  } finally {
    if (!isClosed) { submitBtn.disabled = false; submitBtn.textContent = 'Enviar registro'; }
  }
});
loadStatus();
