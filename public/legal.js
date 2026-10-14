// Completa el nombre y el contacto del responsable con el perfil publicado en el panel.
(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    if (!s.profile) return;
    document.querySelector('#owner').textContent = s.profile.name;
    if (s.profile.links.length) document.querySelector('#contact').textContent = 'Contacto: ' + s.profile.links.map(l => l.label).join(', ') + ' (ver «Quiénes somos» en el inicio).';
  } catch { /* se deja el texto genérico */ }
})();
