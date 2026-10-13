const $ = s => document.querySelector(s);
const loginPanel = $('#loginPanel'), appBox = $('#app'), logoutBtn = $('#logout');
const rows = $('#rows'), dayPicker = $('#dayPicker');
const LABELS = { aceptada: 'Aceptada', rechazada: 'Rechazada', pendiente_verificacion: 'Por revisar' };
const PILL = { aceptada: 'ok', rechazada: 'bad', pendiente_verificacion: 'warn' };
const copFmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
let records = [], statusInfo = null, filter = 'todos', query = '', allDays = false, lastFocus = null;

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || 'Error en la solicitud.');
  return data;
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function flash(el, text, kind) { el.textContent = text; el.className = `notice ${kind || ''}`; }
let toastTimer;
function toast(text, kind = 'ok') {
  const t = $('#toast');
  t.textContent = text; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

/* ---------- Sesión ---------- */
function showApp(show) {
  loginPanel.classList.toggle('hidden', show);
  appBox.classList.toggle('hidden', !show);
  logoutBtn.classList.toggle('hidden', !show);
}
async function startApp() {
  showApp(true);
  await Promise.all([loadSettings(), load(true)]);
}
async function checkSession() {
  try {
    const data = await api('/api/admin/me');
    if (data.authenticated) await startApp(); else showApp(false);
  } catch { showApp(false); }
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, msg = $('#loginMessage');
  flash(msg, 'Validando…');
  try {
    await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.password.value }) });
    f.reset(); flash(msg, '');
    await startApp();
  } catch (err) { flash(msg, err.message, 'error'); }
});
logoutBtn.addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } finally { showApp(false); }
});

/* ---------- Pestañas ---------- */
const tabs = [...document.querySelectorAll('.tab')];
function selectTab(name) {
  tabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on); t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
    $(`#view-${t.dataset.tab}`).classList.toggle('hidden', !on);
  });
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t.dataset.tab));
  t.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    n.focus(); selectTab(n.dataset.tab);
  });
});

/* ---------- Registros ---------- */
function dateQuery(prefix) { return !allDays && dayPicker.value ? `${prefix}date=${encodeURIComponent(dayPicker.value)}` : ''; }
async function load(initial = false, silent = false) {
  if (!silent) rows.innerHTML = '<tr><td colspan="5">Cargando…</td></tr>';
  try {
    const url = initial ? '/api/admin/registrations?today=1' : allDays ? '/api/admin/registrations' : `/api/admin/registrations${dateQuery('?') || '?today=1'}`;
    const data = await api(url);
    records = data.records; statusInfo = data.status;
    if (initial || !dayPicker.value) dayPicker.value = data.date || statusInfo.date;
    $('#adminStatus').innerHTML = `<b>${esc(statusInfo.date)}</b> hora del servidor ${esc(statusInfo.time)}: ` +
      (statusInfo.closed ? '<span class="chip bad">Jornada cerrada</span>' : '<span class="chip ok">Recepción abierta hasta las 7:00 p. m.</span>');
    const s = data.summary;
    $('#sTotal').textContent = s.total; $('#sPending').textContent = s.pending;
    $('#sAccepted').textContent = s.accepted; $('#sRejected').textContent = s.rejected;
    $('#sMoney').textContent = copFmt(s.acceptedAmountCop);
    const b = $('#pendingBadge'); b.textContent = s.pending; b.classList.toggle('hidden', !s.pending);
    $('#hint').textContent = statusInfo.closed
      ? 'La jornada cerró: las participaciones aceptadas ya no se pueden modificar y las pendientes no participan.'
      : 'Abre cada comprobante, confirma la transferencia y marca el pago como verificado antes de las 7:00 p. m.';
    render();
  } catch (err) {
    if (!silent) rows.innerHTML = '<tr><td colspan="5">No se pudieron cargar los registros.</td></tr>';
    $('#tableMessage').textContent = err.message;
  }
}
function visible() {
  const q = query.trim().toLowerCase();
  return records.filter(r => (filter === 'todos' || r.participationStatus === filter) &&
    (!q || [r.fullName, r.socialUser, r.phone, r.number, r.id].some(v => String(v || '').toLowerCase().includes(q))));
}
function actionButtons(r) {
  return (r.participationStatus !== 'aceptada' ? `<button type="button" class="ok-btn small-btn" data-act="verificado" data-id="${esc(r.id)}">Verificar</button>` : '') +
    (r.participationStatus !== 'rechazada' ? `<button type="button" class="bad-btn small-btn" data-act="rechazado" data-id="${esc(r.id)}">Rechazar</button>` : '');
}
function render() {
  const list = visible();
  document.querySelectorAll('.stat[data-filter]').forEach(b => b.classList.toggle('on', b.dataset.filter === filter));
  if (!list.length) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">${records.length ? 'Ningún registro coincide con el filtro o la búsqueda.' : 'Aún no hay registros. Cuando alguien envíe su aporte aparecerá aquí.'}</td></tr>`;
    $('#tableMessage').textContent = '';
    return;
  }
  rows.innerHTML = list.map(r => `<tr>
    <td data-label="Hora">${esc(r.createdTimeBogota)}<br><span class="small">${esc(r.createdDateBogota)}</span></td>
    <td data-label="Participante"><b>${esc(r.fullName)}</b><br><span class="small">${esc(r.socialUser)}</span><br><span class="small">${esc(r.phone)}</span></td>
    <td data-label="Número" class="number">${esc(r.number)}</td>
    <td data-label="Estado"><span class="pill ${PILL[r.participationStatus] || 'warn'}">${esc(LABELS[r.participationStatus] || 'Por revisar')}</span></td>
    <td data-label="Acciones" class="actions"><button type="button" class="secondary small-btn" data-view="${esc(r.id)}">Ver comprobante</button>${actionButtons(r)}</td>
  </tr>`).join('');
  $('#tableMessage').textContent = `Mostrando ${list.length} de ${records.length}.`;
}
rows.addEventListener('click', e => {
  const v = e.target.closest('[data-view]'); if (v) return openReceipt(v.dataset.view, v);
  const a = e.target.closest('[data-act]'); if (a) setPayment(a.dataset.id, a.dataset.act);
});
async function setPayment(id, paymentStatus) {
  try {
    await api(`/api/admin/registrations/${encodeURIComponent(id)}/payment`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentStatus })
    });
    toast(paymentStatus === 'verificado' ? 'Pago verificado: participación aceptada.' : 'Pago rechazado.', paymentStatus === 'verificado' ? 'ok' : 'bad');
    closeModal();
  } catch (err) { toast(err.message, 'bad'); }
  await load(false, true);
}

