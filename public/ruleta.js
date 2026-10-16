(() => {
  const $ = s => document.querySelector(s);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const copFmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
  const COLORS = ['#4b2fd0', '#ff5a5f', '#ffc82e', '#16b47c', '#7a5cff', '#ff8a3d'];
  const TAU = Math.PI * 2;
  const canvas = $('#wheel'), ctx = canvas.getContext('2d');
  const STATUS = { abierta: 'En curso · inscripciones abiertas', cerrada: 'En curso · inscripciones cerradas', sorteada: 'Finalizado', cancelada: 'Cancelado' };

  const demoMode = new URLSearchParams(location.search).has('demo');
  const demo = { active: false };
  const picked = new Set();
  let gridSig = '', paymentKey = '', lastTick = -1;
  let data = null, seats = [], theta = 0, raf = 0, offset = 0;
  let seenVersion = null, animatingVersion = null, winnerSlice = -1, imgVersion = null;

  const mod = (x, m) => ((x % m) + m) % m;
  const ease = p => 1 - Math.pow(1 - p, 4);

  /* ---------- Dibujo de la rueda ---------- */
  function size() {
    const w = Math.min(canvas.parentElement.clientWidth, 640), dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = canvas.height = Math.round(w * dpr); canvas.style.width = canvas.style.height = w + 'px'; }
    return w;
  }
  function draw() {
    const w = size(), dpr = window.devicePixelRatio || 1, c = canvas.width / 2, r = c - 6 * dpr;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const n = seats.length;
    if (!n) {
      ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.fillStyle = '#2b2370'; ctx.fill();
      ctx.lineWidth = 6 * dpr; ctx.strokeStyle = '#ffc82e'; ctx.stroke(); return;
    }
    const a = TAU / n;
    ctx.save(); ctx.translate(c, c); ctx.rotate(theta);
    for (let i = 0; i < n; i++) {
      const s0 = -Math.PI / 2 + i * a;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, s0, s0 + a); ctx.closePath();
      const dim = winnerSlice >= 0 && i !== winnerSlice;
      ctx.fillStyle = COLORS[i % COLORS.length]; ctx.globalAlpha = dim ? 0.28 : 1; ctx.fill(); ctx.globalAlpha = 1;
      if (n <= 120) { ctx.lineWidth = Math.max(1, dpr); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke(); }
      if (n <= 60) {
        ctx.save(); ctx.rotate(s0 + a / 2 + Math.PI / 2);
        ctx.fillStyle = COLORS[i % COLORS.length] === '#ffc82e' ? '#1a1446' : '#fff'; ctx.globalAlpha = dim ? 0.5 : 1;
        ctx.font = `800 ${Math.max(10, Math.min(r * 0.12, r * Math.PI * 1.1 / n * 0.8)) }px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(seats[i]), 0, -r * 0.8);
        ctx.restore();
      }
    }
    if (winnerSlice >= 0) {
      const s0 = -Math.PI / 2 + winnerSlice * a;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, s0, s0 + a); ctx.closePath();
      ctx.lineWidth = 6 * dpr; ctx.strokeStyle = '#ffc82e'; ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.lineWidth = 8 * dpr; ctx.strokeStyle = '#ffc82e'; ctx.stroke();
    const hub = $('#hub'); hub.style.width = hub.style.height = Math.round(w * 0.24) + 'px';
  }
  const seatUnder = th => seats.length ? Math.floor(mod(-th, TAU) / (TAU / seats.length)) : -1;
  function setHub(label, num, cls) {
    $('#hubLabel').textContent = label; $('#hubNum').textContent = num;
    $('#hub').className = 'hub' + (cls ? ' ' + cls : '');
  }

  /* ---------- Sonido (se activa con el botón; los navegadores no permiten sonar solos) ---------- */
  let soundOn = false, actx = null;
  function beep(freq, dur = 0.05, vol = 0.07, type = 'square', delay = 0) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + delay;
      o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur);
    } catch { /* sin sonido */ }
  }
  $('#soundBtn').addEventListener('click', e => {
    soundOn = !soundOn; e.currentTarget.textContent = soundOn ? '🔊 Sonido' : '🔇 Sonido'; e.currentTarget.setAttribute('aria-pressed', soundOn);
    if (soundOn) beep(660, 0.08, 0.05, 'sine');
  });
  const fanfare = () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.28, 0.09, 'triangle', i * 0.16));

  /* ---------- Giro sincronizado ---------- */
  function finalTheta(idx) {
    const a = TAU / seats.length, jitter = (((data.spinVersion % 97) / 97) - 0.5) * 0.6;
    return 6 * TAU + (TAU - (idx + 0.5 + jitter) * a);
  }
  function runSpin() {
    cancelAnimationFrame(raf);
    const idx = seats.indexOf(data.winnerSeat), target = finalTheta(idx);
    const startAt = Date.parse(data.spinStartsAtIso), dur = data.spinMs;
    const frame = () => {
      const t = Date.now() + offset - startAt;
      if (t < 0) { setHub('Prepárense', Math.ceil(-t / 1000), 'wait'); raf = requestAnimationFrame(frame); return; }
      const p = Math.min(1, t / dur);
      theta = target * ease(p);
      const i = seatUnder(theta);
      setHub('Puesto', seats[i] ?? '', 'spin');
      if (i !== lastTick) { lastTick = i; beep(880 + (i % 5) * 40, 0.025, 0.05); }
      draw();
      if (p < 1) { raf = requestAnimationFrame(frame); return; }
      finish(idx);
    };
    frame();
  }
  function finish(idx) {
    animatingVersion = null; winnerSlice = idx; theta = finalTheta(idx);
    setHub('Ganador', seats[idx], 'win'); draw(); renderGrid();
    fanfare(); showWinner();
  }
  function showFinalNow() {
    const idx = seats.indexOf(data.winnerSeat);
    winnerSlice = idx; theta = finalTheta(idx);
    setHub('Ganador', data.winnerSeat, 'win'); draw(); renderGrid();
  }

  /* ---------- Ganador + confeti ---------- */
  const confetti = $('#liveConfetti'), cx = confetti.getContext('2d');
  function showWinner() {
    $('#winnerSeatNum').textContent = '#' + data.winnerSeat;
    $('#winnerHead').textContent = demo.active ? 'ENSAYO: así se verá el ganador' : '¡Tenemos ganador!';
    $('#liveWinner').classList.remove('hidden');
    if (!reduceMotion) burst();
  }
  $('#winnerClose').addEventListener('click', () => $('#liveWinner').classList.add('hidden'));
  function burst() {
    confetti.width = innerWidth; confetti.height = innerHeight;
    const parts = Array.from({ length: 160 }, () => ({ x: innerWidth / 2, y: innerHeight * 0.45, vx: (Math.random() - .5) * 16, vy: -Math.random() * 15 - 3,
      s: 6 + Math.random() * 7, c: COLORS[Math.floor(Math.random() * COLORS.length)], r: Math.random() * 6, vr: (Math.random() - .5) * .4 }));
    const t0 = performance.now();
    (function f(now) {
      const t = now - t0; cx.clearRect(0, 0, confetti.width, confetti.height);
      parts.forEach(p => { p.vy += .35; p.x += p.vx; p.y += p.vy; p.r += p.vr; cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s / 1.6); cx.restore(); });
      if (t < 4500) requestAnimationFrame(f); else cx.clearRect(0, 0, confetti.width, confetti.height);
    })(t0);
  }

  /* ---------- Pantalla ---------- */
  function renderGrid() {
    const occ = new Set(seats), held = new Set(data.held || []);
    const canPick = data.status === 'abierta' && !demo.active;
    for (const n of [...picked]) if (occ.has(n) || held.has(n) || !canPick) picked.delete(n);
    const sig = [data.seatsTotal, seats.join(), [...held].join(), [...picked].join(), winnerSlice >= 0 ? data.winnerSeat : '', canPick].join('|');
    if (sig === gridSig) return;
    gridSig = sig;
    const g = $('#seatGrid'); const frag = document.createDocumentFragment();
    for (let n = 1; n <= data.seatsTotal; n++) {
      const free = !occ.has(n) && !held.has(n);
      const d = document.createElement(free && canPick ? 'button' : 'span');
      if (d.tagName === 'BUTTON') { d.type = 'button'; d.dataset.seat = n; d.setAttribute('aria-pressed', picked.has(n)); d.setAttribute('aria-label', `Puesto ${n}, libre`); }
      d.className = 'seat' + (occ.has(n) ? ' on' : held.has(n) ? ' held' : free && canPick ? ' free' : '') + (picked.has(n) ? ' pick' : '') + (data.winnerSeat === n && winnerSlice >= 0 ? ' win' : '');
      d.textContent = n; frag.appendChild(d);
    }
    g.replaceChildren(frag);
    updateReserve();
  }
  $('#seatGrid').addEventListener('click', e => {
    const b = e.target.closest('[data-seat]'); if (!b) return;
    const n = Number(b.dataset.seat);
    if (picked.has(n)) picked.delete(n); else if (picked.size < 20) picked.add(n); else { $('#reserveMsg').textContent = 'Puedes reservar hasta 20 puestos a la vez.'; return; }
    $('#reserveMsg').textContent = ''; gridSig = ''; renderGrid();
  });
  function updateReserve() {
    if (!data || !data.exists) return;
    const q = picked.size || Math.max(1, Math.min(20, Number($('#reserveForm').quantity.value) || 1));
    $('#reserveTotal').textContent = copFmt(q * data.priceCop);
    $('#pickedLine').textContent = picked.size ? `Elegiste: ${[...picked].sort((x, y) => x - y).join(', ')} (${picked.size} puesto${picked.size > 1 ? 's' : ''}).` : 'Aún no elegiste puestos: se te asignarán al azar.';
    $('#qtyLabel').classList.toggle('hidden', picked.size > 0);
  }
  function render() {
    if (demo.active) return;
    const d = data;
    $('#liveEmpty').classList.toggle('hidden', d.exists);
    $('#liveApp').classList.toggle('hidden', !d.exists);
    if (!d.exists) return;
    seats = [...d.occupied].sort((a, b) => a - b);
    $('#liveName').textContent = d.name;
    const st = $('#liveStatus'); st.textContent = STATUS[d.status] || ''; st.className = 'live-chip ' + d.status;
    $('#liveSub').textContent = d.status === 'cancelada' ? 'El organizador canceló este evento. Los aportes se devuelven.' : `Cada puesto es un número en la ruleta. Puesto: ${copFmt(d.priceCop)}.${d.status === 'cerrada' ? ' Las inscripciones ya cerraron.' : ''}`;
    $('#prizeLiveName').textContent = d.prize.name; $('#prizeLiveDesc').textContent = d.prize.description;
    const img = $('#prizeLiveImg');
    if (d.prize.imageVersion) { if (imgVersion !== d.prize.imageVersion) { img.src = `/api/roulette-image?v=${d.prize.imageVersion}`; imgVersion = d.prize.imageVersion; } img.classList.remove('hidden'); }
    else { img.classList.add('hidden'); imgVersion = null; }
    $('#seatCount').textContent = seats.length; $('#seatOf').textContent = ` de ${d.seatsTotal} puestos ocupados`;
    $('#seatFill').style.width = Math.round(seats.length / d.seatsTotal * 100) + '%';
    const heldN = (d.held || []).length;
    $('#seatPrice').textContent = `Quedan ${d.seatsTotal - seats.length - heldN} puestos libres${heldN ? ` y ${heldN} apartados con pago por verificar` : ''}.`;
    $('#reserve').classList.toggle('hidden', d.status !== 'abierta' || demo.active);
    if (d.status === 'abierta') updateReserve();

    if (d.status === 'sorteada' && d.spinStartsAtIso) {
      const startAt = Date.parse(d.spinStartsAtIso), now = Date.now() + offset;
      if (animatingVersion === d.spinVersion) return;                       // ya está girando
      if (seenVersion === d.spinVersion) return;                            // ya lo mostré
      seenVersion = d.spinVersion;
      if (now > startAt + d.spinMs + 500 || reduceMotion) { showFinalNow(); if (!reduceMotion && now < startAt + d.spinMs + 6000) showWinner(); return; }
      animatingVersion = d.spinVersion; winnerSlice = -1; renderGrid(); runSpin(); return;
    }
    if (animatingVersion) return;
    seenVersion = null; winnerSlice = -1; theta = 0; cancelAnimationFrame(raf);
    setHub(d.status === 'cancelada' ? 'Evento' : 'Puestos', d.status === 'cancelada' ? '✕' : seats.length, d.status === 'cancelada' ? 'off' : '');
    $('#liveWinner').classList.add('hidden');
    draw(); renderGrid();
  }

  async function fetchOnce() {
    if (demo.active) return;
    try {
      const res = await fetch('/api/roulette', { cache: 'no-store' });
      if (res.ok && !demo.active) { data = await res.json(); offset = Date.parse(data.serverNowIso) - Date.now(); render(); }
    } catch { /* se reintenta */ }
  }
  async function poll() { await fetchOnce(); setTimeout(poll, document.hidden ? 8000 : 3000); }

  /* ---------- Ensayo (?demo=1): giro local, sin tocar el servidor ---------- */
  if (demoMode) {
    $('#demoBar').classList.remove('hidden');
    $('#demoSpin').addEventListener('click', () => {
      if (!data || !data.exists) return;
      const pool = seats.length >= 2 ? [...seats] : Array.from({ length: 12 }, (_, i) => i + 1);
      const winner = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
      cancelAnimationFrame(raf); demo.active = true; winnerSlice = -1; seats = pool;
      data = { ...data, status: 'sorteada', seatsTotal: Math.max(data.seatsTotal, pool.length), winnerSeat: winner,
        spinVersion: Date.now(), spinStartsAtIso: new Date(Date.now() + 1500).toISOString(), spinMs: 10000 };
      offset = 0; animatingVersion = data.spinVersion; $('#liveWinner').classList.add('hidden');
      renderGrid(); runSpin();
    });
    $('#demoReset').addEventListener('click', () => { demo.active = false; animatingVersion = null; seenVersion = null; winnerSlice = -1; $('#liveWinner').classList.add('hidden'); fetchOnce(); });
  }
  /* ---------- Cuenta regresiva de cierre ---------- */
  setInterval(() => {
    const el = $('#closeClock');
    if (!data || !data.exists || data.status !== 'abierta' || !data.closesAtIso || demo.active) { el.classList.add('hidden'); return; }
    const left = Math.floor((Date.parse(data.closesAtIso) - (Date.now() + offset)) / 1000);
    if (left <= 0) { el.classList.add('hidden'); if (!ticking) { ticking = true; fetchOnce().finally(() => { ticking = false; }); } return; }
    const p = n => String(n).padStart(2, '0');
    el.textContent = `Las inscripciones cierran en ${p(Math.floor(left / 3600))}:${p(Math.floor((left % 3600) / 60))}:${p(left % 60)}`;
    el.classList.remove('hidden');
  }, 1000);
  let ticking = false;

  /* ---------- Reserva de puestos ---------- */
  fetch('/api/status').then(r => r.json()).then(st => {
    paymentKey = st.brebValue || '';
    $('#brebLabelR').textContent = st.brebLabel || 'la llave'; $('#brebValueR').textContent = st.brebValue || '';
  }).catch(() => {});
  $('#copyKeyR').addEventListener('click', async e => {
    try { await navigator.clipboard.writeText(paymentKey); e.target.textContent = '¡Copiado!'; setTimeout(() => { e.target.textContent = 'Copiar'; }, 1800); } catch { /* sin portapapeles */ }
  });
  const MAX_BYTES = 780 * 1024;
  async function shrinkImage(file) {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.85, 0.7, 0.55]) { const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (blob && blob.size <= MAX_BYTES) return new File([blob], 'comprobante.jpg', { type: 'image/jpeg' }); }
      scale *= 0.75;
    }
    throw new Error('No se pudo reducir la imagen. Usa una captura más liviana.');
  }
  const rForm = $('#reserveForm'), rMsg = $('#reserveMsg');
  rForm.quantity.addEventListener('input', updateReserve);
  rForm.phone.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  rForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!rForm.reportValidity()) return;
    const btn = $('#reserveBtn'); btn.disabled = true; rMsg.className = 'notice'; rMsg.textContent = 'Enviando…';
    try {
      let f = rForm.receipt.files[0];
      if (!f) throw new Error('Adjunta el comprobante.');
      if (f.type === 'application/pdf') { if (f.size > MAX_BYTES) throw new Error('El PDF supera 780 KB. Envía una captura (JPG o PNG).'); }
      else if (f.size > MAX_BYTES) f = await shrinkImage(f);
      const fd = new FormData();
      for (const k of ['fullName', 'socialUser', 'phone']) fd.append(k, rForm[k].value);
      fd.append('quantity', rForm.quantity.value); fd.append('seats', [...picked].join(','));
      fd.append('acceptedTerms', rForm.acceptedTerms.checked ? 'on' : ''); fd.append('receipt', f, f.name);
      const res = await fetch('/api/roulette/reserve', { method: 'POST', body: fd });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'No se pudo reservar.');
      picked.clear(); gridSig = ''; rForm.reset(); rForm.classList.add('hidden');
      $('#reserveDoneText').textContent = `Tus puestos: ${out.seats.join(', ')}. Total a pagar: ${copFmt(out.amountCop)}.`;
      $('#reserveDone').classList.remove('hidden'); rMsg.textContent = '';
      fetchOnce();
    } catch (err) { rMsg.className = 'notice error'; rMsg.textContent = err.message; fetchOnce(); }
    btn.disabled = false;
  });
  $('#reserveAgain').addEventListener('click', () => { $('#reserveDone').classList.add('hidden'); rForm.classList.remove('hidden'); updateReserve(); });

  const fmtDay = iso => { const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))); };
  async function loadHistory() {
    try {
      const res = await fetch('/api/roulette/winners'); if (!res.ok) return;
      const { winners } = await res.json();
      const box = $('#liveHistory'); box.classList.toggle('hidden', !winners.length);
      const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      $('#liveHistoryList').innerHTML = winners.map(w => `<li><span class="hist-seat">#${esc(w.seat)}</span>
        <span class="hist-info"><b>${esc(w.prizeName)}</b><small>${esc(fmtDay(w.date))}${w.time ? ' · ' + esc(w.time) : ''} · ${esc(w.eventName)}</small></span>
        ${w.delivered ? '<span class="hist-ok">Premio entregado</span>' : ''}</li>`).join('');
    } catch { /* se reintenta */ }
  }
  loadHistory(); setInterval(loadHistory, 60000);
  window.addEventListener('resize', () => { if (data && data.exists && !animatingVersion) draw(); });
  poll();
})();
