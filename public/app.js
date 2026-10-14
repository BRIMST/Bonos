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
let clockState = null; // { endMs, offset } offset = hora del servidor - hora del dispositivo

/* ---------- Estado del evento y cuenta regresiva ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
const fmtEnd = iso => new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(new Date(iso));
function tick() {
  if (!clockState || isClosed) return;
  const left = Math.floor((clockState.endMs - (Date.now() + clockState.offset)) / 1000);
  if (left <= 0) { loadStatus(); return; }
  countdown.textContent = `${pad(Math.floor(left / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
  clock.classList.toggle('low', left <= 900);
}
function applyClosed(closed, hasEvent) {
  isClosed = closed;
  clock.classList.toggle('closed', closed);
  if (closed) {
    countdown.textContent = hasEvent ? 'Evento cerrado' : 'Próximamente';
    clockLabel.textContent = hasEvent ? 'Espera el próximo evento' : 'Aún no hay evento abierto';
    clock.classList.remove('low');
  } else clockLabel.textContent = 'Tiempo para el cierre del evento';
  submitBtn.disabled = closed;
  submitBtn.textContent = closed ? (hasEvent ? 'Evento cerrado' : 'Sin evento abierto') : 'Enviar registro';
}
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    if (!res.ok) throw new Error(s.error || 'Error');
    paymentKey = s.brebValue;
    document.querySelector('#brebLabel').textContent = s.brebLabel;
    document.querySelector('#brebValue').textContent = s.brebValue;
    const ev = s.event || {};
    clockState = ev.active ? { endMs: Date.parse(ev.endIso), offset: Date.parse(ev.serverNowIso) - Date.now() } : null;
    renderPrize(s.prize);
    renderWinner(s.winner);
    renderProfile(s.profile);
    applyClosed(!ev.active, ev.exists);
    if (ev.active) {
      statusBox.textContent = `Evento abierto. Recibimos registros y verificamos pagos hasta el ${fmtEnd(ev.endIso)} (hora de Colombia). Tu número juega en la Quinta de ese día, que sale a las 10:30 p. m.`;
    } else if (ev.exists) {
      statusBox.textContent = 'El evento ya cerró. Los registros no se trasladan al siguiente evento: cuando se abra uno nuevo podrás participar con un nuevo registro y pago.';
    } else {
      statusBox.textContent = 'Todavía no hay un evento abierto. Estate atento a los anuncios: aquí aparecerá la cuenta regresiva cuando inicie.';
    }
    statusBox.className = `notice ${ev.active ? 'success' : 'warning'}`;
    tick();
  } catch (err) {
    statusBox.textContent = 'No pudimos consultar el estado del servicio. Recarga la página en unos segundos.';
    statusBox.className = 'notice warning';
  }
}
setInterval(tick, 1000);

/* ---------- Premio ---------- */
const copFmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
function renderPrize(p) {
  const box = document.querySelector('#prize');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  document.querySelector('#prizeName').textContent = p.name;
  document.querySelector('#prizeDesc').textContent = p.description;
  document.querySelector('#prizeDesc').classList.toggle('hidden', !p.description);
  const picBox = document.querySelector('#prizePicBox');
  const pic = document.querySelector('#prizePic');
  picBox.classList.toggle('hidden', !p.imageVersion);
  if (p.imageVersion) { const src = `/api/prize-image?v=${p.imageVersion}`; if (pic.getAttribute('src') !== src) pic.src = src; pic.alt = `Premio: ${p.name}`; }
  const choice = document.querySelector('#prizeChoice');
  document.querySelector('#prizeKicker').textContent = p.mode === 'ambos' ? 'Si ganas, tú eliges' : 'El premio de este evento';
  const opt = (title, sub) => `<div class="opt"><b>${title}</b><span>${sub}</span></div>`;
  choice.innerHTML = p.mode === 'premio' ? opt('El premio', 'Se entrega al ganador')
    : p.mode === 'dinero' ? opt(copFmt(p.cashCop), 'En efectivo para el ganador')
    : opt('El premio', 'Tal como se ve aquí') + '<span class="or">o</span>' + opt(copFmt(p.cashCop), 'En efectivo');
}