/* filtros, búsqueda, fecha */
document.querySelectorAll('.stat[data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; render(); }));
$('#search').addEventListener('input', e => { query = e.target.value; render(); });
dayPicker.addEventListener('change', () => { allDays = false; filter = 'todos'; load(); });
$('#btnToday').addEventListener('click', () => { allDays = false; filter = 'todos'; load(true); });
$('#btnAllDays').addEventListener('click', () => { allDays = true; filter = 'todos'; load(); });
$('#refresh').addEventListener('click', () => load(false));
function doExport(kind) {
  $('#exportMenu').open = false;
  window.location.href = `/api/admin/export.${kind}${dateQuery('?')}`;
}
$('#exportXlsx').addEventListener('click', () => doExport('xlsx'));
$('#exportCsv').addEventListener('click', () => doExport('csv'));
document.addEventListener('click', e => { const m = $('#exportMenu'); if (m.open && !m.contains(e.target)) m.open = false; });
// Actualización silenciosa cada 45 s mientras se ve la lista.
setInterval(() => {
  if (!appBox.classList.contains('hidden') && !document.hidden && modal.classList.contains('hidden') &&
      !$('#view-registros').classList.contains('hidden')) load(false, true);
}, 45000);

/* ---------- Visor de comprobante ---------- */
const modal = $('#receiptModal');
async function openReceipt(id, trigger) {
  const r = records.find(x => x.id === id); if (!r) return;
  lastFocus = trigger || document.activeElement;
  $('#modalTitle').textContent = r.fullName;
  $('#modalSub').textContent = `Número ${r.number}, ${r.socialUser}, ${r.phone}. Estado: ${LABELS[r.participationStatus] || 'Por revisar'}.`;
  $('#modalBody').innerHTML = '<p class="small">Cargando comprobante…</p>';
  $('#modalActions').innerHTML = actionButtons(r);
  modal.classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#modalClose').focus();
  try {
    const res = await fetch(`/api/admin/receipt/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('No se pudo cargar el comprobante.');
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) {
      const blob = await res.blob();
      const url = await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
      $('#modalBody').innerHTML = `<img src="${url}" alt="Comprobante de ${esc(r.fullName)}">`;
    } else {
      $('#modalBody').innerHTML = `<p>El comprobante es un PDF.</p><a class="primary link-btn" target="_blank" rel="noopener" href="/api/admin/receipt/${encodeURIComponent(id)}">Abrir PDF en otra pestaña</a>`;
    }
  } catch (err) { $('#modalBody').innerHTML = `<p class="notice error">${esc(err.message)}</p>`; }
}
function closeModal() {
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden'); document.body.style.overflow = '';
  $('#modalBody').innerHTML = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
$('#modalClose').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
$('#modalActions').addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (a) setPayment(a.dataset.id, a.dataset.act); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- Pago y contraseña ---------- */
const brebForm = $('#brebForm'), passwordForm = $('#passwordForm');
async function loadSettings() {
  try {
    const st = await api('/api/admin/settings');
    brebForm.brebLabel.value = st.brebLabel;
    brebForm.brebValue.value = st.brebValue;
    fillPrize(st.prize);
  } catch (err) { flash($('#brebMessage'), err.message, 'error'); }
}
brebForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#brebMessage');
  try {
    await api('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brebLabel: brebForm.brebLabel.value, brebValue: brebForm.brebValue.value }) });
    flash(msg, 'Datos de pago guardados. Ya se ven en la página pública.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});
passwordForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#passwordMessage');
  if (passwordForm.newPassword.value !== passwordForm.confirmPassword.value) return flash(msg, 'Las contraseñas nuevas no coinciden.', 'error');
  try {
    await api('/api/admin/password', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: passwordForm.currentPassword.value, newPassword: passwordForm.newPassword.value }) });
    passwordForm.reset();
    flash(msg, 'Contraseña actualizada. Las demás sesiones abiertas se cerraron.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});

/* ---------- Premio ---------- */
const prizeForm = $('#prizeForm'), prizeImg = $('#prizePreview');
const MAX_PRIZE_BYTES = 780 * 1024;
function fillPrize(p) {
  prizeForm.name.value = p.name || '';
  prizeForm.description.value = p.description || '';
  prizeForm.mode.value = p.mode || 'premio';
  prizeForm.cashCop.value = p.cashCop || '';
  syncCash();
  showPrizeImage(p.imageVersion);
}
function syncCash() {
  const needs = prizeForm.mode.value !== 'premio';
  $('#cashLabel').classList.toggle('hidden', !needs);
  prizeForm.cashCop.required = needs;
}
function showPrizeImage(version) {
  prizeImg.classList.toggle('hidden', !version);
  $('#prizeNoImage').classList.toggle('hidden', Boolean(version));
  if (version) prizeImg.src = `/api/prize-image?v=${version}`;
}
prizeForm.mode.addEventListener('change', syncCash);
prizeForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#prizeMessage');
  try {
    await api('/api/admin/prize', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: prizeForm.name.value, description: prizeForm.description.value, mode: prizeForm.mode.value, cashCop: prizeForm.cashCop.value }) });
    flash(msg, 'Premio guardado. Ya se ve en la página pública.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});
async function shrinkPrize(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.88, 0.75, 0.6]) {
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_PRIZE_BYTES) return new File([blob], 'premio.jpg', { type: 'image/jpeg' });
    }
    scale *= 0.8;
  }
  throw new Error('No se pudo reducir la imagen. Prueba con otra.');
}
$('#prizeImage').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  const msg = $('#prizeImageMessage');
  if (!f) return;
  try {
    if (!['image/jpeg', 'image/png'].includes(f.type)) throw new Error('Usa una imagen JPG o PNG.');
    flash(msg, 'Subiendo imagen…');
    const file = f.size > MAX_PRIZE_BYTES ? await shrinkPrize(f) : f;
    const fd = new FormData(); fd.append('image', file, file.name);
    const r = await api('/api/admin/prize/image', { method: 'POST', body: fd });
    showPrizeImage(r.version);
    flash(msg, 'Imagen actualizada.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});
$('#prizeImageRemove').addEventListener('click', async () => {
  const msg = $('#prizeImageMessage');
  try { await api('/api/admin/prize/image', { method: 'DELETE' }); showPrizeImage(null); flash(msg, 'Imagen eliminada.', 'success'); }
  catch (err) { flash(msg, err.message, 'error'); }
});

checkSession();
