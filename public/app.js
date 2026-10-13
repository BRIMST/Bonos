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
const MAX_BYTES = 780 * 1024;
let receiptFile = null;
// Las imágenes se reducen en el navegador para caber en el límite de Firestore (~1 MB por documento).
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) return new File([blob], 'comprobante.jpg', { type: 'image/jpeg' });
    }
    scale *= 0.75;
  }
  throw new Error('No se pudo reducir la imagen. Usa una captura de pantalla más liviana.');
}
form.querySelector('[name="receipt"]').addEventListener('change', async e => {
  const f = e.target.files[0];
  receiptFile = null;
  if (!f) return;
  try {
    if (f.type === 'application/pdf') {
      if (f.size > MAX_BYTES) throw new Error('El PDF supera 780 KB. Envía una captura de pantalla (JPG/PNG) del comprobante.');
      receiptFile = f;
    } else if (f.type === 'image/jpeg' || f.type === 'image/png') {
      receiptFile = f.size > MAX_BYTES ? await shrinkImage(f) : f;
    } else throw new Error('Solo se permiten JPG, PNG o PDF.');
    message.textContent = ''; message.className = 'notice';
  } catch (err) {
    e.target.value = '';
    message.textContent = err.message;
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
    if (receiptFile) data.set('receipt', receiptFile, receiptFile.name);
    const res = await fetch('/api/register', { method: 'POST', body: data });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'No se pudo registrar.');
    message.textContent = `${result.message} Código de registro: ${result.id}`;
    message.className = 'notice success';
    form.reset();
    receiptFile = null;
    await loadStatus();
  } catch (err) {
    message.textContent = err.message;
    message.className = 'notice error';
  } finally {
    submitBtn.disabled = false;
  }
});
loadStatus();
