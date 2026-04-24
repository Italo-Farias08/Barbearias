// barber-config.js
// ─────────────────────────────────────────────────────────
// CADA BARBEARIA tem sua própria cópia deste arquivo.
// Só mude o SLUG abaixo para o slug da barbearia no banco.
//
// Exemplo:
//   Italo Barber  → slug: "italo"
//   Barbearia João → slug: "joao"
//
// Este arquivo é importado por todos os outros JS da barbearia.
// ─────────────────────────────────────────────────────────
 
const BARBER_SLUG = "italo"; // ← altere aqui para cada barbearia
 
const BASE_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:3000"
    : "https://barber-7p3h.onrender.com";
 
// Monta a URL da API com o slug: /api/italo/agendar etc.
const API = `${BASE_URL}/api/${BARBER_SLUG}`;
 
// Exporta para uso nos outros scripts
// (se usar módulos ES6: export { API, BARBER_SLUG })
// Aqui funciona como variável global acessada pelos outros scripts