const loginPanel = document.querySelector('#loginPanel');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#loginForm');
const loginMessage = document.querySelector('#loginMessage');
const rows = document.querySelector('#rows');
const tableMessage = document.querySelector('#tableMessage');
let todayOnly = false;

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || 'Error en la solicitud.');
  return data;
}
function showDashboard(show) {
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
    if (data.authenticated) await loadRecords();
  } catch { showDashboard(false); }
}
loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginMessage.textContent = 'Validando…';
  try {
    await api('/api/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: loginForm.password.value}) });
    loginForm.reset();
    showDashboard(true);
    await loadRecords();
  } catch (err) { loginMessage.textContent = err.message; }
});
document.querySelector('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method:'POST' }); } finally { showDashboard(false); }
});
document.querySelector('#allRecords').addEventListener('click', () => { todayOnly = false; loadRecords(); });
document.querySelector('#todayRecords').addEventListener('click', () => { todayOnly = true; loadRecords(); });
document.querySelector('#refresh').addEventListener('click', loadRecords);
document.querySelector('#exportCsv').addEventListener('click', () => { window.location.href = '/api/admin/export.csv'; });
document.querySelector('#exportXlsx').addEventListener('click', () => { window.location.href = '/api/admin/export.xlsx'; });

async function loadRecords() {
  rows.innerHTML = '<tr><td colspan="9">Cargando…</td></tr>'
  tableMessage.textContent = '';
  try {
    const data = await api(`/api/admin/registrations${todayOnly ? '?today=1' : ''}`);
    const s = data.status;
    document.querySelector('#adminStatus').textContent =
      `Fecha Bogotá: ${s.date} · Hora del servidor: ${s.time} · ${s.closed ? 'Cierre de hoy realizado' : 'Recepción abierta hasta las 19:00'}`;
    if (!data.records.length) {
      rows.innerHTML = '<tr><td colspan="9">No hay registros para este filtro.</td></tr>';
      return;
    }
    rows.innerHTML = data.records.map(r => `<tr>
      <td title="${esc(r.id)}">${esc(r.id.slice(0,8))}…</td>
      <td>${esc(r.createdDateBogota)} ${esc(r.createdTimeBogota)}${r.receivedAfterClose ? '<br><span class="tag">Después del cierre</span>' : ''}<br><span class="small">Día asignado: ${esc(r.assignedDate)}</span></td>
      <td>${esc(r.fullName)}</td><td>${esc(r.socialUser)}</td><td>${esc(r.phone)}</td><td class="number">${esc(r.number)}</td>
      <td><select data-payment="${esc(r.id)}"><option value="pendiente_revision" ${r.paymentStatus==='pendiente_revision'?'selected':''}>Pendiente</option><option value="verificado" ${r.paymentStatus==='verificado'?'selected':''}>Verificado</option><option value="rechazado" ${r.paymentStatus==='rechazado'?'selected':''}>Rechazado</option></select></td>
      <td>${esc(r.participationStatus || 'pendiente_verificacion')}</td><td><button class="secondary small-btn" data-receipt="${esc(r.id)}">Ver</button></td>
    </tr>`).join('');
    rows.querySelectorAll('[data-receipt]').forEach(btn => btn.addEventListener('click', () => viewReceipt(btn.dataset.receipt)));
    rows.querySelectorAll('[data-payment]').forEach(sel => sel.addEventListener('change', () => updatePayment(sel.dataset.payment, sel.value)));
    tableMessage.textContent = `${data.records.length} registro(s).`;
  } catch (err) {
    rows.innerHTML = '<tr><td colspan="9">No se pudieron cargar los registros.</td></tr>';
    tableMessage.textContent = err.message;
  }
}
async function viewReceipt(id) {
  try {
    const data = await api(`/api/admin/receipt/${encodeURIComponent(id)}`);
    window.open(data.url, '_blank', 'noopener,noreferrer');
  } catch (err) { alert(err.message); }
}
async function updatePayment(id, paymentStatus) {
  try {
    await api(`/api/admin/registrations/${encodeURIComponent(id)}/payment`, {
      method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({paymentStatus})
    });
    tableMessage.textContent = 'Estado del pago actualizado.';
  } catch (err) {
    tableMessage.textContent = err.message;
    await loadRecords();
  }
}
checkSession();
