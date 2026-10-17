(() => {
  const nav = document.querySelector('#modes'); if (!nav) return;
  const here = location.pathname.startsWith('/ruleta') ? 'ruleta' : location.pathname.startsWith('/quinta') ? 'quinta' : '';
  const LABEL = { en_curso: 'En curso', finalizado: 'Finalizado', cancelado: 'Cancelado', sin_evento: 'Sin evento' };
  nav.querySelectorAll('a').forEach(a => { if (a.dataset.mode === here) a.setAttribute('aria-current', 'page'); });
  async function refresh() {
    try {
      const res = await fetch('/api/modes'); if (!res.ok) return;
      const m = await res.json();
      nav.querySelectorAll('a').forEach(a => {
        const st = m[a.dataset.mode], span = a.querySelector('.mode-state');
        span.textContent = LABEL[st] || ''; span.className = `mode-state ${st || ''}`;
      });
    } catch { /* se reintenta */ }
  }
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 30000);
})();
