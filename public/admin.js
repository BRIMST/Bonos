const loginPanel = document.querySelector('#loginPanel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginMessage = document.querySelector('#loginMessage');
const rows = document.querySelector('#rows');
const tableMessage = document.querySelector('#tableMessage');
let dayMode = false;
const dayPicker = document.querySelector('#dayPicker');
const LABELS = { aceptada: 'Aceptada', rechazada: 'Rechazada', pendiente_verificacion: 'Pendiente' };
const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || 'Error en la solicitud.');
  return data;
}
const settingsPanel = document.querySelector('#settingsPanel');
function showDashboard(show) {
  settingsPanel.classList.toggle('hidden', !show);
  loginPanel.classList.toggle('hidden', show);
  dashboard.classList.toggle('hidden', !show);
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function checkSession() {
  try {
    const data = await api('/api/admin/me');
    showDashboard(data.authenticated);
    if (data.authenticated) { await loadSettings(); await loadRecords(); }
  } catch { showDashboard(false); }
}
loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginMessage.textContent = 'Validando…';
  try {
    await api('/api/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: loginForm.password.value}) });
    loginForm.reset();
    showDashboard(true);
    await loadSettings();
    await loadRecords();
  } catch (err) { loginMessage.textContent = err.message; }
});
document.querySelector('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method:'POST' }); } finally { showDashboard(false); }
});
document.querySelector('#allRecords').addEventListener('click', () => { dayMode = false; loadRecords(); });
document.querySelector('#todayRecords').addEventListener('click', () => { dayMode = true; loadRecords(); });
dayPicker.addEventListener('change', () => { dayMode = true; loadRecords(); });
document.querySelector('#refresh').addEventListener('click', loadRecords);
document.querySelector('#exportCsv').addEventListener('click', () => { window.location.href = '/api/admin/export.csv' + dateQuery('?'); });
document.querySelector('#exportXlsx').addEventListener('click', () => { window.location.href = '/api/admin/export.xlsx' + dateQuery('?'); });

function dateQuery(prefix) {
  return dayMode && dayPicker.value ? `${prefix}date=${encodeURIComponent(dayPicker.value)}` : '';
}
async function loadRecords() {
  rows.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>';
  tableMessage.textContent = '';
  try {
    const data = await api(`/api/admin/registrations${dayMode ? (dayPicker.value ? dateQuery('?') : '?today=1') : ''}`);
    const s = data.status;
    if (!dayPicker.value) dayPicker.value = s.date;
    const sm = data.summary;
    document.querySelector('#summary').innerHTML =
      `<div><b>${sm.total}</b><span>Registros${data.date ? ' · ' + esc(data.date) : ''}</span></div>` +
      `<div><b>${sm.accepted}</b><span>Aceptados</span></div>` +
      `<div><b>${sm.pending}</b><span>Pendientes</span></div>` +
      `<div><b>${sm.rejected}</b><span>Rechazados</span></div>` +
      `<div><b>${esc(cop(sm.acceptedAmountCop))}</b><span>Recaudo aceptado</span></div>`;
    document.querySelector('#adminStatus').textContent =
      `Fecha Bogotá: ${s.date} · Hora del servidor: ${s.time} · ${s.closed ? 'Cierre de hoy realizado' : 'Recepción abierta hasta las 19:00'}`;
    if (!data.records.length) {
      rows.innerHTML = '<tr><td colspan="9">No hay registros para este filtro.</td></tr>';
      return;
    }
    rows.innerHTML = data.records.map(r => `<tr>
      <td data-label="ID" title="${esc(r.id)}">${esc(r.id.slice(0,8))}…</td>
      <td data-label="Fecha / hora">${esc(r.createdDateBogota)} ${esc(r.createdTimeBogota)}${r.receivedAfterClose ? '<br><span class="tag">Después del cierre</span>' : ''}<br><span class="small">Día asignado: ${esc(r.assignedDate)}</span></td>
      <td data-label="Nombre">${esc(r.fullName)}</td><td data-label="Red social">${esc(r.socialUser)}</td><td data-label="Celular">${esc(r.phone)}</td><td data-label="Número" class="number">${esc(r.number)}</td>
      <td data-label="Pago"><select data-payment="${esc(r.id)}"><option value="pendiente_revision" ${r.paymentStatus==='pendiente_revision'?'selected':''}>Pendiente</option><option value="verificado" ${r.paymentStatus==='verificado'?'selected':''}>Verificado</option><option value="rechazado" ${r.paymentStatus==='rechazado'?'selected':''}>Rechazado</option></select></td>
      <td data-label="Participación">${esc(LABELS[r.participationStatus] || r.participationStatus || 'Pendiente')}</td><td data-label="Comprobante"><button class="secondary small-btn" data-receipt="${esc(r.id)}">Ver</button></td>
    </tr>`).join('');
    rows.querySelectorAll('[data-receipt]').forEach(btn => btn.addEventListener('click', () => viewReceipt(btn.dataset.receipt)));
    rows.querySelectorAll('[data-payment]').forEach(sel => sel.addEventListener('change', () => updatePayment(sel.dataset.payment, sel.value)));
    tableMessage.textContent = `${data.records.length} registro(s).`;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="9">No se pudieron cargar los registros.</td></tr>';
    tableMessage.textContent = err.message;
  }
}
function viewReceipt(id) {
  window.open(`/api/admin/receipt/${encodeURIComponent(id)}`, '_blank', 'noopener');
}
async function updatePayment(id, paymentStatus) {
  try {
    await api(`/api/admin/registrations/${encodeURIComponent(id)}/payment`, {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({paymentStatus})
    });
    tableMessage.textContent = 'Estado del pago actualizado.';
    await loadRecords();
  } catch (err) {
    tableMessage.textContent = err.message;
    await loadRecords();
  }
}
const brebForm = document.querySelector('#brebForm');
const passwordForm = document.querySelector('#passwordForm');
function flash(el, text, kind) { el.textContent = text; el.className = `notice ${kind || ''}`; }
async function loadSettings() {
  try {
    const st = await api('/api/admin/settings');
    brebForm.brebLabel.value = st.brebLabel;
    brebForm.brebValue.value = st.brebValue;
  } catch (err) { flash(document.querySelector('#brebMessage'), err.message, 'error'); }
}
brebForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.querySelector('#brebMessage');
  try {
    await api('/api/admin/settings', { method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ brebLabel: brebForm.brebLabel.value, brebValue: brebForm.brebValue.value }) });
    flash(msg, 'Datos de pago guardados. Ya se ven en la página pública.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});
passwordForm.addEventListener('submit', async e => {
  e.preventDefault();
  const msg = document.querySelector('#passwordMessage');
  if (passwordForm.newPassword.value !== passwordForm.confirmPassword.value) return flash(msg, 'Las contraseñas nuevas no coinciden.', 'error');
  try {
    await api('/api/admin/password', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ currentPassword: passwordForm.currentPassword.value, newPassword: passwordForm.newPassword.value }) });
    passwordForm.reset();
    flash(msg, 'Contraseña actualizada. Las demás sesiones abiertas se cerraron.', 'success');
  } catch (err) { flash(msg, err.message, 'error'); }
});
checkSession();
