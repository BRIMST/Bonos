(() => {
  const $ = s => document.querySelector(s);
  const form = $('#lookupForm'), msg = $('#lookupMsg'), box = $('#lookupResults');
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = iso => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))); };
  const Q = {
    aceptada: ['ok', 'Pago verificado: tu número participa.'],
    pendiente_verificacion: ['warn', 'Estamos verificando tu pago. Vuelve a consultar en un rato.'],
    rechazada: ['bad', 'No pudimos verificar tu pago, por eso este registro no participa.']
  };
  const R = {
    aprobada: ['ok', 'Pago verificado: tus puestos participan.'],
    pendiente: ['warn', 'Estamos verificando tu pago. Tus puestos siguen apartados.'],
    rechazada: ['bad', 'No pudimos verificar tu pago, tus puestos quedaron libres.']
  };
  form.phone.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); });
  form.code.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 5); });
  form.addEventListener('submit', async e => {
    e.preventDefault(); box.innerHTML = ''; msg.className = 'notice'; msg.textContent = 'Consultando…';
    $('#lookupBtn').disabled = true;
    try {
      const res = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: form.phone.value, code: form.code.value }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'No se pudo consultar.');
      if (!out.results.length) { msg.textContent = 'No encontramos nada con esos datos. Revisa el celular y el número, o intenta de nuevo en unos minutos.'; msg.className = 'notice warning'; return; }
      msg.textContent = ''; msg.className = 'notice';
      box.innerHTML = out.results.map(r => {
        if (r.type === 'quinta') {
          const [k, t] = Q[r.status] || Q.pendiente_verificacion;
          return `<article class="lk ${k}"><b>Bono de la Quinta · ${esc(r.number)}</b><p>${esc(t)}</p><small>Registrado el ${esc(fmtDay(r.date))}${r.quintaDate ? ` · juega en la Quinta del ${esc(fmtDay(r.quintaDate))}` : ''}</small></article>`;
        }
        const [k, t] = R[r.status] || R.pendiente;
        let extra = '';
        if (r.current && r.rouletteStatus === 'cancelada') extra = '<p>El evento fue cancelado: el organizador te devolverá tu aporte.</p>';
        else if (r.current && r.rouletteStatus === 'sorteada') extra = '<p>La ruleta ya fue sorteada. Mira el resultado en la página de la ruleta.</p>';
        return `<article class="lk ${k}"><b>Ruleta · puesto${r.seats.length > 1 ? 's' : ''} ${esc(r.seats.join(', '))}</b><p>${esc(t)}</p>${extra}</article>`;
      }).join('');
    } catch (err) { msg.textContent = err.message; msg.className = 'notice error'; }
    finally { $('#lookupBtn').disabled = false; }
  });
})();
