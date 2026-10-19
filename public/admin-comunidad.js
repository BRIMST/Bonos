/* Pestaña "Portada y donaciones". Usa $, api, esc, flash, toast, copFmt, modal y closeModal de admin.js */
(() => {
  const JSON_H = { 'Content-Type': 'application/json' };
  let view = null, creators = [], filter = 'pendiente', savedIds = new Set(), goalDirty = false, liveDirty = false, agendaDirty = false, agenda = [];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const when = iso => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' }).format(new Date(iso));
  const ST = { pendiente: ['Por revisar', 'warn'], verificada: ['Verificada', 'ok'], rechazada: ['Rechazada', 'bad'] };

  async function shrink(file, name) {
    const max = 780 * 1024, bmp = await createImageBitmap(file);
    let scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.88, 0.75, 0.6]) { const b = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (b && b.size <= max) return new File([b], name, { type: 'image/jpeg' }); }
      scale *= 0.8;
    }
    throw new Error('No se pudo reducir la imagen. Prueba con otra.');
  }
  async function prepImage(f, name) {
    if (!['image/jpeg', 'image/png'].includes(f.type)) throw new Error('Usa una imagen JPG o PNG.');
    return f.size > 780 * 1024 ? shrink(f, name) : f;
  }
  async function upload(key, file) {
    const fd = new FormData(); fd.append('image', file, file.name);
    return api(`/api/admin/community/image/${encodeURIComponent(key)}`, { method: 'POST', body: fd });
  }

  async function load() {
    try { view = await api('/api/admin/community'); render(); }
    catch (err) { flash($('#cmGoalMsg'), err.message, 'error'); }
  }

  /* ---------- Meta ---------- */
  const gf = $('#cmGoalForm');
  function renderGoal() {
    const g = view.goal;
    $('#cmGoalStat').classList.toggle('hidden', !g);
    $('#cmGoalNew').classList.toggle('hidden', !g); $('#cmGoalDel').classList.toggle('hidden', !g);
    $('#cmGoalImgBox').classList.toggle('hidden', !g);
    $('#cmGoalSave').textContent = g ? 'Guardar cambios' : 'Crear meta';
    if (g) {
      const pct = Math.min(100, Math.floor(g.raisedCop / g.targetCop * 100));
      $('#cmFill').style.width = pct + '%';
      $('#cmGoalText').textContent = `${copFmt(g.raisedCop)} de ${copFmt(g.targetCop)} (${pct}%) · ${g.donationsCount} donaciones verificadas${g.reached ? ' · ¡Meta lograda!' : ''}`;
      if (!goalDirty) { gf.title.value = g.title; gf.description.value = g.description; gf.targetCop.value = g.targetCop; }
      $('#cmGoalImg').classList.toggle('hidden', !g.imageVersion); $('#cmGoalNoImg').classList.toggle('hidden', Boolean(g.imageVersion));
      if (g.imageVersion) $('#cmGoalImg').src = `/api/community-image/goal?v=${g.imageVersion}`;
    }
  }
  gf.addEventListener('input', () => { goalDirty = true; });
  gf.targetCop.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  const goalBody = () => JSON.stringify({ title: gf.title.value, description: gf.description.value, targetCop: gf.targetCop.value });
  gf.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/admin/community/goal', { method: 'PUT', headers: JSON_H, body: goalBody() }); goalDirty = false; flash($('#cmGoalMsg'), 'Meta guardada. Ya se ve en la página principal.', 'success'); await load(); }
    catch (err) { flash($('#cmGoalMsg'), err.message, 'error'); }
  });
  $('#cmGoalNew').addEventListener('click', async () => {
    if (!confirm('¿Empezar una meta nueva? El contador vuelve a cero con los datos que escribiste arriba. Las donaciones anteriores se conservan.')) return;
    try { await api('/api/admin/community/goal/new', { method: 'POST', headers: JSON_H, body: goalBody() }); goalDirty = false; flash($('#cmGoalMsg'), 'Meta nueva creada.', 'success'); await load(); }
    catch (err) { flash($('#cmGoalMsg'), err.message, 'error'); }
  });
  $('#cmGoalDel').addEventListener('click', async () => {
    if (!confirm('¿Quitar la meta? La sección de donaciones desaparece de la página principal.')) return;
    try { await api('/api/admin/community/goal', { method: 'DELETE' }); gf.reset(); goalDirty = false; flash($('#cmGoalMsg'), 'Meta eliminada.', 'success'); await load(); }
    catch (err) { flash($('#cmGoalMsg'), err.message, 'error'); }
  });
  $('#cmGoalFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { flash($('#cmGoalImgMsg'), 'Subiendo…'); await upload('goal', await prepImage(f, 'meta.jpg')); flash($('#cmGoalImgMsg'), 'Imagen actualizada.', 'success'); await load(); }
    catch (err) { flash($('#cmGoalImgMsg'), err.message, 'error'); }
  });
  $('#cmGoalImgDel').addEventListener('click', async () => {
    try { await api('/api/admin/community/image/goal', { method: 'DELETE' }); flash($('#cmGoalImgMsg'), 'Imagen eliminada.', 'success'); await load(); }
    catch (err) { flash($('#cmGoalImgMsg'), err.message, 'error'); }
  });

  /* ---------- Donaciones ---------- */
  function renderDonations() {
    const all = view.donations, pend = all.filter(d => d.status === 'pendiente').length;
    const bd = $('#cmBadge'); bd.textContent = pend; bd.classList.toggle('hidden', !pend);
    $('#cmDonSummary').textContent = pend ? `· ${pend} por revisar` : '';
    document.querySelectorAll('#cmDonFilter button').forEach(b => b.classList.toggle('on', b.dataset.f === filter));
    const list = all.filter(d => d.status === filter);
    $('#cmDonEmpty').classList.toggle('hidden', list.length > 0);
    $('#cmDonRows').innerHTML = list.map(d => {
      const [label, kind] = ST[d.status];
      const rcpt = d.hasReceipt && !d.receiptPurged ? `<button type="button" class="secondary small-btn" data-rc="${esc(d.id)}">Ver comprobante</button>` : (d.manual ? '<span class="small">Manual</span>' : '<span class="small">Sin comprobante</span>');
      const acts = d.status === 'pendiente' ? `<button type="button" class="ok-btn small-btn" data-st="verificada" data-id="${esc(d.id)}">Verificar</button> <button type="button" class="bad-btn small-btn" data-st="rechazada" data-id="${esc(d.id)}">Rechazar</button>`
        : `<button type="button" class="secondary small-btn" data-st="${d.status === 'verificada' ? 'rechazada' : 'verificada'}" data-id="${esc(d.id)}">${d.status === 'verificada' ? 'Rechazar' : 'Verificar'}</button>`;
      const thanks = d.status === 'verificada' && d.phone ? `<a class="wa-btn small-btn" target="_blank" rel="noopener" href="https://wa.me/57${esc(d.phone)}?text=${encodeURIComponent(`¡Hola ${d.alias}! Gracias por tu donación de ${copFmt(d.amountCop)} a la meta de Juntos Sumamos. Ya quedó verificada 💜`)}">Agradecer</a>` : '';
      return `<tr><td data-label="Fecha">${esc(when(d.createdAtIso))}</td><td data-label="Nombre">${esc(d.alias)}${d.reference ? `<br><span class="small">Ref. ${esc(d.reference)}</span>` : ''}${d.duplicateReceipt ? '<br><span class="dup-warn">Comprobante o referencia repetidos</span>' : ''}</td><td data-label="Valor"><b>${copFmt(d.amountCop)}</b></td><td data-label="Estado"><span class="pill ${kind}">${label}</span></td><td data-label="Acciones" class="actions">${rcpt} ${acts} ${thanks}</td></tr>`;
    }).join('');
  }
  $('#cmDonFilter').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; renderDonations(); } });
  async function setStatus(id, status) {
    try { await api(`/api/admin/donations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: JSON_H, body: JSON.stringify({ status }) }); toast(status === 'verificada' ? 'Donación verificada. Ya suma a la barra.' : 'Donación rechazada.', 'ok'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'bad'); }
  }
  $('#cmDonRows').addEventListener('click', e => {
    const s = e.target.closest('[data-st]'); if (s) return setStatus(s.dataset.id, s.dataset.st);
    const r = e.target.closest('[data-rc]'); if (r) openReceipt2(r.dataset.rc, r);
  });
  async function openReceipt2(id, trigger) {
    const d = view.donations.find(x => x.id === id); if (!d) return;
    lastFocus = trigger;
    $('#modalTitle').textContent = `Donación de ${d.alias}`;
    $('#modalSub').textContent = `${copFmt(d.amountCop)} · ${ST[d.status][0]}${d.reference ? ` · Ref. ${d.reference}` : ''}`;
    $('#modalBody').innerHTML = '<p class="small">Cargando comprobante…</p>';
    $('#modalActions').innerHTML = d.status === 'pendiente' ? `<button type="button" class="ok-btn" data-don="verificada">Verificar</button><button type="button" class="bad-btn" data-don="rechazada">Rechazar</button>` : '';
    $('#modalActions').dataset.don = id;
    modal.classList.remove('hidden'); document.body.style.overflow = 'hidden'; $('#modalClose').focus();
    const dup = d.duplicateReceipt ? '<p class="dup-warn">Atención: este comprobante o esta referencia ya se habían enviado antes.</p>' : '';
    try {
      const res = await fetch(`/api/admin/receipt/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => null); throw new Error((j && j.error) || 'No se pudo cargar el comprobante.'); }
      if ((res.headers.get('content-type') || '').startsWith('image/')) {
        const blob = await res.blob();
        const src = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
        $('#modalBody').innerHTML = `${dup}<img src="${src}" alt="Comprobante de ${esc(d.alias)}">`;
      } else $('#modalBody').innerHTML = `${dup}<p>El comprobante es un PDF.</p><a class="primary link-btn" target="_blank" rel="noopener" href="/api/admin/receipt/${encodeURIComponent(id)}">Abrir PDF en otra pestaña</a>`;
    } catch (err) { $('#modalBody').innerHTML = `<p class="notice error">${esc(err.message)}</p>`; }
  }
  $('#modalActions').addEventListener('click', e => { const b = e.target.closest('[data-don]'); if (b) setStatus($('#modalActions').dataset.don, b.dataset.don); });
  $('#cmManualForm').amountCop.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  $('#cmManualForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await api('/api/admin/donations', { method: 'POST', headers: JSON_H, body: JSON.stringify({ alias: f.alias.value, amountCop: f.amountCop.value }) }); f.reset(); toast('Donación agregada y verificada.', 'ok'); filter = 'verificada'; await load(); }
    catch (err) { toast(err.message, 'bad'); }
  });

  /* ---------- Creadores ---------- */
  function creatorHtml(c, i) {
    const links = [...c.links]; while (links.length < 4) links.push({});
    const saved = savedIds.has(c.id);
    return `<div class="cm-creator" data-i="${i}">
      <div class="cm-cr-head"><b>Creador ${i + 1}</b><button type="button" class="bad-btn small-btn" data-rm="${i}">Quitar</button></div>
      <div class="cm-cr-grid">
        <div class="cm-cr-photo">
          ${c.imageVersion ? `<img src="/api/community-image/${esc(c.id)}?v=${c.imageVersion}" alt="" width="96" height="96">` : '<span class="small">Sin foto</span>'}
          ${saved ? `<label class="secondary file-btn small-btn">Subir foto<input type="file" accept="image/jpeg,image/png" hidden data-photo="${i}"></label>${c.imageVersion ? `<button type="button" class="secondary small-btn" data-photodel="${i}">Quitar foto</button>` : ''}` : '<span class="small">Guarda para subir foto</span>'}
        </div>
        <div class="cm-cr-fields">
          <label>Nombre<input data-f="name" maxlength="60" value="${esc(c.name)}" placeholder="Ej. Bryan G."></label>
          <label>Rol (opcional)<input data-f="role" maxlength="60" value="${esc(c.role)}" placeholder="Ej. Streamer"></label>
          <label>Descripción (opcional)<textarea data-f="bio" maxlength="400" rows="2">${esc(c.bio)}</textarea></label>
        </div>
      </div>
      <div class="link-rows">${links.slice(0, 6).map((l, k) => `<div class="link-row"><input data-lbl maxlength="30" placeholder="Red (ej. Instagram)" value="${esc(l.label || '')}"><input data-url type="url" maxlength="300" placeholder="https://…" value="${esc(l.url || '')}"></div>`).join('')}</div>
    </div>`;
  }
  function readCreators() {
    return [...document.querySelectorAll('.cm-creator')].map((el, i) => ({
      id: creators[i].id, imageVersion: creators[i].imageVersion,
      name: el.querySelector('[data-f=name]').value, role: el.querySelector('[data-f=role]').value, bio: el.querySelector('[data-f=bio]').value,
      links: [...el.querySelectorAll('.link-row')].map(r => ({ label: r.querySelector('[data-lbl]').value, url: r.querySelector('[data-url]').value }))
    }));
  }
  function drawCreators() {
    $('#cmCreators').innerHTML = creators.length ? creators.map(creatorHtml).join('') : '<p class="small">Todavía no hay creadores. Agrega el primero.</p>';
    $('#cmAddCreator').disabled = creators.length >= 6;
    const sel = $('#cmClipForm').creatorId, cur = sel.value;
    sel.innerHTML = '<option value="">Sin asignar</option>' + view.creators.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    sel.value = cur;
  }
  $('#cmAddCreator').addEventListener('click', () => { creators = readCreators(); creators.push({ id: uid(), name: '', role: '', bio: '', links: [], imageVersion: null }); drawCreators(); });
  $('#cmCreators').addEventListener('click', async e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { creators = readCreators(); creators.splice(Number(rm.dataset.rm), 1); drawCreators(); return; }
    const pd = e.target.closest('[data-photodel]');
    if (pd) { const c = creators[Number(pd.dataset.photodel)]; try { await api(`/api/admin/community/image/${c.id}`, { method: 'DELETE' }); toast('Foto eliminada.', 'ok'); await load(true); } catch (err) { toast(err.message, 'bad'); } }
  });
  $('#cmCreators').addEventListener('change', async e => {
    const inp = e.target.closest('[data-photo]'); if (!inp) return;
    const f = inp.files[0]; inp.value = ''; if (!f) return;
    const c = creators[Number(inp.dataset.photo)];
    try { await upload(c.id, await prepImage(f, 'foto.jpg')); toast('Foto actualizada.', 'ok'); await load(true); }
    catch (err) { toast(err.message, 'bad'); }
  });
  $('#cmSaveCreators').addEventListener('click', async () => {
    try {
      const r = await api('/api/admin/community/creators', { method: 'PUT', headers: JSON_H, body: JSON.stringify({ creators: readCreators() }) });
      flash($('#cmCreatorMsg'), 'Creadores guardados. Ya se ven en la página principal.', 'success'); await load(true);
    } catch (err) { flash($('#cmCreatorMsg'), err.message, 'error'); }
  });

  /* ---------- Clips ---------- */
  function renderClips() {
    $('#cmClips').innerHTML = view.clips.length ? view.clips.map(k => {
      const who = (view.creators.find(c => c.id === k.creatorId) || {}).name;
      return `<li><span><b>${esc(k.title)}</b> <span class="pill">${esc(k.platform)}</span>${who ? ` <span class="small">· ${esc(who)}</span>` : ''}<br><a class="small" href="${esc(k.url)}" target="_blank" rel="noopener">${esc(k.url)}</a></span><button type="button" class="bad-btn small-btn" data-clipdel="${esc(k.id)}">Quitar</button></li>`;
    }).join('') : '<li class="small">Todavía no hay clips.</li>';
  }
  $('#cmClipForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await api('/api/admin/community/clips', { method: 'POST', headers: JSON_H, body: JSON.stringify({ title: f.title.value, url: f.url.value, creatorId: f.creatorId.value }) }); f.title.value = ''; f.url.value = ''; flash($('#cmClipMsg'), 'Clip agregado.', 'success'); await load(true); }
    catch (err) { flash($('#cmClipMsg'), err.message, 'error'); }
  });
  $('#cmClips').addEventListener('click', async e => {
    const b = e.target.closest('[data-clipdel]'); if (!b) return;
    try { await api(`/api/admin/community/clips/${encodeURIComponent(b.dataset.clipdel)}`, { method: 'DELETE' }); toast('Clip eliminado.', 'ok'); await load(true); }
    catch (err) { toast(err.message, 'bad'); }
  });


  /* ---------- Aviso en vivo ---------- */
  const lf = $('#cmLiveForm');
  lf.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/admin/community/live', { method: 'PUT', headers: JSON_H, body: JSON.stringify({ on: lf.on.checked, title: lf.title.value, url: lf.url.value }) });
      liveDirty = false; flash($('#cmLiveMsg'), lf.on.checked ? 'Listo: la franja «EN VIVO» ya se ve en la portada.' : 'Aviso apagado.', 'success'); }
    catch (err) { flash($('#cmLiveMsg'), err.message, 'error'); }
  });
  lf.addEventListener('input', () => { liveDirty = true; });
  lf.addEventListener('change', () => { liveDirty = true; });

  /* ---------- Agenda ---------- */
  const toLocal = iso => new Date(Date.parse(iso) - 5 * 3600e3).toISOString().slice(0, 16); // hora de Colombia (UTC-5)
  const fromLocal = v => v ? new Date(`${v}:00-05:00`).toISOString() : '';
  function drawAgenda() {
    $('#cmAgenda').innerHTML = agenda.length ? agenda.map((a, i) => `<div class="cm-agenda-row" data-i="${i}">
      <label>Título<input data-a="title" maxlength="80" value="${esc(a.title)}" placeholder="Ej. Directo de la ruleta"></label>
      <label>Fecha y hora (Colombia)<input data-a="when" type="datetime-local" value="${a.whenIso ? toLocal(a.whenIso) : ''}"></label>
      <label>Nota (opcional)<input data-a="note" maxlength="120" value="${esc(a.note || '')}" placeholder="Ej. Desde las 8 pm en TikTok"></label>
      <button type="button" class="bad-btn small-btn" data-agrm="${i}">Quitar</button></div>`).join('') : '<p class="small">No hay directos programados.</p>';
    $('#cmAddAgenda').disabled = agenda.length >= 8;
  }
  function readAgenda() {
    return [...document.querySelectorAll('.cm-agenda-row')].map((el, i) => ({ id: agenda[i].id, title: el.querySelector('[data-a=title]').value, note: el.querySelector('[data-a=note]').value, whenIso: fromLocal(el.querySelector('[data-a=when]').value) }));
  }
  $('#cmAddAgenda').addEventListener('click', () => { agenda = readAgenda(); agenda.push({ title: '', note: '', whenIso: '' }); drawAgenda(); });
  $('#cmAgenda').addEventListener('click', e => { const b = e.target.closest('[data-agrm]'); if (b) { agenda = readAgenda(); agenda.splice(Number(b.dataset.agrm), 1); drawAgenda(); agendaDirty = true; } });
  $('#cmAgenda').addEventListener('input', () => { agendaDirty = true; });
  $('#cmSaveAgenda').addEventListener('click', async () => {
    try { await api('/api/admin/community/agenda', { method: 'PUT', headers: JSON_H, body: JSON.stringify({ agenda: readAgenda() }) }); agendaDirty = false; flash($('#cmAgendaMsg'), 'Agenda guardada. Ya se ve en la portada.', 'success'); await load(true); }
    catch (err) { flash($('#cmAgendaMsg'), err.message, 'error'); }
  });

  /* ---------- Metas logradas ---------- */
  function renderPast() {
    const list = view.pastGoals || [];
    $('#cmPastBlock').classList.toggle('hidden', !list.length);
    $('#cmPast').innerHTML = list.map(p => `<li><span>${p.imageVersion ? `<img src="/api/community-image/${esc(p.id)}?v=${p.imageVersion}" alt="" width="64" height="40" class="cm-thumb">` : ''}<b>${esc(p.title)}</b> <span class="small">· ${copFmt(p.raisedCop)} · ${esc(when(p.reachedAtIso))}</span></span>
      <span class="cm-past-actions"><label class="secondary file-btn small-btn">Foto<input type="file" accept="image/jpeg,image/png" hidden data-pastphoto="${esc(p.id)}"></label>${p.imageVersion ? `<button type="button" class="secondary small-btn" data-pastphotodel="${esc(p.id)}">Quitar foto</button>` : ''}<button type="button" class="bad-btn small-btn" data-pastdel="${esc(p.id)}">Quitar</button></span></li>`).join('');
  }
  $('#cmPast').addEventListener('change', async e => {
    const inp = e.target.closest('[data-pastphoto]'); if (!inp) return;
    const f = inp.files[0]; inp.value = ''; if (!f) return;
    try { await upload(inp.dataset.pastphoto, await prepImage(f, 'meta-lograda.jpg')); toast('Foto actualizada.', 'ok'); await load(); } catch (err) { toast(err.message, 'bad'); }
  });
  $('#cmPast').addEventListener('click', async e => {
    const d1 = e.target.closest('[data-pastphotodel]'), d2 = e.target.closest('[data-pastdel]');
    try {
      if (d1) { await api(`/api/admin/community/image/${encodeURIComponent(d1.dataset.pastphotodel)}`, { method: 'DELETE' }); await load(); }
      if (d2 && confirm('¿Quitar esta meta de la lista de metas logradas?')) { await api(`/api/admin/community/past/${encodeURIComponent(d2.dataset.pastdel)}`, { method: 'DELETE' }); await load(); }
    } catch (err) { toast(err.message, 'bad'); }
  });

  function render(forceCreators) {
    renderGoal(); renderDonations(); renderClips(); renderPast();
    if (!liveDirty) { lf.on.checked = Boolean(view.live.on); lf.title.value = view.live.title || ''; lf.url.value = view.live.url || ''; }
    if (!agendaDirty) { agenda = view.agenda.map(a => ({ ...a })); drawAgenda(); }
    const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.cm-creator');
    if (forceCreators || (!editing && !creators.some(c => !savedIds.has(c.id)))) {
      savedIds = new Set(view.creators.map(c => c.id));
      creators = view.creators.map(c => ({ ...c, links: c.links.map(l => ({ ...l })) }));
      drawCreators();
    }
  }
  load = async function (force) { try { view = await api('/api/admin/community'); render(force === true); } catch (err) { flash($('#cmGoalMsg'), err.message, 'error'); } };

  // El panel del evento de la Quinta solo se ve en las pestañas de la Quinta.
  const evPanel = $('#eventPanel');
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => evPanel.classList.toggle('hidden', ['ruleta', 'comunidad'].includes(t.dataset.tab))));

  $('#tab-comunidad').addEventListener('click', () => load(true));
  setInterval(() => { if (!document.hidden && !$('#app').classList.contains('hidden') && modal.classList.contains('hidden')) load(); }, 30000);
  setTimeout(() => { if (!$('#app').classList.contains('hidden')) load(true); }, 1600);
})();
