// ================================
// CONFIG BASE
// ================================
const BASE_URL =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:3000'
    : 'https://barbearias-muti-tenant.onrender.com';

// ================================
// SLUG
// ================================
function getSlug() {
  const params = new URLSearchParams(window.location.search);
  return params.get('b') || 'goldline';
}

const BARBER_SLUG = getSlug();
const API = `${BASE_URL}/api/${BARBER_SLUG}`;

// ================================
// CONFIG DA BARBEARIA
// ================================
async function aplicarConfig() {
  try {
    const res = await fetch(`${API}/config`);
    const config = await res.json();

    if (!config || !config.nome) return;

    const cor = config.cor_primaria || '#c9a84c';
    document.documentElement.style.setProperty('--gold', cor);
    document.documentElement.style.setProperty('--gold2', cor);
    document.title = config.nome;

    const dados = {
      nome: config.nome,
      cidade: config.cidade ? '· ' + config.cidade : '',
      horario: config.horario_func || 'Seg a Sáb · 9h às 20h',
      whatsapp: config.whatsapp || '',
      sobre: config.sobre || ''
    };

    Object.entries(dados).forEach(([chave, valor]) => {
      if (!valor) return;
      document.querySelectorAll(`[data-barber="${chave}"]`).forEach(el => {
        el.textContent = valor;
      });
    });

    if (config.logo_url) {
      document.querySelectorAll('[data-barber="logo"]').forEach(el => {
        el.innerHTML = `<img src="${config.logo_url}" style="height:36px;">`;
      });
    }

  } catch (err) {
    console.error('Erro ao carregar config:', err);
  }
}

// ================================
// APLICAR SLUG NOS LINKS — CORRIGIDO
// ================================
function aplicarSlugNosLinks() {
  const slug = getSlug();
  if (!slug) return;

  document.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href');

    // Ignora: vazio, externo, âncora pura (#secao), javascript:
    if (
      !href ||
      href.startsWith('http') ||
      href.startsWith('//') ||
      href.startsWith('#') ||       // <-- âncora pura: deixa quieto
      href.startsWith('javascript')
    ) return;

    // Para links que já têm âncora junto com path (ex: "outro.html#secao")
    const [pathPart, hashPart] = href.split('#');

    // Monta a URL só com o path (sem o hash)
    const url = new URL(pathPart, window.location.href);

    // Garante que o slug está lá
    url.searchParams.set('b', slug);

    // Reconstrói com o hash, se existia
    const novoHref = url.pathname + url.search + (hashPart ? '#' + hashPart : '');

    link.setAttribute('href', novoHref);
  });
}

window.addEventListener('load', () => {
  console.log('URL FINAL:', window.location.href);
  aplicarConfig();
  aplicarSlugNosLinks();
});