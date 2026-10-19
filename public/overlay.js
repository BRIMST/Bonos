/* Tarjeta con QR y enlace corto para mostrar en el live (fuente de navegador de OBS, o pantalla compartida). */
(() => {
  const P = { home: ['', 'Entra a'], quinta: ['q', 'Bono de la Quinta'], ruleta: ['r', 'Ruleta de Seguidores'], donar: ['d', 'Donaciones de la comunidad'] };
  const q = new URLSearchParams(location.search), to = P[q.get('to')] ? q.get('to') : 'home';
  document.querySelector('#qr').src = `/api/qr.png?to=${to}`;
  document.querySelector('#kicker').textContent = P[to][1];
  document.querySelector('#link').textContent = `${location.host}/${P[to][0]}`.replace(/\/$/, '');
  if (q.get('size')) document.documentElement.style.setProperty('--ov', Math.min(Math.max(Number(q.get('size')) || 1, 0.5), 3));
})();