/* ---------- Número ganador: burbujas que se revientan ---------- */
let winnerKey = '', popped = 0, audioCtx = null;
const bubblesBox = document.querySelector('#bubbles');
function popSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(520 + Math.random() * 260, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.12);
    g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.14);
  } catch { /* sin sonido */ }
}
function fmtLongDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
function buildBubbles(w) {
  bubblesBox.innerHTML = '';
  popped = 0;
  document.querySelector('#winnerResult').classList.add('hidden');
  document.querySelector('#replayBubbles').classList.add('hidden');
  document.querySelector('#popAll').disabled = false;
  for (let i = 0; i < 5; i++) {
    const cell = document.createElement('div');
    cell.className = 'bcell';
    cell.innerHTML = '<div class="bdigit" aria-hidden="true">?</div>' +
      `<button type="button" class="bubble" style="--d:${i * 0.35}s" aria-label="Reventar burbuja ${i + 1} de 5"></button>`;
    cell.querySelector('.bubble').addEventListener('click', () => popBubble(cell, w));
    bubblesBox.appendChild(cell);
  }
}
function popBubble(cell, w, silent) {
  const btn = cell.querySelector('.bubble');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const idx = [...bubblesBox.children].indexOf(cell);
  const digit = cell.querySelector('.bdigit');
  digit.textContent = w.number[idx]; digit.setAttribute('aria-hidden', 'false');
  digit.classList.add('shown');
  if (!reduceMotion) {
    btn.classList.add('pop');
    for (let k = 0; k < 12; k++) {
      const drop = document.createElement('i');
      const ang = (k / 12) * 6.283 + Math.random() * 0.4, dist = 46 + Math.random() * 34;
      drop.style.setProperty('--x', `${Math.cos(ang) * dist}px`); drop.style.setProperty('--y', `${Math.sin(ang) * dist}px`);
      cell.appendChild(drop); setTimeout(() => drop.remove(), 700);
    }
    setTimeout(() => btn.remove(), 260);
  } else btn.remove();
  if (!silent) popSound();
  popped++;
  const left = 5 - popped;
  document.querySelector('#winnerSub').textContent = left ? `Faltan ${left} ${left === 1 ? 'burbuja' : 'burbujas'} por reventar.` : 'Este es el número ganador.';
  if (!left) finishReveal(w);
}
function finishReveal(w) {
  document.querySelector('#popAll').disabled = true;
  document.querySelector('#replayBubbles').classList.remove('hidden');
  const res = document.querySelector('#winnerResult');
  res.innerHTML = `¡Felicitaciones al ganador! Si tu número es <b>${w.number}</b>, escríbenos para entregarte tu premio. Gracias a toda la comunidad por apoyar.`;
  res.classList.remove('hidden');
  setTimeout(launchConfetti, reduceMotion ? 0 : 250);
}
function renderWinner(w) {
  const box = document.querySelector('#winner');
  if (!w) { box.classList.add('hidden'); winnerKey = ''; return; }
  box.classList.remove('hidden');
  const key = `${w.number}-${w.version}`;
  document.querySelector('#winnerTitle').textContent = w.date ? `¡Ya tenemos número ganador del ${fmtLongDate(w.date)}!` : '¡Ya tenemos número ganador!';
  if (key === winnerKey) return; // no reiniciar si el usuario ya está reventando burbujas
  winnerKey = key;
  document.querySelector('#winnerSub').textContent = 'Toca cada burbuja para revelar el número, o revienta todas de una vez.';
  buildBubbles(w);
  currentWinner = w;
}
let currentWinner = null;
document.querySelector('#popAll').addEventListener('click', () => {
  if (!currentWinner) return;
  popSound();
  [...bubblesBox.children].forEach((cell, i) => setTimeout(() => popBubble(cell, currentWinner, true), reduceMotion ? 0 : i * 170));
});
document.querySelector('#replayBubbles').addEventListener('click', () => {
  if (!currentWinner) return;
  document.querySelector('#winnerSub').textContent = 'Toca cada burbuja para revelar el número, o revienta todas de una vez.';
  buildBubbles(currentWinner);
});

/* ---------- Quiénes somos e historial ---------- */
function renderProfile(p) {
  const box = document.querySelector('#about');
  if (!p) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  document.querySelector('#aboutName').textContent = p.name;
  const bio = document.querySelector('#aboutBio');
  bio.textContent = p.bio; bio.classList.toggle('hidden', !p.bio);
  const links = document.querySelector('#aboutLinks');
  links.innerHTML = '';
  p.links.forEach(l => {
    const a = document.createElement('a');
    a.href = l.url; a.textContent = l.label; a.target = '_blank'; a.rel = 'noopener nofollow';
    links.appendChild(a);
  });
}
async function loadHistory() {
  try {
    const res = await fetch('/api/winners');
    if (!res.ok) return;
    const { winners } = await res.json();
    const box = document.querySelector('#history');
    box.classList.toggle('hidden', !winners.length);
    document.querySelector('#historyList').innerHTML = winners.map(w => `<li><span>${fmtLongDate(w.date)}</span><b>${w.number}</b></li>`).join('');
  } catch { /* sin historial */ }
}

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
loadHistory();
