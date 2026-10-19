/* Portada: creadores, meta de donaciones, clips y formulario de donación. */
(() => {
  const $ = s => document.querySelector(s);
  const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let data = null, seen = null, clipFilter = '', paymentKey = '', shownRaised = 0, countRaf = 0;
  const queue = [];

  /* ---------- Confeti ---------- */
  const cv = $('#confetti'), cx = cv.getContext('2d');
  let parts = [], raf = 0;
  function fit() { cv.width = innerWidth; cv.height = innerHeight; }
  addEventListener('resize', fit); fit();
  function burst(n = 120, x = innerWidth / 2, y = innerHeight * 0.35) {
    if (reduceMotion) return;
    const cols = ['#ffc82e', '#ff5a5f', '#16b47c', '#4b2fd0', '#ffffff', '#ff8fd0'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 9;
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 5, g: 0.28 + Math.random() * 0.12, s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[i % cols.length], life: 110 + Math.random() * 60 });
    }
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    cx.clearRect(0, 0, cv.width, cv.height);
    parts = parts.filter(p => p.life > 0 && p.y < cv.height + 30);
    for (const p of parts) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.r += p.vr; p.life--;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.globalAlpha = Math.min(1, p.life / 40);
      cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.6); cx.restore();
    }
    raf = parts.length ? requestAnimationFrame(tick) : 0;
    if (!raf) cx.clearRect(0, 0, cv.width, cv.height);
  }

  /* ---------- Avisos de agradecimiento (cada donación verificada) ---------- */
  const gt = $('#giftToast');
  let toastBusy = false;
  function nextGift() {
    if (toastBusy || !queue.length) return;
    toastBusy = true;
    const d = queue.shift();
    $('#giftTitle').textContent = d.milestone ? d.name : `¡Gracias, ${d.name}!`;
    $('#giftSub').textContent = d.milestone ? 'Gracias a todos los que donaron 💜' : `Donó ${cop(d.amountCop)} a la meta`;
    gt.classList.add('show');
    burst(90);
    setTimeout(() => { gt.classList.remove('show'); setTimeout(() => { toastBusy = false; nextGift(); }, 400); }, 4200);
  }

  /* ---------- Render ---------- */
  function imgUrl(key, v) { return `/api/community-image/${encodeURIComponent(key)}?v=${v}`; }
  function renderCreators(list) {
    const sec = $('#creadores'); sec.classList.toggle('hidden', !list.length); $('#navCreators').classList.toggle('hidden', !list.length);
    $('#creatorList').innerHTML = list.map(c => `
      <article class="creator">
        <div class="creator-pic">${c.imageVersion ? `<img src="${imgUrl(c.id, c.imageVersion)}" alt="Foto de ${esc(c.name)}" width="160" height="160" loading="lazy">` : `<span aria-hidden="true">${esc(c.name.trim().charAt(0).toUpperCase())}</span>`}</div>
        <h3>${esc(c.name)}</h3>
        ${c.role ? `<p class="creator-role">${esc(c.role)}</p>` : ''}
        ${c.bio ? `<p class="creator-bio">${esc(c.bio)}</p>` : ''}
        <div class="creator-links">${c.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`).join('')}</div>
      </article>`).join('');
  }
  function countTo(target) {
    cancelAnimationFrame(countRaf);
    const from = shownRaised, t0 = performance.now(), dur = reduceMotion ? 0 : 900;
    const step = now => {
      const k = dur ? Math.min(1, (now - t0) / dur) : 1, e = 1 - Math.pow(1 - k, 3);
      shownRaised = Math.round(from + (target - from) * e);
      $('#goalRaised').textContent = cop(shownRaised);
      if (k < 1) countRaf = requestAnimationFrame(step);
    };
    countRaf = requestAnimationFrame(step);
  }
  function renderGoal(g) {
    const sec = $('#donar'); sec.classList.toggle('hidden', !g); $('#navDonate').classList.toggle('hidden', !g); $('#heroDonate').classList.toggle('hidden', !g);
    if (!g) return;
    $('#goalTitle').textContent = g.title;
    $('#goalDesc').textContent = g.description; $('#goalDesc').classList.toggle('hidden', !g.description);
    $('#goalTarget').textContent = cop(g.targetCop);
    const pct = Math.min(100, Math.floor(g.raisedCop / g.targetCop * 100));
    $('#goalFill').style.width = pct + '%';
    $('#goalPct').textContent = pct + '%';
    $('#goalBar').setAttribute('aria-valuenow', pct);
    $('#goalBar').classList.toggle('full', g.reached);
    $('#goalDone').classList.toggle('hidden', !g.reached);
    $('#goalCount').textContent = g.donationsCount ? ` · ${g.donationsCount} ${g.donationsCount === 1 ? 'donación' : 'donaciones'}` : '';
    $('#goalPicBox').classList.toggle('hidden', !g.imageVersion);
    if (g.imageVersion) { const im = $('#goalPic'); const u = imgUrl('goal', g.imageVersion); if (!im.src.endsWith(u)) im.src = u; }
    countTo(g.raisedCop);
  }
  function renderWall(list) {
    $('#wall').classList.toggle('hidden', !list.length);
    $('#wallList').innerHTML = list.map(d => `<li><span class="wall-heart" aria-hidden="true">💜</span><b>${esc(d.name)}</b><span>${cop(d.amountCop)}</span></li>`).join('');
  }
  const MEDAL = ['🥇', '🥈', '🥉', '4.', '5.'];
  function renderTop(list) {
    $('#topBox').classList.toggle('hidden', !list.length);
    $('#topList').innerHTML = list.map((d, i) => `<li><span class="medal" aria-hidden="true">${MEDAL[i]}</span><b>${esc(d.name)}</b><span>${cop(d.amountCop)}</span></li>`).join('');
  }
  const monthFmt = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'America/Bogota' });
  function renderPast(list) {
    $('#logradas').classList.toggle('hidden', !list.length);
    $('#pastGrid').innerHTML = list.map(p => `<article class="past">
      ${p.imageVersion ? `<img src="${imgUrl(p.id, p.imageVersion)}" alt="${esc(p.title)}" loading="lazy" width="480" height="300">` : '<div class="past-ph" aria-hidden="true">🎉</div>'}
      <div><b>${esc(p.title)}</b><span>${cop(p.raisedCop)} · ${p.donationsCount} ${p.donationsCount === 1 ? 'donación' : 'donaciones'}</span><em>✔ Lograda en ${esc(monthFmt.format(new Date(p.reachedAtIso)))}</em></div></article>`).join('');
  }
  function renderClips(list, creators) {
    $('#clips').classList.toggle('hidden', !list.length); $('#navClips').classList.toggle('hidden', !list.length);
    const used = creators.filter(c => list.some(k => k.creatorId === c.id));
    const f = $('#clipFilter');
    f.classList.toggle('hidden', used.length < 2);
    if (clipFilter && !used.some(c => c.id === clipFilter)) clipFilter = '';
    f.innerHTML = used.length < 2 ? '' : `<button type="button" data-cr="" class="${clipFilter ? '' : 'on'}">Todos</button>` +
      used.map(c => `<button type="button" data-cr="${esc(c.id)}" class="${clipFilter === c.id ? 'on' : ''}">${esc(c.name)}</button>`).join('');
    const name = id => (creators.find(c => c.id === id) || {}).name || '';
    $('#clipGrid').innerHTML = list.filter(k => !clipFilter || k.creatorId === clipFilter).map(k => `
      <article class="clip ${k.vertical ? 'v' : ''}" data-id="${esc(k.id)}">
        <button type="button" class="clip-play" data-embed="${esc(k.embed)}" data-title="${esc(k.title)}" aria-label="Reproducir: ${esc(k.title)}" ${k.thumb ? `style="background-image:url('${esc(k.thumb)}')"` : ''}>
          <span class="clip-badge">${esc(k.platform)}</span><span class="clip-btn" aria-hidden="true">▶</span>
        </button>
        <h3>${esc(k.title)}</h3>${name(k.creatorId) ? `<p class="small">${esc(name(k.creatorId))}</p>` : ''}
        ${k.url ? `<button type="button" class="clip-share" data-share="${esc(k.url)}" data-title="${esc(k.title)}">Compartir</button>` : ''}
      </article>`).join('');
  }
  // Solo se vuelve a dibujar lo que cambió, para no reiniciar un clip que se está viendo.
  const sigs = {};
  function once(key, value, fn) { const s = JSON.stringify(value); if (sigs[key] !== s) { sigs[key] = s; fn(); } }
  function renderLive(l) {
    const b = $('#liveBanner'); b.classList.toggle('hidden', !l);
    if (l) { b.href = l.url; $('#liveTitle').textContent = l.title ? ` · ${l.title}` : ''; }
  }
  const dayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
  let srvOff = 0;
  function eta(iso) {
    const ms = Date.parse(iso) - (Date.now() + srvOff);
    if (ms <= 0) return 'Empezando ahora';
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `En ${d} ${d === 1 ? 'día' : 'días'}${h ? ` y ${h} h` : ''}` : h ? `En ${h} h ${m % 60} min` : `En ${m} min`;
  }
  function renderAgenda(list) {
    $('#agenda').classList.toggle('hidden', !list.length);
    $('#agendaList').innerHTML = list.map(a => `<li><div><b>${esc(a.title)}</b><span>${esc(dayFmt.format(new Date(a.whenIso)))}${a.note ? ` · ${esc(a.note)}` : ''}</span></div><em data-eta="${esc(a.whenIso)}">${esc(eta(a.whenIso))}</em></li>`).join('');
  }
  setInterval(() => document.querySelectorAll('[data-eta]').forEach(e => { e.textContent = eta(e.dataset.eta); }), 30000);
  function render() {
    renderLive(data.live);
    once('ag', data.agenda || [], () => renderAgenda(data.agenda || []));
    once('cr', data.creators, () => renderCreators(data.creators));
    renderGoal(data.goal);
    once('wall', data.recent || [], () => renderWall(data.recent || []));
    once('top', data.top || [], () => renderTop(data.top || []));
    once('past', data.pastGoals || [], () => renderPast(data.pastGoals || []));
    once('clips', [data.clips, data.creators.map(c => [c.id, c.name])], () => renderClips(data.clips, data.creators));
  }

  async function load() {
    try {
      const res = await fetch('/api/community'); if (!res.ok) return;
      const next = await res.json();
      const ids = (next.recent || []).map(d => d.id);
      if (seen === null) seen = new Set(ids);
      else {
        const fresh = (next.recent || []).filter(d => !seen.has(d.id)).reverse();
        ids.forEach(i => seen.add(i));
        fresh.forEach(d => queue.push(d));
      }
      const prevData = data; data = next;
      if (next.serverNowIso) srvOff = Date.parse(next.serverNowIso) - Date.now();
      // Si el visitante está escribiendo un clip o el formulario, solo se refrescan las partes que no pisan nada.
      render();
      if (queue.length) nextGift();
      if (prevData && !prevData.goal?.reached && next.goal?.reached) burst(260);
      else if (prevData && prevData.goal && next.goal && prevData.goal.id === next.goal.id) {
        const pct = g => Math.floor(g.raisedCop / g.targetCop * 100);
        const hit = [75, 50, 25].find(m => pct(prevData.goal) < m && pct(next.goal) >= m);
        if (hit && !next.goal.reached) { burst(160); flashMilestone(hit); }
      }
    } catch { /* se reintenta */ }
  }

  function flashMilestone(p) {
    queue.push({ name: `¡Llegamos al ${p}%!`, amountCop: 0, milestone: true }); nextGift();
  }
  /* ---------- Compartir ---------- */
  async function share(title, text, url) {
    try { if (navigator.share) return await navigator.share({ title, text, url }); } catch (e) { if (e && e.name === 'AbortError') return; }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank', 'noopener');
  }
  $('#shareGoal').addEventListener('click', () => {
    const g = data && data.goal; if (!g) return;
    share('Juntos Sumamos', `Ayúdanos a lograr la meta: ${g.title}. Vamos en ${Math.floor(g.raisedCop / g.targetCop * 100)}%.`, `${location.origin}/#donar`);
  });
  /* ---------- Clips: el reproductor solo se carga al tocarlo ---------- */
  $('#clipGrid').addEventListener('click', e => {
    const sh = e.target.closest('.clip-share');
    if (sh) return share(sh.dataset.title, `Mira este clip: ${sh.dataset.title}`, sh.dataset.share);
    const b = e.target.closest('.clip-play'); if (!b) return;
    const f = document.createElement('iframe');
    f.src = b.dataset.embed; f.title = b.dataset.title; f.loading = 'lazy'; f.allowFullscreen = true;
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    b.replaceWith(f);
  });
  $('#clipFilter').addEventListener('click', e => {
    const b = e.target.closest('[data-cr]'); if (!b) return;
    clipFilter = b.dataset.cr; sigs.clips = null; renderClips(data.clips, data.creators);
  });

  /* ---------- Donación ---------- */
  const box = $('#donateBox'), form = $('#donateForm'), msg = $('#donateMsg'), MAX_BYTES = 780 * 1024;
  let receiptFile = null;
  $('#donateOpen').addEventListener('click', () => {
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) { box.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); loadPayment(); }
  });
  async function loadPayment() {
    if (paymentKey) return;
    try {
      const s = await (await fetch('/api/status')).json();
      paymentKey = s.brebValue; $('#brebLabel').textContent = s.brebLabel; $('#brebValue').textContent = s.brebValue;
    } catch { $('#brebValue').textContent = 'No se pudo cargar. Recarga la página.'; }
  }
  $('#copyKey').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(paymentKey); $('#copyKey').textContent = '¡Copiada!'; setTimeout(() => { $('#copyKey').textContent = 'Copiar llave'; }, 1800); }
    catch { alert(`Copia manualmente la llave: ${paymentKey}`); }
  });
  const amtInput = form.amountCop;
  function syncChips() { document.querySelectorAll('#amountChips button').forEach(b => b.classList.toggle('on', b.dataset.amt === amtInput.value)); }
  $('#amountChips').addEventListener('click', e => { const b = e.target.closest('[data-amt]'); if (b) { amtInput.value = b.dataset.amt; syncChips(); } });
  amtInput.addEventListener('input', () => { amtInput.value = amtInput.value.replace(/\D/g, '').slice(0, 10); syncChips(); });

  async function shrink(file) {
    const bmp = await createImageBitmap(file);
    let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.85, 0.7, 0.55]) {
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= MAX_BYTES) return new File([blob], 'comprobante.jpg', { type: 'image/jpeg' });
      }
      scale *= 0.75;
    }
    throw new Error('No se pudo reducir la imagen. Usa una captura de pantalla más liviana.');
  }
  const say = (t, k) => { msg.textContent = t; msg.className = `notice ${k || ''}`; };
  form.receipt.addEventListener('change', async e => {
    const f = e.target.files[0]; receiptFile = null; if (!f) return;
    try {
      if (f.type === 'application/pdf') { if (f.size > MAX_BYTES) throw new Error('El PDF supera 780 KB. Envía una captura (JPG o PNG) del comprobante.'); receiptFile = f; }
      else if (f.type === 'image/jpeg' || f.type === 'image/png') receiptFile = f.size > MAX_BYTES ? await shrink(f) : f;
      else throw new Error('Usa un JPG, PNG o PDF.');
      say('');
    } catch (err) { e.target.value = ''; say(err.message, 'error'); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const amt = Number(amtInput.value);
    if (!(amt >= 1)) return say('Escribe cuánto quieres donar.', 'error');
    if (!receiptFile) return say('Adjunta el comprobante de pago.', 'error');
    if (!form.acceptedTerms.checked) return say('Debes confirmar que tu donación es voluntaria.', 'error');
    const fd = new FormData();
    fd.append('amountCop', amt); fd.append('alias', form.alias.value); fd.append('phone', form.phone.value); fd.append('reference', form.reference.value); fd.append('acceptedTerms', 'on'); fd.append('receipt', receiptFile, receiptFile.name);
    $('#donateBtn').disabled = true; say('Enviando…');
    try {
      const res = await fetch('/api/donate', { method: 'POST', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'No se pudo enviar. Inténtalo de nuevo.');
      form.reset(); receiptFile = null; syncChips(); say('');
      box.classList.add('hidden');
      $('#success').classList.remove('hidden'); document.body.style.overflow = 'hidden'; $('#closeSuccess').focus();
      burst(220);
    } catch (err) { say(err.message, 'error'); }
    finally { $('#donateBtn').disabled = false; }
  });
  function closeSuccess() { $('#success').classList.add('hidden'); document.body.style.overflow = ''; }
  $('#closeSuccess').addEventListener('click', closeSuccess);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSuccess(); });

  /* ---------- Instalar como app ---------- */
  let installEvt = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
  $('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('#installBtn').classList.add('hidden'); });
  addEventListener('appinstalled', () => $('#installBtn').classList.add('hidden'));

  load();
  setInterval(() => { if (!document.hidden) load(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
