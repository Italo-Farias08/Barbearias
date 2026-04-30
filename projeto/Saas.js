// ================================
// ANTI-FOUC — esconde imediatamente
// ================================
document.documentElement.style.visibility = 'hidden';

const timeoutSeguranca = setTimeout(() => {
  document.documentElement.style.visibility = 'visible';
}, 3000);

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
    const res    = await fetch(`${API}/config`);
    const config = await res.json();

    console.log('CONFIG RECEBIDA:', config);

    if (!config || !config.nome) return;

    // Cor primária
    const cor = config.cor_primaria || '#c9a84c';
    document.documentElement.style.setProperty('--gold', cor);
    document.documentElement.style.setProperty('--gold2', cor);

    // Título da aba
    document.title = config.nome;
    // Salva o WhatsApp da barbearia no localStorage para uso nas outras páginas
if(config.whatsapp){
  localStorage.setItem(`barber_wa_${BARBER_SLUG}`, config.whatsapp.replace(/\D/g,''));
}

    // Campos de texto simples
    const dados = {
      nome:     config.nome,
      cidade:   config.cidade    ? '· ' + config.cidade : '',
      horario:  config.horario_func || 'Seg a Sáb · 9h às 20h',
      whatsapp: config.whatsapp  || '',
      sobre:    config.sobre     || ''
    };

    Object.entries(dados).forEach(([chave, valor]) => {
      if (!valor) return;
      document.querySelectorAll(`[data-barber="${chave}"]`).forEach(el => {
        el.textContent = valor;
      });
    });

    // ================================
    // LOGO — imagem ou nome como fallback
    // ================================
    document.querySelectorAll('[data-barber="logo"]').forEach(el => {
      el.innerHTML = ''; // limpa

      if (config.logo_url) {
        // Tem logo: mostra a imagem; se falhar, cai pro nome
        const img = document.createElement('img');
        img.src   = config.logo_url;
        img.alt   = config.nome;
        img.style.cssText = 'height:85px;width:auto;object-fit:contain;display:block;';
        img.onerror = () => {
          // Imagem quebrou — renderiza o nome no lugar
          el.innerHTML = _logoTexto(config.nome);
        };
        el.appendChild(img);
      } else {
        // Sem logo: usa o nome da barbearia estilizado
        el.innerHTML = _logoTexto(config.nome);
      }
    });

  } catch (err) {
    console.error('Erro ao carregar config:', err);
  } finally {
    clearTimeout(timeoutSeguranca);
    document.documentElement.style.visibility = 'visible';
  }
}

// Helper: markup do nome como logo textual
function _logoTexto(nome) {
  return `<span style="
    font-family:'Playfair Display',serif;
    font-weight:900;
    font-size:20px;
    letter-spacing:.18em;
    color:var(--gold);
    line-height:1;
  ">${nome}</span>`;
}

// ================================
// APLICAR SLUG NOS LINKS
// ================================
function aplicarSlugNosLinks() {
  const slug = getSlug();
  if (!slug) return;

  document.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href');

    if (
      !href ||
      href.startsWith('http') ||
      href.startsWith('//') ||
      href.startsWith('#') ||
      href.startsWith('javascript')
    ) return;

    const [pathPart, hashPart] = href.split('#');
    const url = new URL(pathPart, window.location.href);
    url.searchParams.set('b', slug);

    link.setAttribute('href', url.pathname + url.search + (hashPart ? '#' + hashPart : ''));
  });
}

// ================================
// INIT
// ================================
window.addEventListener('load', () => {
  aplicarConfig();
  aplicarSlugNosLinks();
});