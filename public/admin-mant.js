/* Privacidad, respaldo, reportes y QR por vista. Usa $, api, esc, flash, toast, copFmt de admin.js */
(() => {
  const JSON_H = { 'Content-Type': 'application/json' };


  // Acceso de verificador (solo revisa pagos)
  const vf = $('#verifierForm');
  async function refreshVerifier() {
    try {
      const s = await api('/api/admin/settings');
      $('#verifierState').textContent = s.hasVerifier ? 'Acceso de verificador activo.' : 'Sin acceso de verificador.';
      $('#verifierDel').classList.toggle('hidden', !s.hasVerifier);
    } catch { /* se verá al volver a abrir */ }
  }
  vf.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/admin/verifier-password', { method: 'POST', headers: JSON_H, body: JSON.stringify({ password: vf.password.value }) }); vf.reset(); flash($('#verifierMsg'), 'Listo. Pásale la contraseña a tu verificador; entra desde la misma página de administración.', 'success'); refreshVerifier(); }
    catch (err) { flash($('#verifierMsg'), err.message, 'error'); }
  });
  $('#verifierDel').addEventListener('click', async () => {
    if (!confirm('¿Quitar el acceso del verificador? Su sesión se cierra de inmediato.')) return;
    try { await api('/api/admin/verifier-password', { method: 'DELETE' }); flash($('#verifierMsg'), 'Acceso eliminado.', 'success'); refreshVerifier(); }
    catch (err) { flash($('#verifierMsg'), err.message, 'error'); }
  });
  $('#tab-ajustes').addEventListener('click', refreshVerifier);


  // Enlaces cortos y tarjetas para el live
  const LT = [['Bono de la Quinta', 'q', 'quinta'], ['Ruleta de Seguidores', 'r', 'ruleta'], ['Donaciones', 'd', 'donar'], ['Página principal', '', 'home']];
  const hostLink = k => `${location.host}/${k}`.replace(/\/$/, '');
  $('#ltRows').innerHTML = LT.map(([name, k, to]) => `<div class="lt-row"><b>${name}</b><code>${hostLink(k)}</code>
    <button type="button" class="secondary small-btn" data-copy="${location.origin}/${k}">Copiar enlace</button>
    <button type="button" class="secondary small-btn" data-copy="${location.origin}/overlay.html?to=${to}">Copiar tarjeta para OBS</button>
    <a class="secondary link-btn small-btn" target="_blank" rel="noopener" href="/overlay.html?to=${to}">Ver tarjeta ↗</a></div>`).join('');
  $('#ltRows').addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado.', 'ok'); } catch { prompt('Copia esta dirección:', b.dataset.copy); }
  });

  // QR de cada vista
  document.querySelectorAll('[data-qr]').forEach(b => b.addEventListener('click', () => {
    $('#qrUrl').value = location.origin + b.dataset.qr; $('#qrUpdate').click();
  }));

  // Borrar comprobantes antiguos
  $('#purgeBtn').addEventListener('click', async () => {
    const days = Number($('#purgeDays').value), msg = $('#purgeMsg');
    if (!confirm(`¿Borrar los comprobantes de hace más de ${days} días? Se conserva la huella para detectar repetidos. No se puede deshacer.`)) return;
    try {
      const r = await api('/api/admin/purge-receipts', { method: 'POST', headers: JSON_H, body: JSON.stringify({ days }) });
      flash(msg, r.deleted ? `Listo: se borraron ${r.deleted} comprobante(s).` : 'No había comprobantes tan antiguos.', 'success');
    } catch (err) { flash(msg, err.message, 'error'); }
  });

  // Eliminar datos de una persona
  $('#erasePhone').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  $('#eraseBtn').addEventListener('click', async () => {
    const phone = $('#erasePhone').value, msg = $('#eraseMsg');
    if (!/^\d{10}$/.test(phone)) return flash(msg, 'Escribe el celular de 10 dígitos.', 'error');
    if (!confirm(`¿Eliminar TODOS los datos asociados al celular ${phone}? Esto no se puede deshacer.`)) return;
    try {
      const r = await api('/api/admin/person/erase', { method: 'POST', headers: JSON_H, body: JSON.stringify({ phone }) });
      flash(msg, r.records ? `Listo: ${r.records} registro(s) anonimizado(s) y ${r.receipts} comprobante(s) borrado(s).` : 'No se encontraron datos con ese celular.', 'success');
      $('#erasePhone').value = '';
    } catch (err) { flash(msg, err.message, 'error'); }
  });

  // Reportes
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthName = m => { const [y, n] = m.split('-').map(Number); return `${MONTHS[n - 1]} ${y}`; };
  const fmtDay = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`; };
  const signed = n => n == null ? '—' : `<b class="${n < 0 ? 'neg' : n > 0 ? 'pos' : ''}">${n < 0 ? '−' : n > 0 ? '+' : ''}${copFmt(Math.abs(n))}</b>`;
  const STATE = { abierta: 'Abierta', cerrada: 'Cerrada', sorteada: 'Sorteada', cancelada: 'Cancelada' };
  const empty = (n, t) => `<tr><td colspan="${n}" class="empty">${t}</td></tr>`;
  async function loadReport() {
    try {
      const d = await api('/api/admin/report');
      $('#repMonths').innerHTML = d.months.length ? d.months.map(m => `<tr><td data-label="Mes">${esc(monthName(m.month))}</td><td data-label="Quinta">${copFmt(m.quintaCop)}</td><td data-label="Ruleta">${signed(m.ruletaCop)}</td></tr>`).join('') : empty(3, 'Aún no hay datos.');
      $('#repQuinta').innerHTML = d.quinta.length ? d.quinta.map(e => `<tr><td data-label="Quinta del">${esc(fmtDay(e.quintaDate))}</td><td data-label="Registros">${e.registrations}</td><td data-label="Aceptados">${e.accepted}</td><td data-label="Recaudo">${copFmt(e.acceptedCop)}</td></tr>`).join('') : empty(4, 'Aún no hay eventos.');
      $('#repRuleta').innerHTML = d.ruleta.length ? d.ruleta.map(r => `<tr><td data-label="Ruleta">${esc(r.name)}<br><span class="small">${esc(fmtDay(String(r.createdAtIso).slice(0, 10)))}</span></td><td data-label="Estado">${esc(STATE[r.status] || r.status)}</td><td data-label="Puestos">${r.seatsSold}/${r.seatsTotal}</td><td data-label="Recaudo">${copFmt(r.collectedCop)}</td><td data-label="Premio">${copFmt(r.prizeValueCop)}</td><td data-label="Resultado">${signed(r.resultCop)}</td></tr>`).join('') : empty(6, 'Aún no hay ruletas.');
      $('#repMsg').textContent = '';
    } catch (err) { $('#repMsg').textContent = err.message; }
  }
  $('#tab-reportes').addEventListener('click', loadReport);
})();
