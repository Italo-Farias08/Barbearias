// ============================================================
// saas.js — Carrega os dados da barbearia e aplica na página
// ============================================================
// COMO FUNCIONA:
//   1. Lê o slug da URL  →  seusite.com/?b=goldline  →  slug = "goldline"
//   2. Busca as configs no servidor:  GET /api/goldline/config
//   3. Substitui o texto de todos os elementos com data-barber="..."
//   4. Aplica a cor da barbearia no CSS
//   5. Disponibiliza a variável global  API  pros outros scripts
//
// COMO USAR NOS HTMLS:
//   Qualquer texto que muda por barbearia, adicione data-barber="chave":
//
//   <span data-barber="nome">GOLD LINE</span>       ← nome da barbearia
//   <span data-barber="cidade">· Pernambuco</span>  ← cidade
//   <span data-barber="horario">Seg-Sáb 9h às 20h</span>
//   <span data-barber="whatsapp">(81) 9...</span>
//   <p data-barber="sobre">Texto da seção sobre...</p>
//
// COMO CRIAR LINK PRA NOVA BARBEARIA:
//   Não precisa de nenhum arquivo novo! Só faça um INSERT no banco:
//
//   INSERT INTO barbearias (slug, nome, username, password, telefone, whatsapp, cidade, cor_primaria)
//   VALUES ('joao', 'Barbearia do João', 'joao', 'senha123', '5581999999999', '5581999999999', 'Recife — PE', '#e63946');
//
//   Aí o link do João fica:  seusite.com/?b=joao
//   Ele vê os dados dele, cor dele, agendamentos dele.
//   Você não toca em nenhum arquivo HTML.
// ============================================================

const BASE_URL =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:3000'
    : 'https://barber-7p3h.onrender.com';

// Lê o slug da URL — aceita ?b=goldline ou /goldline/pagina.html
function lerSlug() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('b')) return params.get('b');

  const partes = window.location.pathname.split('/').filter(Boolean);
  if (partes.length > 0 && !partes[0].includes('.')) return partes[0];

  return 'goldline'; // fallback padrão
}

const BARBER_SLUG = lerSlug();

// API global — usada em TODOS os outros scripts da página
// Ex: fetch(`${API}/agendamentos/data/2026-04-21`)
const API = `${BASE_URL}/api/${BARBER_SLUG}`;

// Busca as configs e aplica na página
async function aplicarConfig() {
  try {
    const res    = await fetch(`${API}/config`);
    const config = await res.json();

    if (!config || !config.nome) return;

    // Aplica a cor primária da barbearia no CSS inteiro
    const cor = config.cor_primaria || '#c9a84c';
    document.documentElement.style.setProperty('--gold',  cor);
    document.documentElement.style.setProperty('--gold2', cor);

    // Título da aba do navegador
    document.title = config.nome;

    // Substitui todos os elementos marcados com data-barber="..."
    const substituir = {
      nome:    config.nome,
      cidade:  config.cidade ? '· ' + config.cidade : '',
      horario: config.horario_func || 'Seg a Sáb · 9h às 20h',
      whatsapp:config.whatsapp || '',
      sobre:   config.sobre || ''
    };

    Object.entries(substituir).forEach(([chave, valor]) => {
      if (!valor) return;
      document.querySelectorAll(`[data-barber="${chave}"]`).forEach(el => {
        el.textContent = valor;
      });
    });

    // Logo com imagem (opcional — se a barbearia tiver logo_url no banco)
    if (config.logo_url) {
      document.querySelectorAll('[data-barber="logo"]').forEach(el => {
        el.innerHTML = `<img src="${config.logo_url}" alt="${config.nome}" style="height:36px;object-fit:contain;">`;
      });
    }

    // Salva no localStorage pra outros scripts usarem
    localStorage.setItem('barber_slug', BARBER_SLUG);
    localStorage.setItem('barber_nome', config.nome);
    localStorage.setItem('barber_wa',   config.whatsapp || '');
    localStorage.setItem('barber_cor',  cor);

  } catch (err) {
    // Se der erro (ex: servidor offline), mantém os textos padrão do HTML
    console.warn('saas.js: config não carregada.', err.message);
  }
}

// Roda quando o DOM estiver pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', aplicarConfig);
} else {
  aplicarConfig();
}
function aplicarSlugNosLinks() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('b');

  if (!slug) return;

  document.querySelectorAll('a').forEach(link => {
    const href = link.getAttribute('href');

    if (!href || href.startsWith('http') || href.includes('?')) return;

    link.setAttribute('href', `${href}?b=${slug}`);
  });
}

aplicarSlugNosLinks();