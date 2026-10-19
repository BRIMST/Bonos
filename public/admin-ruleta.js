/* Pestaña "Ruleta" del panel. Usa $, api, esc, flash, toast, copFmt, shrinkPrize y MAX_PRIZE_BYTES de admin.js */
(() => {
  const form = $('#rlForm'), seatForm = $('#rlSeatForm');
  const JSON_H = { 'Content-Type': 'application/json' };
  let view = null, dirty = false, pendingFile = null, pendingUrl = '';
  const isOpen = () => Boolean(view && view.exists && ['abierta', 'cerrada'].includes(view.roulette.status));
  const wa = (phone, text) => phone ? `<a class="wa-btn small-btn" target="_blank" rel="noopener" href="https://wa.me/57${esc(phone)}?text=${encodeURIComponent(text)}">WhatsApp</a>` : '';
  const localDT = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 16); // hora de Colombia (UTC-5)
  const STATUS = { abierta: ['Inscripciones abiertas', 'ok'], cerrada: ['Inscripciones cerradas', 'warn'], sorteada: ['Sorteada', 'ok'], cancelada: ['Cancelada', 'bad'] };

  let load = async function () {
    try { view = await api('/api/admin/roulette'); render(); }
    catch (err) { flash($('#rlMessage'), err.message, 'error'); }
  };
  let srvOffset = 0, revealTimer = 0;
  const nowMs = () => Date.now() + srvOffset;
  // Mientras gira la ruleta, el panel no muestra al ganador (para no adelantarlo si compartes pantalla).
  const revealAtMs = () => (view && view.exists && view.roulette.status === 'sorteada' && view.roulette.spinStartsAtIso)
    ? Date.parse(view.roulette.spinStartsAtIso) + view.roulette.spinMs + 600 : 0;
  const revealing = () => nowMs() < revealAtMs();
  function money(n) { return (n < 0 ? '−' : n > 0 ? '+' : '') + copFmt(Math.abs(n)); }

  function render() {
    const has = view && view.exists, r = has && view.roulette;
    if (has) srvOffset = Date.parse(r.serverNowIso) - Date.now();
    const hide = has && revealing();
    clearTimeout(revealTimer);
    if (hide) revealTimer = setTimeout(() => { render(); loadHistory(); }, revealAtMs() - nowMs() + 200);
    const open = has && ['abierta', 'cerrada'].includes(r.status);
    $('#rlSummary').classList.toggle('hidden', !has);
    if (has) $('#rlActa').href = `/api/admin/roulette/acta.csv?id=${encodeURIComponent(r.id)}`;
    $('#rlFormTitle').textContent = open ? 'Editar ruleta' : 'Crear ruleta';
    $('#rlSave').textContent = open ? 'Guardar cambios' : 'Crear nueva ruleta';
    seatForm.classList.toggle('hidden', !(has && r.status === 'abierta'));
    $('#rlBuyers').classList.toggle('hidden', !has || !view.buyers.length);
    if (!has || !open) showImg(pendingFile ? 'pending' : null);
    if (!has) return;

    if (!form.dataset.filled || (open && !dirty)) {
      form.name.value = r.name; form.seats.value = r.seatsTotal; form.priceCop.value = r.priceCop;
      form.prizeName.value = r.prize.name; form.prizeDescription.value = r.prize.description;
      form.prizeValueCop.value = r.prizeValueCop; form.requireMin.checked = r.requireMin;
      form.closesAt.value = r.closesAtIso ? localDT(r.closesAtIso) : '';
      form.dataset.filled = '1'; suggest();
    }
    if (open) showImg(r.prize.imageVersion);

    const [label, kind] = hide ? ['Girando…', 'warn'] : (STATUS[r.status] || ['', '']);
    const chip = $('#rlChip'); chip.textContent = label; chip.className = `chip ${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'warn'}`;
    $('#rlName').textContent = r.name;

    const b = view.bar, max = Math.max(b.collectedCop, b.targetCop, 1) * 1.25;
    const fill = $('#rlFill');
    fill.style.width = Math.min(100, b.collectedCop / max * 100) + '%';
    fill.className = `rl-${b.state}`;
    $('#rlMark').style.left = Math.min(100, b.targetCop / max * 100) + '%';
    $('#rlBarText').className = `rl-bar-text rl-t-${b.state}`;
    $('#rlBarText').textContent = b.state === 'rojo' ? `Pérdida: faltan ${copFmt(-b.diffCop)} para cubrir el premio`
      : b.state === 'naranja' ? `Equilibrio: lo recaudado cubre justo el premio (${money(b.diffCop)})`
        : `Ganancia: ${copFmt(b.diffCop)} por encima del premio`;
    $('#rlCollected').textContent = copFmt(b.collectedCop); $('#rlTarget').textContent = copFmt(b.targetCop);
    const held = (r.held || []).length;
    $('#rlSeats').textContent = `${r.occupied.length}/${r.seatsTotal}${held ? ` (+${held} apartados)` : ''}`;
    const nPend = (view.reservations || []).length;
    const bd = $('#rlBadge'); bd.textContent = nPend; bd.classList.toggle('hidden', !nPend);
    $('#rlReservations').classList.toggle('hidden', !nPend);
    $('#rlResRows').innerHTML = (view.reservations || []).map(x => `<tr>
      <td data-label="Participante"><b>${esc(x.fullName)}</b><br><span class="small">${esc(x.socialUser || '')} ${esc(x.phone || '')}</span>${x.duplicateReceipt ? '<br><span class="pill dup" title="Este comprobante ya se había enviado antes">Comprobante repetido</span>' : ''}</td>
      <td data-label="Puestos">${x.seats.map(n => `<span class="seat-chip">${n}</span>`).join('')}</td>
      <td data-label="Aporte">${copFmt(x.amountCop)}</td>
      <td data-label="Acciones" class="actions"><button type="button" class="secondary small-btn" data-rview="${esc(x.id)}">Ver comprobante</button>${resButtons(x)}</td></tr>`).join('');

    const acts = [];
    if (r.status === 'abierta') acts.push(['close', 'Cerrar inscripciones', 'primary']);
    if (r.status === 'cerrada') { acts.push(['spin', '¡Girar la ruleta!', 'primary big']); acts.push(['reopen', 'Reabrir inscripciones', 'secondary']); }
    if (open) acts.push(['cancel', 'Cancelar evento', 'bad-btn']);
    $('#rlActions').innerHTML = acts.map(([k, t, c]) => `<button type="button" class="${c}" data-act="${k}">${t}</button>`).join('');

    const w = $('#rlWinner');
    if (hide) {
      w.classList.remove('hidden');
      w.innerHTML = '<span>La ruleta está girando en la pantalla del live…</span><p>El ganador se mostrará aquí cuando termine la animación.</p>';
    } else if (view.winner) {
      w.classList.remove('hidden');
      w.innerHTML = `<span>Puesto ganador</span><b>#${esc(view.winner.seat)}</b><p><b>${esc(view.winner.fullName)}</b>${view.winner.socialUser ? ' · ' + esc(view.winner.socialUser) : ''}${view.winner.phone ? '<br>Celular ' + esc(view.winner.phone) + ' · ' + wa(view.winner.phone, `¡Felicidades ${String(view.winner.fullName).split(' ')[0]}! Tu puesto #${view.winner.seat} ganó ${r.prize.name} en "${r.name}". Escríbenos para coordinar la entrega.`) : ''}</p>`;
    } else if (r.status === 'cancelada') {
      w.classList.remove('hidden');
      w.innerHTML = `<span>Evento cancelado${r.cancelReason ? ': ' + esc(r.cancelReason) : ''}</span><p>Por devolver <b>${copFmt(view.refunds.pendingCop)}</b> · Ya devuelto <b>${copFmt(view.refunds.doneCop)}</b></p>`;
    } else w.classList.add('hidden');

    $('#rlRows').innerHTML = view.buyers.map(by => {
      let act = '';
      if (r.status === 'cancelada') act = by.refundStatus === 'devuelto'
        ? `<span class="pill ok">Devuelto</span> <button type="button" class="secondary small-btn" data-refund="${esc(by.buyerId)}" data-done="0">Deshacer</button>`
        : `<span class="pill warn">Por devolver</span> <button type="button" class="ok-btn small-btn" data-refund="${esc(by.buyerId)}" data-done="1">Marcar devuelto</button>`;
      else if (r.status === 'sorteada') act = (!hide && by.seats.includes(r.winnerSeat)) ? '<span class="pill ok">Ganador</span>' : '';
      const seats = by.seats.map(n => `<span class="seat-chip">${n}${open ? `<button type="button" aria-label="Quitar puesto ${n}" data-del="${n}">×</button>` : ''}</span>`).join('');
      const first = String(by.fullName || '').split(' ')[0];
      const msgTxt = r.status === 'cancelada' ? `Hola ${first}, el evento "${r.name}" fue cancelado. Te devolveremos tu aporte de ${copFmt(by.amountCop)}.`
        : (!hide && by.seats.includes(r.winnerSeat)) ? `¡Felicidades ${first}! Tu puesto #${r.winnerSeat} ganó ${r.prize.name} en "${r.name}". Escríbenos para coordinar la entrega.`
        : `Hola ${first}, tu pago fue verificado ✅. Tus puestos en "${r.name}": ${by.seats.join(', ')}. ¡Gracias por apoyar a la comunidad!`;
      act += ' ' + wa(by.phone, msgTxt);
      return `<tr><td data-label="Participante"><b>${esc(by.fullName)}</b><br><span class="small">${esc(by.socialUser || '')} ${esc(by.phone || '')}</span></td>
        <td data-label="Puestos">${seats}</td><td data-label="Aporte">${copFmt(by.amountCop)}</td><td data-label="Acciones" class="actions">${act}</td></tr>`;
    }).join('');
  }

  const resButtons = x => `<button type="button" class="ok-btn small-btn" data-rapprove="${esc(x.id)}">Aprobar</button><button type="button" class="bad-btn small-btn" data-rreject="${esc(x.id)}">Rechazar</button>`;
  async function openResReceipt(id, trigger) {
    const x = (view.reservations || []).find(q => q.id === id); if (!x) return;
    lastFocus = trigger || document.activeElement;
    $('#modalTitle').textContent = x.fullName;
    $('#modalSub').textContent = `Puestos ${x.seats.join(', ')} · ${copFmt(x.amountCop)} · ${x.socialUser || ''} ${x.phone || ''}${x.reference ? ` · Ref. ${x.reference}` : ''}`;
    $('#modalBody').innerHTML = '<p class="small">Cargando comprobante…</p>';
    $('#modalActions').innerHTML = resButtons(x);
    modal.classList.remove('hidden'); document.body.style.overflow = 'hidden'; $('#modalClose').focus();
    const dup = x.duplicateReceipt ? '<p class="dup-warn">Atención: este mismo comprobante ya se había enviado antes.</p>' : '';
    try {
      const res = await fetch(`/api/admin/receipt/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => null); throw new Error((j && j.error) || 'No se pudo cargar el comprobante.'); }
      if ((res.headers.get('content-type') || '').startsWith('image/')) {
        const blob = await res.blob();
        const url = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
        $('#modalBody').innerHTML = `${dup}<img src="${url}" alt="Comprobante de ${esc(x.fullName)}">`;
      } else $('#modalBody').innerHTML = `${dup}<p>El comprobante es un PDF.</p><a class="primary link-btn" target="_blank" rel="noopener" href="/api/admin/receipt/${encodeURIComponent(id)}">Abrir PDF en otra pestaña</a>`;
    } catch (err) { $('#modalBody').innerHTML = `${dup}<p class="notice error">${esc(err.message)}</p>`; }
  }
  async function reviewRes(id, action) {
    if (action === 'reject' && !confirm('¿Rechazar esta reserva? Sus puestos quedan libres otra vez.')) return;
    if (await call(`/api/admin/roulette/reservations/${encodeURIComponent(id)}/${action}`)) {
      closeModal(); toast(action === 'approve' ? 'Reserva aprobada: los puestos ya participan.' : 'Reserva rechazada: puestos liberados.', action === 'approve' ? 'ok' : 'bad');
    }
  }
  $('#rlResRows').addEventListener('click', e => {
    const v = e.target.closest('[data-rview]'), a = e.target.closest('[data-rapprove]'), r = e.target.closest('[data-rreject]');
    if (v) openResReceipt(v.dataset.rview, v); if (a) reviewRes(a.dataset.rapprove, 'approve'); if (r) reviewRes(r.dataset.rreject, 'reject');
  });
  $('#modalActions').addEventListener('click', e => {
    const a = e.target.closest('[data-rapprove]'), r = e.target.closest('[data-rreject]');
    if (a) reviewRes(a.dataset.rapprove, 'approve'); if (r) reviewRes(r.dataset.rreject, 'reject');
  });

  async function call(url, method = 'POST', body) {
    const msg = $('#rlMessage');
    try {
      view = await api(url, { method, headers: JSON_H, body: body ? JSON.stringify(body) : undefined });
      render(); flash(msg, '', ''); return true;
    } catch (err) { flash(msg, err.message, 'error'); toast(err.message, 'bad'); return false; }
  }

  $('#rlActions').addEventListener('click', async e => {
    const k = e.target.closest('[data-act]')?.dataset.act; if (!k) return;
    if (k === 'close') { if (confirm('¿Cerrar las inscripciones? Ya no se podrán agregar seguidores.' + ((view.reservations || []).length ? `\n\nTienes ${view.reservations.length} reserva(s) por revisar: apruébalas o recházalas antes de girar.` : ''))) await call('/api/admin/roulette/close'); }
    else if (k === 'reopen') await call('/api/admin/roulette/reopen');
    else if (k === 'spin') {
      const b = view.bar;
      if (!confirm(`¿Girar la ruleta ahora? El ganador se elige al azar entre ${view.roulette.occupied.length} puestos y se anuncia en la pantalla del live.` +
        (b.state === 'rojo' ? `\n\nOjo: lo recaudado está por debajo del valor del premio (pérdida de ${copFmt(-b.diffCop)}).` : ''))) return;
      if (await call('/api/admin/roulette/spin')) toast('La ruleta girará en unos segundos en la pantalla del live.', 'ok');
    } else if (k === 'cancel') {
      const reason = prompt('¿Cancelar el evento? Todos los aportes pasarán a "por devolver".\nMotivo (opcional):', '');
      if (reason === null) return;
      await call('/api/admin/roulette/cancel', 'POST', { reason });
    }
  });
  $('#rlRows').addEventListener('click', async e => {
    const d = e.target.closest('[data-del]'); const f = e.target.closest('[data-refund]');
    if (d) { if (confirm(`¿Quitar el puesto ${d.dataset.del}? Queda libre otra vez.`)) await call(`/api/admin/roulette/seats/${encodeURIComponent(d.dataset.del)}`, 'DELETE'); }
    if (f) await call(`/api/admin/roulette/buyers/${encodeURIComponent(f.dataset.refund)}/refund`, 'PATCH', { done: f.dataset.done === '1' });
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const open = view && view.exists && ['abierta', 'cerrada'].includes(view.roulette.status);
    const body = { name: form.name.value, seats: form.seats.value, priceCop: form.priceCop.value, prizeName: form.prizeName.value,
      prizeDescription: form.prizeDescription.value, prizeValueCop: form.prizeValueCop.value, requireMin: form.requireMin.checked, closesAt: form.closesAt.value };
    if (await call('/api/admin/roulette', open ? 'PUT' : 'POST', body)) {
      if (!open && pendingFile) {
        try { await uploadImage(pendingFile); } catch (err) { toast('La ruleta se creó, pero la imagen no se pudo subir: ' + err.message, 'bad'); }
        pendingFile = null; pendingUrl = ''; await load();
      }
      dirty = false; form.dataset.filled = ''; render(); toast(open ? 'Cambios guardados.' : 'Ruleta creada.', 'ok'); }
  });
  form.addEventListener('input', () => { dirty = true; });
  seatForm.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#rlMessage');
    try {
      const r = await api('/api/admin/roulette/seats', { method: 'POST', headers: JSON_H, body: JSON.stringify({
        fullName: seatForm.fullName.value, socialUser: seatForm.socialUser.value, phone: seatForm.phone.value, quantity: seatForm.quantity.value }) });
      view = r.view; seatForm.reset(); seatForm.quantity.value = 1; render();
      toast(`Puesto${r.seats.length > 1 ? 's' : ''} ${r.seats.join(', ')} asignado${r.seats.length > 1 ? 's' : ''}.`, 'ok');
    } catch (err) { flash(msg, err.message, 'error'); toast(err.message, 'bad'); }
  });
  seatForm.phone.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });

  function showImg(version) {
    $('#rlImg').classList.toggle('hidden', !version); $('#rlNoImg').classList.toggle('hidden', Boolean(version));
    if (version) $('#rlImg').src = version === 'pending' ? pendingUrl : `/api/roulette-image?v=${version}`;
  }
  async function prepareImage(f) {
    if (!['image/jpeg', 'image/png'].includes(f.type)) throw new Error('Usa una imagen JPG o PNG.');
    return f.size > MAX_PRIZE_BYTES ? await shrinkPrize(f) : f;
  }
  async function uploadImage(file) {
    const fd = new FormData(); fd.append('image', file, file.name);
    return (await api('/api/admin/roulette/image', { method: 'POST', body: fd })).version;
  }
  $('#rlImage').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; const msg = $('#rlImageMessage'); if (!f) return;
    try {
      flash(msg, 'Preparando imagen…');
      const file = await prepareImage(f);
      if (isOpen()) {                       // ruleta abierta: se sube de una vez
        showImg(await uploadImage(file)); flash(msg, 'Imagen actualizada. Ya se ve en la pantalla del live.', 'success');
      } else {                              // todavía no hay ruleta: queda lista para subirse al crearla
        pendingFile = file;
        pendingUrl = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(file); }); // data: (la política de seguridad no permite blob:)
        showImg('pending');
        flash(msg, 'Imagen lista. Se sube al crear la ruleta.', 'success');
      }
    } catch (err) { flash(msg, err.message, 'error'); }
  });
  $('#rlImageRemove').addEventListener('click', async () => {
    const msg = $('#rlImageMessage');
    try {
      if (isOpen()) { await api('/api/admin/roulette/image', { method: 'DELETE' }); }
      else { pendingFile = null; pendingUrl = ''; }
      showImg(null); flash(msg, 'Imagen eliminada.', 'success');
    } catch (err) { flash(msg, err.message, 'error'); }
  });

  /* Historial de ganadores (con nombres, solo para el admin) */
  async function loadHistory() {
    try {
      if (revealing()) return;
      const { winners } = await api('/api/admin/roulette/winners');
      $('#rlHistory').classList.toggle('hidden', !winners.length);
      $('#rlHistRows').innerHTML = winners.map(w => `<tr>
        <td data-label="Fecha">${esc(w.dateBogota)}<br><span class="small">${esc(w.eventName)}</span></td>
        <td data-label="Premio">${esc(w.prizeName)}</td>
        <td data-label="Puesto" class="number">#${esc(w.seat)}</td>
        <td data-label="Ganador"><b>${esc(w.fullName)}</b><br><span class="small">${esc(w.socialUser || '')} ${esc(w.phone || '')}</span></td>
        <td data-label="Entrega" class="actions">${w.delivered ? '<span class="pill ok">Entregado</span> <button type="button" class="secondary small-btn" data-deliv="' + esc(w.id) + '" data-done="0">Deshacer</button>'
          : '<span class="pill warn">Pendiente</span> <button type="button" class="ok-btn small-btn" data-deliv="' + esc(w.id) + '" data-done="1">Marcar entregado</button>'}</td></tr>`).join('');
    } catch { /* se muestra la próxima vez */ }
  }
  $('#rlHistRows').addEventListener('click', async e => {
    const b = e.target.closest('[data-deliv]'); if (!b) return;
    try { await api(`/api/admin/roulette/winners/${encodeURIComponent(b.dataset.deliv)}/delivered`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ done: b.dataset.done === '1' }) }); toast('Entrega actualizada.', 'ok'); }
    catch (err) { toast(err.message, 'bad'); }
    loadHistory();
  });
  // Precio sugerido = valor del premio ÷ cantidad de puestos (redondeado hacia arriba a $500, para que llenar la ruleta cubra el premio).
  function suggest() {
    const seats = Number(form.seats.value), prize = Number(form.prizeValueCop.value), box = $('#rlSuggest');
    if (!(seats >= 2 && prize > 0)) { box.classList.add('hidden'); return; }
    const price = Math.max(500, Math.ceil(prize / seats / 500) * 500);
    box.innerHTML = `Precio sugerido: <b>${copFmt(price)}</b> por puesto (premio ÷ puestos). <button type="button" class="secondary small-btn" id="rlUseSuggest">Usar este precio</button>`;
    box.classList.remove('hidden');
    $('#rlUseSuggest').onclick = () => { form.priceCop.value = price; dirty = true; };
  }
  form.seats.addEventListener('input', suggest); form.prizeValueCop.addEventListener('input', suggest);
  const baseLoad = load;
  load = async function () { await baseLoad(); if (!revealing()) await loadHistory(); };

  // El panel del evento de la Quinta no se muestra dentro de la pestaña de la Ruleta, para no confundir.
  const evPanel = $('#eventPanel');
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => evPanel.classList.toggle('hidden', t.dataset.tab === 'ruleta')));

  // Carga al abrir la pestaña y refresca solo mientras está visible.
  $('#tab-ruleta').addEventListener('click', load);
  setInterval(() => { if (!document.hidden && !$('#app').classList.contains('hidden') && modal.classList.contains('hidden')) load(); }, 25000);
  setTimeout(() => { if (!$('#app').classList.contains('hidden')) load(); }, 1500);
})();
