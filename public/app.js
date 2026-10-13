const form = document.querySelector('#registerForm');
const statusBox = document.querySelector('#status');
const message = document.querySelector('#formMessage');
const submitBtn = document.querySelector('#submitBtn');
let paymentKey = '';

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    paymentKey = s.brebValue;
    document.querySelector('#brebLabel').textContent = s.brebLabel;
    document.querySelector('#brebValue').textContent = s.brebValue;
    statusBox.textContent = s.closed
      ? `La jornada de hoy (${s.date}) cerró a las 7:00 p. m. No se aceptan registros ni se trasladan participaciones al día siguiente. Vuelve mañana para hacer un nuevo registro y pago. Hora del servidor: ${s.time}.`
      : `Jornada de hoy: ${s.date}. Cierre y verificación de pagos hasta las 7:00 p. m. (hora Colombia). Tu participación solo es válida hoy si el pago queda verificado antes del cierre. Hora del servidor: ${s.time}.`;
    statusBox.className = `notice ${s.closed ? 'warning' : 'success'}`;
  } catch {
    statusBox.textContent = 'No fue posible consultar el estado del servicio. Intenta de nuevo.';
  }
}
function nextDay(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d+1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
document.querySelector('#copyKey').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(paymentKey);
    document.querySelector('#copyKey').textContent = 'Copiada';
  } catch {
    alert(`Copia manualmente la llave: ${paymentKey}`);
  }
});
form.querySelector('[name="number"]').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0,5);
});
form.querySelector('[name="phone"]').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0,10);
});
form.querySelector('[name="receipt"]').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f && f.size > 5 * 1024 * 1024) {
    e.target.value = '';
    message.textContent = 'El archivo supera el máximo de 5 MB.';
    message.className = 'notice error';
  }
});
form.addEventListener('submit', async e => {
  e.preventDefault();
  message.textContent = 'Enviando…';
  message.className = 'notice';
  submitBtn.disabled = true;
  try {
    const data = new FormData(form);
    const res = await fetch('/api/register', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'No se pudo registrar.');
    message.textContent = `${result.message} Código de registro: ${result.id}`;
    message.className = 'notice success';
    form.reset();
    await loadStatus();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'notice error';
  } finally {
    submitBtn.disabled = false;
  }
});
loadStatus();
