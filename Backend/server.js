// server.js — Multi-tenant PostgreSQL + WhatsApp via Baileys
const crypto = require("crypto");
globalThis.crypto = crypto.webcrypto;
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");
const fs      = require("fs");
const path    = require("path");

const app = express();

app.set('trust proxy', 1);

// ── CORS PRIMEIRO DE TUDO ──────────────────────────────────────────────
const ORIGENS_PERMITIDAS = [
  "https://vtrip.com.br",
  "http://vtrip.com.br",
  "https://barbearias-flax.vercel.app",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS bloqueado para: " + origin));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "10kb" }));

const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");

app.use(helmet({ contentSecurityPolicy: false }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas requisições. Tente novamente em 1 minuto." }
}));

const limiterLogin = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { erro: "Muitas tentativas de login. Aguarde 1 minuto." }
});

// ── UTILITÁRIOS DE FUSO HORÁRIO (Brasília = UTC-3) ────────────────────────
function agoraBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function hojePartesBrasilia() {
  const d = agoraBrasilia();
  return {
    ano:      d.getUTCFullYear(),
    mes:      d.getUTCMonth(),
    dia:      d.getUTCDate(),
    diaSemana: d.getUTCDay()
  };
}

function ehHojeBrasilia(dataObj) {
  const h = hojePartesBrasilia();
  return (
    dataObj.getFullYear() === h.ano &&
    dataObj.getMonth()    === h.mes &&
    dataObj.getDate()     === h.dia
  );
}

// ── WHATSAPP MULTI-TENANT ─────────────────────────────────────────────────
const waSessoes = {};

async function iniciarWhatsAppSlug(slug) {
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return;
  if (waSessoes[slug]?.status === "conectado") return;

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = require("@whiskeysockets/baileys");

    const qrcode = require("qrcode");
    const pino   = require("pino");

    const AUTH_DIR = `./auth_wa/${slug}`;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sessao = {
      socket:    null,
      conectado: false,
      qrBase64:  null,
      status:    "aguardando_qr",
    };
    waSessoes[slug] = sessao;

    const sock = makeWASocket({
      version,
      auth:              state,
      printQRInTerminal: false,
      logger:            pino({ level: "silent" }),
    });

    sessao.socket = sock;

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        sessao.qrBase64 = await qrcode.toDataURL(qr);
        sessao.status   = "aguardando_qr";
        console.log(`📱 QR gerado para: ${slug}`);
      }
      if (connection === "open") {
        sessao.conectado = true;
        sessao.status    = "conectado";
        sessao.qrBase64  = null;
        console.log(`✅ WhatsApp conectado: ${slug}`);
      }
      if (connection === "close") {
        sessao.conectado = false;
        const codigo         = lastDisconnect?.error?.output?.statusCode;
        const deveReconectar = codigo !== DisconnectReason.loggedOut;
        console.log(`⚠️  WhatsApp desconectado (${slug}). Código: ${codigo}`);
        if (deveReconectar) {
          sessao.status = "aguardando_qr";
          setTimeout(() => iniciarWhatsAppSlug(slug), 5000);
        } else {
          sessao.status   = "desconectado";
          sessao.qrBase64 = null;
          const AUTH_DIR2 = `./auth_wa/${slug}`;
          if (fs.existsSync(AUTH_DIR2)) fs.rmSync(AUTH_DIR2, { recursive: true, force: true });
          console.log(`❌ Sessão encerrada (${slug}). Auth limpa.`);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe)                           continue;
        if (msg.key.remoteJid?.endsWith("@g.us"))    continue;
        if (msg.key.remoteJid === "status@broadcast") continue;

        const jid  = msg.key.remoteJid;

        // captura clique em lista (listResponseMessage) ou texto normal
        const listReply = msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId;

        const body = (
          listReply ||
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          ""
        ).trim().toLowerCase();

        if (!body) continue;

        try {
          await processarMensagemBot(sock, jid, body, slug);
        } catch (err) {
          console.error(`Erro no bot (${slug}):`, err.message);
        }
      }
    });

  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      console.log("ℹ️  Dependência faltando — rode: npm i @whiskeysockets/baileys qrcode pino");
    } else {
      console.error(`Erro ao iniciar WA (${slug}):`, err.message);
      setTimeout(() => iniciarWhatsAppSlug(slug), 10000);
    }
  }
}

// ── ESTADO DO BOT POR USUÁRIO ─────────────────────────────────────────────
const botEstados = {};

function getEstado(slug, jid) {
  if (!botEstados[slug])      botEstados[slug] = {};
  if (!botEstados[slug][jid]) botEstados[slug][jid] = { etapa: "inicio", ultimo: 0 };
  return botEstados[slug][jid];
}

function resetarEstado(slug, jid) {
  const e = botEstados[slug][jid];
  e.etapa  = "inicio";
  e.ultimo = 0;
  Object.keys(e).forEach(k => {
    if (k !== "etapa" && k !== "ultimo") delete e[k];
  });
}

setInterval(() => {
  const agora = Date.now();
  for (const slug in botEstados) {
    for (const jid in botEstados[slug]) {
      const estado = botEstados[slug][jid];
      if (agora - estado.ultimo > 30 * 60 * 1000) resetarEstado(slug, jid);
    }
  }
}, 10 * 60 * 1000);

// ── BUSCAR DADOS DA BARBEARIA ─────────────────────────────────────────────
async function getDadosBarbearia(slug) {
  const r = await db.query(
    `SELECT nome, cidade, whatsapp, horario_func, pix_chave, sobre, cor_primaria
     FROM barbearias WHERE slug = $1`,
    [slug]
  );
  return r.rows[0] || {};
}

// ── HELPER: config de horários (individual ou global) ─────────────────────
async function getHorariosConfig(slug, profissional_id) {
  const hrProf = await db.query(
    `SELECT ph.dias_semana, ph.pausa_inicio, ph.pausa_fim,
            hb.intervalo_minutos
     FROM profissional_horarios ph
     JOIN barbearias b ON b.id = ph.barbearia_id
     LEFT JOIN horarios_barbearia hb ON hb.barbearia_id = ph.barbearia_id
     WHERE ph.profissional_id = $1 AND b.slug = $2`,
    [profissional_id, slug]
  );
  if (hrProf.rows.length > 0) return hrProf.rows[0];

  const hrGlobal = await db.query(
    `SELECT dias_semana, hora_inicio, hora_fim, intervalo_minutos, pausa_inicio, pausa_fim
     FROM horarios_barbearia
     WHERE barbearia_id = (SELECT id FROM barbearias WHERE slug = $1)`,
    [slug]
  );
  return hrGlobal.rows[0] || null;
}

// ── HELPERS DE LINGUAGEM NATURAL ──────────────────────────────────────────
function normalizar(str) {
  return str
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function matchItem(body, lista, campoNome) {
  const n   = normalizar(body);
  const idx = parseInt(body) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < lista.length) return lista[idx];

  const exato = lista.find(i => normalizar(i[campoNome]) === n);
  if (exato) return exato;

  const parcial = lista.find(i => {
    const nome = normalizar(i[campoNome]);
    return nome.includes(n) || n.includes(nome.split(" ")[0]);
  });
  return parcial || null;
}

// helper específico para casar o horário digitado (lista de strings "HH:MM")
function matchHorario(body, lista) {
  const idx = parseInt(body) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < lista.length) return lista[idx];

  const bruto = body.trim();
  if (lista.includes(bruto)) return bruto;

  const soDigitos = bruto.replace(/\D/g, "");
  if (!soDigitos) return null;

  // "14:00" digitado como "1400" ou "14.00"
  const comDoisPontos = soDigitos.length >= 3
    ? `${soDigitos.slice(0, -2).padStart(2, "0")}:${soDigitos.slice(-2)}`
    : null;
  if (comDoisPontos && lista.includes(comDoisPontos)) return comDoisPontos;

  // só a hora, tipo "14" ou "14h" — casa se houver exatamente 1 horário nessa hora
  const horaAlvo = soDigitos.padStart(2, "0").slice(0, 2);
  const porHora   = lista.filter(h => h.split(":")[0] === horaAlvo);
  if (porHora.length === 1) return porHora[0];

  return null;
}

// ── HELPER: ENVIAR LISTA DE OPÇÕES (TEXTO NUMERADO) ───────────────────────
async function enviarLista(sock, jid, texto, tituloBotao, tituloSecao, linhas) {
  // linhas = [{ title, description }]
  const opcoesTxt = linhas
    .map((l, i) => `*${i + 1}.* ${l.title}${l.description ? ` — ${l.description}` : ""}`)
    .join("\n");

  const textoFinal = `${texto}\n\n${opcoesTxt}\n\n_Digite o número ou o nome da opção_`;

  try {
    await sock.sendMessage(jid, { text: textoFinal });
    console.log(`[LISTA ENVIADA] para ${jid}`);
  } catch (err) {
    console.error(`[ERRO ENVIO LISTA]`, err.message);
  }
}

// ── PROCESSADOR PRINCIPAL DO BOT ──────────────────────────────────────────
async function processarMensagemBot(sock, jid, body, slug) {
  const estado = getEstado(slug, jid);
  const agora  = Date.now();

  console.log(`[BOT] body="${body}" etapa="${estado.etapa}" diff=${agora - estado.ultimo}ms`);

  if (agora - estado.ultimo < 500) {
    console.log(`[DEBOUNCE] bloqueado`);
    return;
  }
  estado.ultimo = agora;

  const enviar = async (texto) => {
    try {
      await sock.sendMessage(jid, { text: texto });
      console.log(`[ENVIADO] para ${jid}`);
    } catch (err) {
      console.error(`[ERRO ENVIO]`, err.message);
    }
  };

  const saudacoes  = ["oi","olá","ola","hello","bom dia","boa tarde","boa noite","menu","inicio","início","ajuda","help"];
  const bodyNorm   = normalizar(body);
  const ehSaudacao = saudacoes.some(s => bodyNorm === normalizar(s) || bodyNorm.startsWith(normalizar(s) + " "));
  const ehCancelar = ["cancelar","sair","0","voltar"].includes(bodyNorm);

  if (ehCancelar) {
    resetarEstado(slug, jid);
    await enviar(`Tudo certo! Quando quiser agendar é só mandar um "oi" 😊`);
    return;
  }

  // ── INICIO ────────────────────────────────────────────────────────────
  if (estado.etapa === "inicio") {
    estado.etapa = "aguardando_nome";
    const barb = await getDadosBarbearia(slug);
    await enviar(
      `✂️ *${barb.nome || "Barbearia"}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Olá! Seja bem-vindo(a)! 👋\n\n` +
      `Vou te ajudar a fazer seu agendamento.\n\n` +
      `Qual é o seu *nome*?`
    );
    return;
  }

  // ── SAUDAÇÃO EM QUALQUER ETAPA ────────────────────────────────────────
  if (ehSaudacao && estado.etapa !== "aguardando_nome") {
    resetarEstado(slug, jid);
    estado.etapa = "aguardando_nome";
    const barb = await getDadosBarbearia(slug);
    await enviar(
      `✂️ *${barb.nome || "Barbearia"}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Olá! Seja bem-vindo(a)! 👋\n\n` +
      `Vou te ajudar a fazer seu agendamento.\n\n` +
      `Qual é o seu *nome*?`
    );
    return;
  }

  // ── NOME ──────────────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_nome") {
    if (body.trim().length < 2) {
      await enviar(`Me diz seu nome pra eu te chamar direitinho 😊`);
      return;
    }
    estado.nome  = body.trim().split(" ").map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
    estado.etapa = "aguardando_profissional";

    const profs = await db.query(
      `SELECT id, nome, especialidade FROM profissionais
       WHERE barbearia_id = (SELECT id FROM barbearias WHERE slug = $1)
         AND ativo = true AND disponivel = true
       ORDER BY ordem`,
      [slug]
    );

    if (profs.rows.length === 0) {
      await enviar(`Olá, *${estado.nome}*! 😊\n\nNenhum profissional disponível agora. Tenta de novo mais tarde!`);
      resetarEstado(slug, jid);
      return;
    }

    estado._profissionais = profs.rows;

    await enviarLista(
      sock, jid,
      `Prazer, *${estado.nome}*! 😊\n\nCom qual barbeiro você quer ser atendido?`,
      "Ver profissionais",
      "Profissionais disponíveis",
      profs.rows.map(p => ({ title: p.nome, description: p.especialidade || "" }))
    );
    return;
  }

  // ── PROFISSIONAL ──────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_profissional") {
    const lista = estado._profissionais || [];

    const escolhido = matchItem(body, lista, "nome");

    if (!escolhido) {
      await enviarLista(
        sock, jid,
        `Não entendi 😅 Digite o número ou o nome do profissional:`,
        "Ver profissionais",
        "Profissionais disponíveis",
        lista.map(p => ({ title: p.nome, description: p.especialidade || "" }))
      );
      return;
    }

    estado.profissional_id   = escolhido.id;
    estado.profissional_nome = escolhido.nome;
    estado.etapa             = "aguardando_servico";

    const servs = await db.query(
      `SELECT id, nome, preco FROM servicos
       WHERE barbearia_id = (SELECT id FROM barbearias WHERE slug = $1)
       ORDER BY id`,
      [slug]
    );

    if (servs.rows.length === 0) {
      await enviar(`Nenhum serviço cadastrado no momento. Entre em contato com a barbearia.`);
      resetarEstado(slug, jid);
      return;
    }

    estado._servicos = servs.rows;

    await enviarLista(
      sock, jid,
      `Ótimo! Você escolheu *${estado.profissional_nome}* ✅\n\nAgora escolha o serviço:`,
      "Ver serviços",
      "Serviços disponíveis",
      servs.rows.map(s => ({
        title: s.nome,
        description: Number(s.preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      }))
    );
    return;
  }

  // ── SERVIÇO ───────────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_servico") {
    const lista = estado._servicos || [];

    const escolhido = matchItem(body, lista, "nome");

    if (!escolhido) {
      await enviarLista(
        sock, jid,
        `Não entendi 😅 Digite o número ou o nome do serviço:`,
        "Ver serviços",
        "Serviços disponíveis",
        lista.map(s => ({
          title: s.nome,
          description: Number(s.preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
        }))
      );
      return;
    }

    estado.servico       = escolhido.nome;
    estado.servico_preco = escolhido.preco;
    estado.etapa         = "aguardando_dia";

    const hrConfig = await getHorariosConfig(slug, estado.profissional_id);
    const DIAS_NOMES = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
    const { ano: anoHoje, mes: mesHoje, dia: diaHoje } = hojePartesBrasilia();
    const diasDisponiveis = [];

    for (let i = 0; i <= 13; i++) {
      const d         = new Date(anoHoje, mesHoje, diaHoje + i);
      const diaSemana = d.getDay();

      if (hrConfig) {
        const diasJSON = typeof hrConfig.dias_semana === "string"
          ? JSON.parse(hrConfig.dias_semana)
          : (hrConfig.dias_semana || {});
        const cfg = diasJSON[String(diaSemana)];
        if (!cfg || !cfg.aberto) continue;
      }

      const dataISO = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      const pausaCheck = await db.query(
        `SELECT id FROM profissional_pausas
         WHERE profissional_id = $1
           AND barbearia_id = (SELECT id FROM barbearias WHERE slug = $2)
           AND $3 BETWEEN data_inicio AND data_fim`,
        [estado.profissional_id, slug, dataISO]
      );
      if (pausaCheck.rows.length > 0) continue;

      const dd   = String(d.getDate()).padStart(2,"0");
      const mm   = String(d.getMonth()+1).padStart(2,"0");
      const aaaa = d.getFullYear();

      const label = i === 0
        ? `Hoje (${DIAS_NOMES[diaSemana]})`
        : i === 1
          ? `Amanhã (${DIAS_NOMES[diaSemana]})`
          : `${DIAS_NOMES[diaSemana]} ${dd}/${mm}`;

      diasDisponiveis.push({
        label,
        dataISO:       `${aaaa}-${mm}-${dd}`,
        dataFormatada: `${dd}/${mm}/${aaaa}`
      });
    }

    if (diasDisponiveis.length === 0) {
      await enviar(`Não há dias disponíveis nos próximos 14 dias 😕 Entre em contato com a barbearia.`);
      resetarEstado(slug, jid);
      return;
    }

    estado._dias = diasDisponiveis;

    await enviarLista(
      sock, jid,
      `Serviço: *${estado.servico}* ✅\n\nEscolha o dia:`,
      "Ver dias",
      "Dias disponíveis",
      diasDisponiveis.map(d => ({ title: d.label, description: d.dataFormatada }))
    );
    return;
  }

  // ── DIA ───────────────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_dia") {
    const lista = estado._dias || [];

    const diaEscolhido = matchItem(body, lista, "label");

    if (!diaEscolhido) {
      await enviarLista(
        sock, jid,
        `Não entendi 😅 Digite o número ou o dia (ex: "hoje", "amanhã", "sexta"):`,
        "Ver dias",
        "Dias disponíveis",
        lista.map(d => ({ title: d.label, description: d.dataFormatada }))
      );
      return;
    }

    estado.data          = diaEscolhido.dataISO;
    estado.dataFormatada = diaEscolhido.dataFormatada;
    estado.etapa         = "aguardando_horario";

    const hrConfig = await getHorariosConfig(slug, estado.profissional_id);
    const [_a, _m, _d] = estado.data.split("-").map(Number);
    const dataObj   = new Date(_a, _m - 1, _d);
    const diaSemana = dataObj.getDay();

    let horaInicio = "08:00", horaFim = "21:00", intervalo = 30;
    let pausaIni = null, pausaFim = null;

    if (hrConfig) {
      const diasJSON = typeof hrConfig.dias_semana === "string"
        ? JSON.parse(hrConfig.dias_semana)
        : (hrConfig.dias_semana || {});
      const cfg = diasJSON[String(diaSemana)];

      horaInicio = (cfg?.hora_inicio || "").substring(0,5)
                || (hrConfig.hora_inicio ? String(hrConfig.hora_inicio).substring(0,5) : "")
                || "08:00";
      horaFim    = (cfg?.hora_fim    || "").substring(0,5)
                || (hrConfig.hora_fim   ? String(hrConfig.hora_fim).substring(0,5) : "")
                || "21:00";
      intervalo  = hrConfig.intervalo_minutos || 30;
      pausaIni   = hrConfig.pausa_inicio || null;
      pausaFim   = hrConfig.pausa_fim    || null;
    }

    const ocupados = await db.query(
      `SELECT TRIM(horario) AS horario FROM agendamentos
       WHERE barbearia_id = (SELECT id FROM barbearias WHERE slug = $1)
         AND data = $2 AND profissional_id = $3 AND status = 'pendente'`,
      [slug, estado.data, estado.profissional_id]
    );
    const ocupadosSet = new Set(ocupados.rows.map(r => r.horario.substring(0,5)));

    const [hIni, mIni] = horaInicio.substring(0,5).split(":").map(Number);
    const [hFim, mFim] = horaFim.substring(0,5).split(":").map(Number);
    const inicioMin    = hIni * 60 + mIni;
    const fimMin       = hFim * 60 + mFim;

    const agoraBr  = agoraBrasilia();
    const ehHoje   = ehHojeBrasilia(dataObj);
    const agoraMin = ehHoje ? agoraBr.getUTCHours() * 60 + agoraBr.getUTCMinutes() + 30 : 0;

    const pausaIniMin = pausaIni ? (() => { const [h,m] = pausaIni.split(":").map(Number); return h*60+m; })() : null;
    const pausaFimMin = pausaFim ? (() => { const [h,m] = pausaFim.split(":").map(Number); return h*60+m; })() : null;

    const horariosLivres = [];
    for (let t = inicioMin; t < fimMin; t += intervalo) {
      if (t < agoraMin) continue;
      if (pausaIniMin !== null && pausaFimMin !== null && t >= pausaIniMin && t < pausaFimMin) continue;
      const hh  = String(Math.floor(t / 60)).padStart(2,"0");
      const mm2 = String(t % 60).padStart(2,"0");
      if (!ocupadosSet.has(`${hh}:${mm2}`)) horariosLivres.push(`${hh}:${mm2}`);
    }

    if (horariosLivres.length === 0) {
      await enviar(`Não há horários disponíveis para *${diaEscolhido.label}* 😕 Quer escolher outro dia? Manda "oi" pra recomeçar.`);
      estado.etapa = "aguardando_dia";
      return;
    }

    estado._horarios = horariosLivres;

    await enviarLista(
      sock, jid,
      `Dia: *${diaEscolhido.label}* ✅\n\nEscolha o horário:`,
      "Ver horários",
      "Horários disponíveis",
      horariosLivres.map(h => ({ title: h }))
    );
    return;
  }

  // ── HORÁRIO ───────────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_horario") {
    const lista = estado._horarios || [];

    const horarioEscolhido = matchHorario(body, lista);

    if (!horarioEscolhido) {
      await enviarLista(
        sock, jid,
        `Não entendi 😅 Digite o número ou o horário (ex: "14:00" ou "14h"):`,
        "Ver horários",
        "Horários disponíveis",
        lista.map(h => ({ title: h }))
      );
      return;
    }

    estado.horario = horarioEscolhido;
    estado.etapa   = "aguardando_confirmacao";

    const preco = Number(estado.servico_preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

    await enviarLista(
      sock, jid,
      `Confere aí o seu agendamento:\n\n` +
      `👤 *Nome:* ${estado.nome}\n` +
      `✂️ *Barbeiro:* ${estado.profissional_nome}\n` +
      `💈 *Serviço:* ${estado.servico} — ${preco}\n` +
      `📅 *Data:* ${estado.dataFormatada}\n` +
      `🕐 *Horário:* ${estado.horario}\n\n` +
      `Digite *confirmar* ou *cancelar*:`,
      "Confirmar / Cancelar",
      "O que você deseja?",
      [
        { title: "✅ Confirmar" },
        { title: "❌ Cancelar" }
      ]
    );
    return;
  }

  // ── CONFIRMAÇÃO ───────────────────────────────────────────────────────
  if (estado.etapa === "aguardando_confirmacao") {
    const confirmar = ["confirmar_sim", "confirmar", "sim", "confirmo", "confirmado", "1", "ok", "certo", "isso", "isso mesmo", "pode confirmar"]
      .some(s => bodyNorm === normalizar(s));
    const recusar   = ["confirmar_nao", "cancelar", "nao", "cancela", "2", "errado", "sair"]
      .some(s => bodyNorm === normalizar(s));

    if (recusar) {
      resetarEstado(slug, jid);
      await enviar(`Tudo bem! Se quiser reagendar é só mandar um "oi" 😊`);
      return;
    }

    if (!confirmar) {
      await enviar(`Não entendi 😅 Digite *confirmar* para agendar ou *cancelar* para desistir.`);
      return;
    }

    try {
      const barbResult = await db.query(`SELECT id FROM barbearias WHERE slug = $1`, [slug]);
      const barbId = barbResult.rows[0]?.id;
      if (!barbId) throw new Error("Barbearia não encontrada");

      const conflito = await db.query(
        `SELECT id FROM agendamentos
         WHERE barbearia_id = $1 AND data = $2 AND horario = $3
           AND profissional_id = $4 AND status = 'pendente'`,
        [barbId, estado.data, estado.horario, estado.profissional_id]
      );

      if (conflito.rows.length > 0) {
        await enviar(`Esse horário acabou de ser reservado por outra pessoa 😅 Manda "oi" pra escolher outro horário.`);
        resetarEstado(slug, jid);
        return;
      }

      const telefone = jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");

      await db.query(
        `INSERT INTO agendamentos (barbearia_id, nome, telefone, data, horario, valor, profissional_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [barbId, estado.nome, telefone, estado.data, estado.horario, Number(estado.servico_preco) || 0, estado.profissional_id]
      );

      await enviar(
        `✅ *Agendamento confirmado!*\n\n` +
        `👤 ${estado.nome}\n` +
        `✂️ ${estado.profissional_nome}\n` +
        `💈 ${estado.servico}\n` +
        `📅 ${estado.dataFormatada} às ${estado.horario}\n\n` +
        `Te esperamos! Qualquer dúvida é só chamar 😊`
      );
      resetarEstado(slug, jid);
    } catch (err) {
      console.error(`Erro ao salvar agendamento bot (${slug}):`, err.message);
      await enviar(`Deu um erro aqui 😕 Tenta de novo ou entra em contato com a gente.`);
      resetarEstado(slug, jid);
    }
    return;
  }

  await enviar(`Não entendi 😅 Manda *"oi"* pra começar o agendamento ou *"cancelar"* pra sair.`);
}

// ── RECONECTAR SESSÕES SALVAS ─────────────────────────────────────────────
async function reconectarSessoesSalvas() {
  const AUTH_ROOT = "./auth_wa";
  if (!fs.existsSync(AUTH_ROOT)) return;
  const slugs = fs.readdirSync(AUTH_ROOT).filter(f =>
    fs.statSync(path.join(AUTH_ROOT, f)).isDirectory()
  );
  for (const slug of slugs) {
    console.log(`🔄 Reconectando sessão salva: ${slug}`);
    iniciarWhatsAppSlug(slug);
    await new Promise(r => setTimeout(r, 1500));
  }
}

reconectarSessoesSalvas();

// ── ENVIO DE LEMBRETE ─────────────────────────────────────────────────────
async function enviarLembrete(ag) {
  const sessao = waSessoes[ag.slug];
  if (!sessao?.conectado || !sessao.socket) {
    console.log(`⚠️  WA offline (${ag.slug}) — lembrete não enviado para ${ag.nome}`);
    return;
  }

  const telefone      = ag.telefone.replace(/\D/g, "");
  const horario       = ag.horario.substring(0, 5);
  const nomeBarbearia = ag.nome_barbearia || "sua barbearia";

  const mensagem =
    `Olá, ${ag.nome}! 💈\n\n` +
    `Lembrando que seu corte na *${nomeBarbearia}* está marcado para hoje às *${horario}*.\n\n` +
    `Te esperamos! ✂️`;

  const jid = `55${telefone}@s.whatsapp.net`;

  try {
    await sessao.socket.sendMessage(jid, { text: mensagem });
    console.log(`✅ Lembrete enviado (${ag.slug}) → ${ag.nome} (${telefone})`);
  } catch (err) {
    console.error(`❌ Erro lembrete (${ag.slug}) → ${ag.nome}:`, err.message);
  }
}

// ── JOB DE LEMBRETES ──────────────────────────────────────────────────────
async function verificarLembretes() {
  try {
    const agora  = agoraBrasilia();
    const result = await db.query(`
      SELECT a.id, a.nome, a.telefone, a.data, a.horario,
             b.nome AS nome_barbearia, b.slug
      FROM agendamentos a
      JOIN barbearias b ON b.id = a.barbearia_id
      WHERE a.status = 'pendente'
        AND a.telefone IS NOT NULL
        AND a.telefone != ''
        AND (a.lembrete_enviado IS NULL OR a.lembrete_enviado = FALSE)
    `);

    for (const ag of result.rows) {
      const dataStr = ag.data instanceof Date
        ? ag.data.toISOString().split("T")[0]
        : ag.data;

      const [ano, mes, dia] = dataStr.split("-");
      const [hora, min]     = ag.horario.substring(0, 5).split(":");
      const dataHorario     = new Date(+ano, +mes - 1, +dia, +hora, +min, 0);

      const agoraMs = agora.getTime() + 3 * 60 * 60 * 1000;
      const diffMin = (dataHorario.getTime() - agoraMs) / 60000;

      if (diffMin >= 55 && diffMin <= 65) {
        await enviarLembrete(ag);
        await db.query(
          `UPDATE agendamentos SET lembrete_enviado = TRUE WHERE id = $1`,
          [ag.id]
        );
      }
    }
  } catch (err) {
    console.error("Erro no job de lembretes:", err.message);
  }
}

setInterval(verificarLembretes, 60 * 1000);
verificarLembretes();

// ── JOB DE CONCLUSÃO AUTOMÁTICA (20 min após o horário) ──────────────────
async function verificarAutoConcluir() {
  try {
    const agora  = agoraBrasilia();
    const result = await db.query(`
      SELECT a.id, a.data, a.horario, b.slug
      FROM agendamentos a
      JOIN barbearias b ON b.id = a.barbearia_id
      WHERE a.status = 'pendente'
        AND a.data IS NOT NULL
        AND a.horario IS NOT NULL
    `);

    for (const ag of result.rows) {
      const dataStr = ag.data instanceof Date
        ? ag.data.toISOString().split("T")[0]
        : String(ag.data).split("T")[0];

      const [ano, mes, dia] = dataStr.split("-").map(Number);
      const [hora, min]     = ag.horario.substring(0, 5).split(":").map(Number);

      const agendamentoMs = Date.UTC(ano, mes - 1, dia, hora + 3, min, 0);
      const agoraMs       = agora.getTime() + 3 * 60 * 60 * 1000;
      const diffMin       = (agoraMs - agendamentoMs) / 60000;

      // Conclui entre 20 e 80 min após o horário marcado
      if (diffMin >= 20 && diffMin <= 80) {
        await db.query(
          `UPDATE agendamentos
           SET status = 'concluido', auto_concluido = true
           WHERE id = $1 AND status = 'pendente'`,
          [ag.id]
        );
        console.log(`✅ Auto-concluído: #${ag.id} (${ag.slug}) — ${dataStr} ${ag.horario}`);
      }
    }
  } catch (err) {
    console.error("Erro no job de auto-conclusão:", err.message);
  }
}

setInterval(verificarAutoConcluir, 60 * 1000);
verificarAutoConcluir();

// ── ROTAS WHATSAPP GLOBAIS ────────────────────────────────────────────────
app.get("/whatsapp-status", (req, res) => {
  const algumConectado = Object.values(waSessoes).some(s => s.conectado);
  res.json({ conectado: algumConectado });
});

app.get("/teste", (req, res) => res.json({ ok: true, modo: "multi-tenant" }));

// ── HELPERS ───────────────────────────────────────────────────────────────
function slugValido(slug) {
  return /^[a-z0-9-]+$/.test(slug);
}

async function podeUsarSistema(slug) {
  const result = await db.query(
    "SELECT ativo, vencimento FROM barbearias WHERE slug = $1",
    [slug]
  );
  const barb = result.rows[0];
  if (!barb || !barb.vencimento) return false;
  const hoje       = new Date();
  const vencimento = new Date(barb.vencimento);
  return barb.ativo && hoje <= vencimento;
}

async function gerarSlug(nome) {
  const base = nome
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40);

  let slug = base, tentativa = 0;
  while (true) {
    const exists = await db.query("SELECT id FROM barbearias WHERE slug = $1", [slug]);
    if (exists.rows.length === 0) return slug;
    tentativa++;
    slug = `${base}-${tentativa}`;
  }
}

// ── MIDDLEWARES ───────────────────────────────────────────────────────────
async function resolveBarbearia(req, res, next) {
  const { slug } = req.params;
  if (!slugValido(slug)) return res.status(400).json({ erro: "Slug inválido" });
  try {
    const result = await db.query(
      `SELECT id, nome, slug, telefone FROM barbearias WHERE slug = $1`,
      [slug]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ erro: "Barbearia não encontrada" });
    req.barbearia = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro interno" });
  }
}

async function verificarAssinatura(req, res, next) {
  const permitido = await podeUsarSistema(req.params.slug);
  if (!permitido) return res.status(403).json({ erro: "Assinatura vencida" });
  next();
}

app.use("/api/:slug", resolveBarbearia);

// ── CONFIG PÚBLICA ────────────────────────────────────────────────────────
app.get("/api/:slug/config", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT slug, nome, cidade, horario_func, whatsapp,
              pix_chave, cor_primaria, logo_url, sobre
       FROM barbearias WHERE slug = $1`,
      [req.params.slug]
    );
    res.json(result.rows[0] || {});
  } catch (err) { console.error(err); res.json({}); }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────
app.post("/api/:slug/login", limiterLogin, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || typeof username !== "string" || typeof password !== "string")
    return res.status(400).json({ erro: "Dados inválidos" });
  if (username.length > 50 || password.length > 100)
    return res.status(400).json({ erro: "Dados inválidos" });

  try {
    const result = await db.query(
      `SELECT id, username, password, slug FROM barbearias
       WHERE slug = $1 AND username = $2`,
      [req.params.slug, username.trim()]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ erro: "Usuário ou senha inválidos" });

    const user = result.rows[0];
    if (password !== user.password)
      return res.status(401).json({ erro: "Usuário ou senha inválidos" });

    res.json({ token: `token_${user.slug}_${Date.now()}`, slug: user.slug });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro no login" }); }
});

// ── AGENDAR ───────────────────────────────────────────────────────────────
function validarAgendamento({ nome, data, horario, valor }) {
  if (!nome || typeof nome !== "string" || nome.trim().length < 2) return "Nome inválido";
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida";
  if (!horario || !/^\d{2}:\d{2}(:\d{2})?$/.test(horario)) return "Horário inválido";

  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m]          = horario.split(":").map(Number);
  const agendamentoMs   = Date.UTC(ano, mes - 1, dia, h + 3, m, 0);
  const agoraBrMs       = Date.now() - 2 * 60 * 1000;

  if (agendamentoMs <= agoraBrMs) return "Não é possível agendar em horário passado";
  if (valor !== undefined && (isNaN(Number(valor)) || Number(valor) < 0)) return "Valor inválido";
  return null;
}

app.post("/api/:slug/agendar", verificarAssinatura, async (req, res) => {
  const { nome, telefone, data, horario, valor, profissional_id } = req.body;
  const erro = validarAgendamento({ nome, data, horario, valor });
  if (erro) return res.status(400).json({ erro });

  const barbearia_id = req.barbearia.id;
  const horarioLimpo = horario.substring(0, 5);
  const profId       = profissional_id ? Number(profissional_id) : null;

  try {
    const horariosCfg = await db.query(
      `SELECT pausa_inicio, pausa_fim FROM horarios_barbearia WHERE barbearia_id = $1`,
      [barbearia_id]
    );
    if (horariosCfg.rows.length > 0) {
      const { pausa_inicio, pausa_fim } = horariosCfg.rows[0];
      if (pausa_inicio && pausa_fim && horarioLimpo >= pausa_inicio && horarioLimpo < pausa_fim)
        return res.status(400).json({ erro: `Horário indisponível — pausa das ${pausa_inicio} às ${pausa_fim}.` });
    }

    if (profId) {
      const profCheck = await db.query(
        `SELECT disponivel FROM profissionais WHERE id = $1 AND barbearia_id = $2`,
        [profId, barbearia_id]
      );
      if (profCheck.rows.length > 0 && profCheck.rows[0].disponivel === false)
        return res.json({ erro: "Este profissional não está aceitando agendamentos no momento." });

      const pausaCheck = await db.query(
        `SELECT id FROM profissional_pausas
         WHERE profissional_id = $1 AND barbearia_id = $2 AND $3 BETWEEN data_inicio AND data_fim`,
        [profId, barbearia_id, data]
      );
      if (pausaCheck.rows.length > 0)
        return res.status(400).json({ erro: "Este profissional está de folga nesta data. Escolha outro dia ou outro profissional." });
    }

    let queryConflito = `
      SELECT id FROM agendamentos
      WHERE barbearia_id = $1 AND data = $2 AND horario = $3 AND status = 'pendente'`;
    const paramsConflito = [barbearia_id, data, horarioLimpo];
    if (profId) { queryConflito += ` AND profissional_id = $4`; paramsConflito.push(profId); }

    const existe = await db.query(queryConflito, paramsConflito);
    if (existe.rows.length > 0) return res.json({ erro: "Horário já ocupado!" });

    await db.query(
      `INSERT INTO agendamentos (barbearia_id, nome, telefone, data, horario, valor, profissional_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [barbearia_id, nome.trim(), telefone || null, data, horarioLimpo, Number(valor) || 0, profId]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao agendar" }); }
});

// ── LISTAR AGENDAMENTOS ───────────────────────────────────────────────────
app.get("/api/:slug/agendamentos", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, p.nome AS profissional_nome, p.foto_url AS profissional_foto
       FROM agendamentos a
       LEFT JOIN profissionais p ON p.id = a.profissional_id
       WHERE a.barbearia_id = $1
       ORDER BY a.id DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch { res.json([]); }
});

// ── HORÁRIOS OCUPADOS POR DATA ────────────────────────────────────────────
app.get("/api/:slug/agendamentos/data/:data", async (req, res) => {
  const { data } = req.params;
  const { profissional_id } = req.query;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return res.status(400).json({ erro: "Data inválida" });

  try {
    let query  = `SELECT TRIM(horario) AS horario FROM agendamentos
                  WHERE barbearia_id = $1 AND data = $2 AND status = 'pendente'`;
    const params = [req.barbearia.id, data];
    if (profissional_id && !isNaN(Number(profissional_id))) {
      query += ` AND profissional_id = $3`;
      params.push(Number(profissional_id));
    }
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch { res.json([]); }
});

// ── HORÁRIOS DA BARBEARIA ─────────────────────────────────────────────────
app.get("/api/:slug/horarios", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM horarios_barbearia WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    const row = result.rows[0];

    if (row && row.dias_semana) {
      const config = typeof row.dias_semana === "string"
        ? JSON.parse(row.dias_semana)
        : row.dias_semana;
      config.pausa_inicio = row.pausa_inicio || null;
      config.pausa_fim    = row.pausa_fim    || null;
      return res.json(config);
    }

    const hi   = (row && row.hora_inicio)       ? row.hora_inicio       : "08:00";
    const hf   = (row && row.hora_fim)          ? row.hora_fim          : "21:00";
    const intv = (row && row.intervalo_minutos) ? row.intervalo_minutos : 30;
    const fallback = { intervalo_minutos: intv };
    for (let d = 0; d <= 6; d++) {
      fallback[String(d)] = d === 0
        ? { aberto: false }
        : { aberto: true, hora_inicio: hi, hora_fim: hf };
    }
    fallback.pausa_inicio = (row && row.pausa_inicio) || null;
    fallback.pausa_fim    = (row && row.pausa_fim)    || null;
    res.json(fallback);
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao buscar horários" }); }
});

// ── SALVAR HORÁRIOS ───────────────────────────────────────────────────────
app.post("/api/:slug/horarios", verificarAssinatura, async (req, res) => {
  const { pausa_inicio, pausa_fim, ...diasConfig } = req.body;
  if (!diasConfig || typeof diasConfig !== "object")
    return res.status(400).json({ erro: "Config inválida" });
  try {
    await db.query(
      `INSERT INTO horarios_barbearia (barbearia_id, dias_semana, pausa_inicio, pausa_fim)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (barbearia_id)
       DO UPDATE SET dias_semana = $2, pausa_inicio = $3, pausa_fim = $4`,
      [req.barbearia.id, JSON.stringify(diasConfig), pausa_inicio || null, pausa_fim || null]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar horários" }); }
});

// ── CONCLUIR AGENDAMENTO (manual) ─────────────────────────────────────────
app.put("/api/:slug/agendamentos/concluir/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'concluido', auto_concluido = false
       WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao concluir" }); }
});

// ── MARCAR FALTA ──────────────────────────────────────────────────────────
app.put("/api/:slug/agendamentos/falta/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    const result = await db.query(
      `UPDATE agendamentos
       SET status = 'falta', auto_concluido = false
       WHERE id = $1 AND barbearia_id = $2
       RETURNING id`,
      [id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Agendamento não encontrado" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao registrar falta" }); }
});

// ── APAGAR CONCLUÍDOS ─────────────────────────────────────────────────────
app.delete("/api/:slug/agendamentos/concluidos", verificarAssinatura, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM agendamentos WHERE barbearia_id = $1 AND status = 'concluido'`,
      [req.barbearia.id]
    );
    console.log(`Concluídos apagados (${req.params.slug}):`, r.rowCount);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao apagar" }); }
});

// ── CANCELAR AGENDAMENTO ──────────────────────────────────────────────────
app.delete("/api/:slug/agendamentos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'cancelado' WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao cancelar" }); }
});

// ── GASTOS ────────────────────────────────────────────────────────────────
app.post("/api/:slug/gastos", verificarAssinatura, async (req, res) => {
  const { descricao, valor } = req.body;
  if (!descricao || typeof descricao !== "string" || descricao.trim().length === 0)
    return res.status(400).json({ erro: "Descrição inválida" });
  if (isNaN(Number(valor)) || Number(valor) < 0)
    return res.status(400).json({ erro: "Valor inválido" });
  try {
    await db.query(
      `INSERT INTO gastos (barbearia_id, descricao, valor) VALUES ($1, $2, $3)`,
      [req.barbearia.id, descricao.trim(), Number(valor)]
    );
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao salvar gasto" }); }
});

app.get("/api/:slug/gastos", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM gastos WHERE barbearia_id = $1 ORDER BY id DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch { res.json([]); }
});

app.delete("/api/:slug/gastos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(`DELETE FROM gastos WHERE id = $1 AND barbearia_id = $2`, [id, req.barbearia.id]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao deletar" }); }
});

// ── LUCRO REAL ────────────────────────────────────────────────────────────
app.get("/api/:slug/lucro-real", verificarAssinatura, async (req, res) => {
  try {
    const ganhos = await db.query(
      `SELECT COALESCE(SUM(valor),0) AS total FROM agendamentos
       WHERE barbearia_id = $1 AND status = 'concluido'`,
      [req.barbearia.id]
    );
    const gastos = await db.query(
      `SELECT COALESCE(SUM(valor),0) AS total FROM gastos WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    const tg  = Number(ganhos.rows[0].total);
    const tga = Number(gastos.rows[0].total);
    res.json({ ganhos: tg, gastos: tga, lucro: tg - tga });
  } catch (err) { console.error(err); res.json({ ganhos: 0, gastos: 0, lucro: 0 }); }
});

// ── SERVIÇOS ──────────────────────────────────────────────────────────────
app.get("/api/:slug/servicos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT nome, preco, imagem FROM servicos WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.json([]); }
});

// ── PROFISSIONAIS ─────────────────────────────────────────────────────────
app.get("/api/:slug/profissionais", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, foto_url, especialidade, whatsapp, disponivel
       FROM profissionais
       WHERE barbearia_id = $1 AND ativo = true
       ORDER BY ordem`,
      [req.barbearia.id]
    );
    const profissionais = result.rows;
    if (profissionais.length === 0) return res.json([]);

    const hoje = new Date().toISOString().split("T")[0];
    const ids  = profissionais.map(p => p.id);

    const pausasResult = await db.query(
      `SELECT id, profissional_id, data_inicio, data_fim
       FROM profissional_pausas
       WHERE barbearia_id = $1 AND profissional_id = ANY($2::int[]) AND data_fim >= $3
       ORDER BY data_inicio`,
      [req.barbearia.id, ids, hoje]
    );

    const pausasPorProf = {};
    pausasResult.rows.forEach(p => {
      if (!pausasPorProf[p.profissional_id]) pausasPorProf[p.profissional_id] = [];
      pausasPorProf[p.profissional_id].push(p);
    });

    res.json(profissionais.map(p => ({ ...p, pausas: pausasPorProf[p.id] || [] })));
  } catch (err) { console.error(err); res.json([]); }
});

// ── DISPONIBILIDADE DO PROFISSIONAL ──────────────────────────────────────
app.put("/api/:slug/profissionais/:id/disponibilidade", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { disponivel } = req.body;
  if (typeof disponivel !== "boolean") return res.status(400).json({ erro: "Campo 'disponivel' deve ser boolean" });
  try {
    const result = await db.query(
      `UPDATE profissionais SET disponivel = $1
       WHERE id = $2 AND barbearia_id = $3
       RETURNING id, nome, disponivel`,
      [disponivel, id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    res.json({ sucesso: true, profissional: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao atualizar disponibilidade" }); }
});

// ── PAUSAS DO PROFISSIONAL ────────────────────────────────────────────────
app.get("/api/:slug/profissionais/:id/pausas", verificarAssinatura, async (req, res) => {
  const profId = Number(req.params.id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    const hoje   = new Date().toISOString().split("T")[0];
    const result = await db.query(
      `SELECT id, profissional_id, data_inicio, data_fim, criado_em
       FROM profissional_pausas
       WHERE profissional_id = $1 AND barbearia_id = $2 AND data_fim >= $3
       ORDER BY data_inicio`,
      [profId, req.barbearia.id, hoje]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao buscar pausas" }); }
});

app.post("/api/:slug/profissionais/:id/pausas", verificarAssinatura, async (req, res) => {
  const profId = Number(req.params.id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { data_inicio, data_fim } = req.body;
  if (!data_inicio || !/^\d{4}-\d{2}-\d{2}$/.test(data_inicio)) return res.status(400).json({ erro: "data_inicio inválida" });
  if (!data_fim    || !/^\d{4}-\d{2}-\d{2}$/.test(data_fim))    return res.status(400).json({ erro: "data_fim inválida" });
  if (data_fim < data_inicio) return res.status(400).json({ erro: "data_fim deve ser igual ou posterior a data_inicio" });
  try {
    const profCheck = await db.query(
      `SELECT id FROM profissionais WHERE id = $1 AND barbearia_id = $2`,
      [profId, req.barbearia.id]
    );
    if (profCheck.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });

    const sobreposicao = await db.query(
      `SELECT id FROM profissional_pausas
       WHERE profissional_id = $1 AND barbearia_id = $2 AND data_inicio <= $4 AND data_fim >= $3`,
      [profId, req.barbearia.id, data_inicio, data_fim]
    );
    if (sobreposicao.rows.length > 0) return res.status(409).json({ erro: "Já existe uma pausa cadastrada neste período." });

    const insert = await db.query(
      `INSERT INTO profissional_pausas (profissional_id, barbearia_id, data_inicio, data_fim)
       VALUES ($1, $2, $3, $4) RETURNING id, profissional_id, data_inicio, data_fim, criado_em`,
      [profId, req.barbearia.id, data_inicio, data_fim]
    );
    res.status(201).json({ sucesso: true, pausa: insert.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar pausa" }); }
});

app.delete("/api/:slug/profissionais/:profId/pausas/:pausaId", verificarAssinatura, async (req, res) => {
  const profId  = Number(req.params.profId);
  const pausaId = Number(req.params.pausaId);
  if (!Number.isInteger(profId)  || profId  <= 0) return res.status(400).json({ erro: "profId inválido" });
  if (!Number.isInteger(pausaId) || pausaId <= 0) return res.status(400).json({ erro: "pausaId inválido" });
  try {
    const result = await db.query(
      `DELETE FROM profissional_pausas WHERE id = $1 AND profissional_id = $2 AND barbearia_id = $3 RETURNING id`,
      [pausaId, profId, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Pausa não encontrada" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao remover pausa" }); }
});

// ── PLANOS ────────────────────────────────────────────────────────────────
app.get("/api/:slug/planos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, descricao, cortes_mes, valor FROM planos
       WHERE barbearia_id = $1 AND ativo = true ORDER BY ordem, valor`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.json([]); }
});

// ── ASSINAR ───────────────────────────────────────────────────────────────
app.post("/api/:slug/assinar", async (req, res) => {
  const { nome, telefone, plano_id } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome inválido" });
  if (!plano_id || isNaN(Number(plano_id)))
    return res.status(400).json({ erro: "Plano inválido" });
  try {
    const plano = await db.query(
      `SELECT id FROM planos WHERE id = $1 AND barbearia_id = $2 AND ativo = true`,
      [Number(plano_id), req.barbearia.id]
    );
    if (plano.rows.length === 0) return res.status(400).json({ erro: "Plano não encontrado" });
    await db.query(
      `INSERT INTO assinantes (barbearia_id, plano_id, nome, telefone, status) VALUES ($1, $2, $3, $4, 'aguardando')`,
      [req.barbearia.id, Number(plano_id), nome.trim(), telefone || null]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao registrar assinatura" }); }
});

// ── LISTAR ASSINANTES ─────────────────────────────────────────────────────
app.get("/api/:slug/assinantes", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, p.nome AS plano_nome, p.cortes_mes, p.valor AS plano_valor
       FROM assinantes a JOIN planos p ON p.id = a.plano_id
       WHERE a.barbearia_id = $1
       ORDER BY CASE a.status WHEN 'aguardando' THEN 0 WHEN 'ativo' THEN 1 WHEN 'vencido' THEN 2 ELSE 3 END, a.criado_em DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.json([]); }
});

app.delete("/api/:slug/assinantes/cancelados", verificarAssinatura, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM assinantes WHERE barbearia_id = $1 AND status = 'cancelado'`,
      [req.barbearia.id]
    );
    res.json({ sucesso: true, apagados: r.rowCount });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao apagar cancelados" }); }
});

// ── AÇÕES DO ASSINANTE ────────────────────────────────────────────────────
app.put("/api/:slug/assinantes/:id/:acao", verificarAssinatura, async (req, res) => {
  const id   = Number(req.params.id);
  const acao = req.params.acao;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const acoesValidas = ["confirmar","usar-corte","renovar","cancelar"];
  if (!acoesValidas.includes(acao)) return res.status(400).json({ erro: "Ação inválida" });

  try {
    const check = await db.query(
      `SELECT a.id, a.status, a.cortes_usados, p.cortes_mes
       FROM assinantes a JOIN planos p ON p.id = a.plano_id
       WHERE a.id = $1 AND a.barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ erro: "Assinante não encontrado" });
    const ass = check.rows[0];

    if (acao === "confirmar") {
      await db.query(
        `UPDATE assinantes SET status = 'ativo', cortes_usados = 0,
         data_inicio = NOW(), data_vencimento = NOW() + INTERVAL '30 days'
         WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }
    if (acao === "usar-corte") {
      if (ass.status !== "ativo") return res.json({ erro: "Plano não está ativo" });
      if (ass.cortes_usados >= ass.cortes_mes) return res.json({ erro: "Limite de cortes atingido neste mês" });
      await db.query(`UPDATE assinantes SET cortes_usados = cortes_usados + 1 WHERE id = $1`, [id]);
      return res.json({ sucesso: true });
    }
    if (acao === "renovar") {
      await db.query(
        `UPDATE assinantes SET status = 'aguardando', cortes_usados = 0,
         data_inicio = NULL, data_vencimento = NULL WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }
    if (acao === "cancelar") {
      await db.query(`UPDATE assinantes SET status = 'cancelado' WHERE id = $1`, [id]);
      return res.json({ sucesso: true });
    }
  } catch (err) { console.error(err); res.json({ erro: "Erro ao executar ação" }); }
});

// ── SERVIÇOS DESTAQUE ─────────────────────────────────────────────────────
app.get("/api/:slug/servicos-destaque", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, descricao, preco, imagem FROM servicos_destaque
       WHERE barbearia_id = $1 ORDER BY ordem, id`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.json([]); }
});

app.post("/api/:slug/servicos-destaque", verificarAssinatura, async (req, res) => {
  const { nome, descricao, preco, ordem, imagem } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0) return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(preco)) || Number(preco) < 0) return res.status(400).json({ erro: "Preço inválido" });
  try {
    await db.query(
      `INSERT INTO servicos_destaque (barbearia_id, nome, descricao, preco, ordem, imagem) VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.barbearia.id, nome.trim(), descricao || "", Number(preco), Number(ordem) || 0, imagem || null]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao salvar" }); }
});

app.delete("/api/:slug/servicos-destaque/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(`DELETE FROM servicos_destaque WHERE id = $1 AND barbearia_id = $2`, [id, req.barbearia.id]);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao deletar" }); }
});

app.put("/api/:slug/servicos-destaque/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { nome, descricao, preco, ordem, imagem } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0) return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(preco)) || Number(preco) < 0) return res.status(400).json({ erro: "Preço inválido" });
  try {
    await db.query(
      `UPDATE servicos_destaque SET nome=$1, descricao=$2, preco=$3, ordem=$4, imagem=$5
       WHERE id=$6 AND barbearia_id=$7`,
      [nome.trim(), descricao || "", Number(preco), Number(ordem) || 0, imagem || null, id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao atualizar" }); }
});

// ── COMISSÕES ─────────────────────────────────────────────────────────────
app.get("/api/:slug/comissoes/config", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, foto_url, especialidade,
              COALESCE(comissao_percentual, 0) AS comissao_percentual,
              COALESCE(comissao_valor_fixo,  0) AS comissao_valor_fixo
       FROM profissionais
       WHERE barbearia_id = $1 AND ativo = true ORDER BY ordem`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao buscar configurações de comissão" }); }
});

app.put("/api/:slug/comissoes/config/:profissional_id", verificarAssinatura, async (req, res) => {
  const profId = Number(req.params.profissional_id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "ID inválido" });
  const pct = Number(req.body.percentual);
  const vfx = Number(req.body.valor_fixo);
  if (isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ erro: "Percentual inválido (0–100)" });
  if (isNaN(vfx) || vfx < 0) return res.status(400).json({ erro: "Valor fixo inválido" });
  try {
    const result = await db.query(
      `UPDATE profissionais SET comissao_percentual = $1, comissao_valor_fixo = $2
       WHERE id = $3 AND barbearia_id = $4
       RETURNING id, nome, comissao_percentual, comissao_valor_fixo`,
      [pct, vfx, profId, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    res.json({ sucesso: true, profissional: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar comissão" }); }
});

app.get("/api/:slug/comissoes/relatorio", verificarAssinatura, async (req, res) => {
  const { mes, data, data_fim, profissional_id } = req.query;
  let dataInicio, dataFim, referenciaAjustes;

  if (data_fim && /^\d{4}-\d{2}-\d{2}$/.test(data_fim) && data && /^\d{4}-\d{4}-\d{2}-\d{2}$/.test(data)) {
    dataInicio = data; dataFim = data_fim; referenciaAjustes = data.substring(0, 7);
  } else if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
    dataInicio = data; dataFim = data_fim && /^\d{4}-\d{2}-\d{2}$/.test(data_fim) ? data_fim : data;
    referenciaAjustes = data.substring(0, 7);
  } else {
    const periodo = (mes && /^\d{4}-\d{2}$/.test(mes)) ? mes : new Date().toISOString().substring(0, 7);
    referenciaAjustes = periodo;
    dataInicio = `${periodo}-01`;
    const [y, m] = periodo.split("-").map(Number);
    dataFim = `${periodo}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  }

  const params = [req.barbearia.id, dataInicio, dataFim];
  let filtroProf = "";
  if (profissional_id && !isNaN(Number(profissional_id))) {
    filtroProf = " AND p.id = $4";
    params.push(Number(profissional_id));
  }

  try {
    const agResult = await db.query(
      `SELECT p.id AS profissional_id, p.nome AS profissional_nome, p.foto_url,
              COALESCE(p.comissao_percentual, 0) AS percentual,
              COALESCE(p.comissao_valor_fixo,  0) AS valor_fixo,
              COUNT(a.id) AS total_cortes,
              COALESCE(SUM(a.valor), 0) AS faturamento
       FROM profissionais p
       LEFT JOIN agendamentos a
         ON a.profissional_id = p.id AND a.barbearia_id = $1
         AND a.status = 'concluido' AND a.data BETWEEN $2 AND $3
       WHERE p.barbearia_id = $1 AND p.ativo = true ${filtroProf}
       GROUP BY p.id, p.nome, p.foto_url, p.comissao_percentual, p.comissao_valor_fixo
       ORDER BY p.ordem`,
      params
    );

    const ajParams = [req.barbearia.id, referenciaAjustes];
    let filtroAjProf = "";
    if (profissional_id && !isNaN(Number(profissional_id))) {
      filtroAjProf = " AND profissional_id = $3";
      ajParams.push(Number(profissional_id));
    }
    const ajResult = await db.query(
      `SELECT id, profissional_id, descricao, valor, criado_em
       FROM comissao_ajustes WHERE barbearia_id = $1 AND referencia_mes = $2 ${filtroAjProf}
       ORDER BY criado_em DESC`,
      ajParams
    );

    const ajustesPorProf = {};
    ajResult.rows.forEach(aj => {
      if (!ajustesPorProf[aj.profissional_id]) ajustesPorProf[aj.profissional_id] = [];
      ajustesPorProf[aj.profissional_id].push(aj);
    });

    const relatorio = agResult.rows.map(prof => {
      const faturamento  = Number(prof.faturamento);
      const totalCortes  = Number(prof.total_cortes);
      const percentual   = Number(prof.percentual);
      const valorFixo    = Number(prof.valor_fixo);
      const ajustes      = ajustesPorProf[prof.profissional_id] || [];
      const totalAjustes = ajustes.reduce((s, a) => s + Number(a.valor), 0);
      const comissaoBase  = (faturamento * percentual / 100) + (valorFixo * totalCortes);
      const comissaoFinal = comissaoBase + totalAjustes;
      return {
        profissional_id:   prof.profissional_id,
        profissional_nome: prof.profissional_nome,
        foto_url:          prof.foto_url,
        percentual, valor_fixo: valorFixo, total_cortes: totalCortes, faturamento,
        comissao_base:  Number(comissaoBase.toFixed(2)),
        total_ajustes:  Number(totalAjustes.toFixed(2)),
        comissao_final: Number(comissaoFinal.toFixed(2)),
        ajustes
      };
    });

    res.json({ periodo: { inicio: dataInicio, fim: dataFim, referencia: referenciaAjustes }, relatorio });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao gerar relatório" }); }
});

app.post("/api/:slug/comissoes/ajuste", verificarAssinatura, async (req, res) => {
  const { profissional_id, descricao, valor, referencia_mes } = req.body;
  const profId = Number(profissional_id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "Profissional inválido" });
  if (!descricao || typeof descricao !== "string" || descricao.trim().length === 0) return res.status(400).json({ erro: "Descrição inválida" });
  if (isNaN(Number(valor))) return res.status(400).json({ erro: "Valor inválido" });
  if (!referencia_mes || !/^\d{4}-\d{2}$/.test(referencia_mes)) return res.status(400).json({ erro: "Mês de referência inválido (YYYY-MM)" });
  try {
    const check = await db.query(
      `SELECT id FROM profissionais WHERE id = $1 AND barbearia_id = $2`,
      [profId, req.barbearia.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    await db.query(
      `INSERT INTO comissao_ajustes (barbearia_id, profissional_id, descricao, valor, referencia_mes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.barbearia.id, profId, descricao.trim(), Number(valor), referencia_mes]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar ajuste" }); }
});

app.delete("/api/:slug/comissoes/ajuste/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(
      `DELETE FROM comissao_ajustes WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao deletar ajuste" }); }
});

// ── ONBOARDING PÚBLICO ────────────────────────────────────────────────────
app.get("/cadastro/check-username", async (req, res) => {
  const { u } = req.query;
  if (!u || u.length < 3) return res.json({ disponivel: false });
  try {
    const r = await db.query("SELECT id FROM barbearias WHERE username = $1", [u.trim()]);
    res.json({ disponivel: r.rows.length === 0 });
  } catch { res.json({ disponivel: false }); }
});

app.post("/cadastro", async (req, res) => {
  const { barbearia, horarios, servicos, servicosDestaque, profissionais, planos } = req.body;

  if (!barbearia || typeof barbearia.nome !== "string" || barbearia.nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome da barbearia inválido" });
  if (!barbearia.username || barbearia.username.length < 3)
    return res.status(400).json({ erro: "Username deve ter ao menos 3 caracteres" });
  if (!barbearia.password || barbearia.password.length < 6)
    return res.status(400).json({ erro: "Senha deve ter ao menos 6 caracteres" });

  try {
    const usernameCheck = await db.query(
      "SELECT id FROM barbearias WHERE username = $1", [barbearia.username.trim()]
    );
    if (usernameCheck.rows.length > 0)
      return res.status(409).json({ erro: "Este usuário já está em uso. Escolha outro." });

    const slug = await gerarSlug(barbearia.nome.trim());
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 30);

    const barbResult = await db.query(
      `INSERT INTO barbearias
         (slug, nome, cidade, whatsapp, username, password,
          cor_primaria, sobre, ativo, vencimento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
       RETURNING id, slug`,
      [
        slug,
        barbearia.nome.trim(),
        barbearia.cidade       || "",
        barbearia.whatsapp     || "",
        barbearia.username.trim(),
        barbearia.password,
        barbearia.cor_primaria || "#c8a96e",
        barbearia.sobre        || "",
        vencimento
      ]
    );

    const { id: barbId, slug: barbSlug } = barbResult.rows[0];

    if (horarios && typeof horarios === "object") {
      const { pausa_inicio, pausa_fim, ...diasConfig } = horarios;
      await db.query(
        `INSERT INTO horarios_barbearia (barbearia_id, dias_semana, pausa_inicio, pausa_fim)
         VALUES ($1, $2, $3, $4)`,
        [barbId, JSON.stringify(diasConfig), pausa_inicio || null, pausa_fim || null]
      );
    }

    if (Array.isArray(servicos)) {
      for (const s of servicos) {
        if (!s.nome || isNaN(Number(s.preco))) continue;
        await db.query(
          `INSERT INTO servicos (barbearia_id, nome, preco) VALUES ($1, $2, $3)`,
          [barbId, s.nome.trim(), Number(s.preco)]
        );
      }
    }

    if (Array.isArray(servicosDestaque)) {
      for (let i = 0; i < servicosDestaque.length; i++) {
        const s = servicosDestaque[i];
        if (!s.nome || isNaN(Number(s.preco))) continue;
        await db.query(
          `INSERT INTO servicos_destaque (barbearia_id, nome, descricao, preco, ordem, imagem)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [barbId, s.nome.trim(), s.descricao || "", Number(s.preco), i, s.imagem || null]
        );
      }
    }

    if (Array.isArray(profissionais)) {
      for (let i = 0; i < profissionais.length; i++) {
        const p = profissionais[i];
        if (!p.nome || p.nome.trim().length < 2) continue;
        await db.query(
          `INSERT INTO profissionais (barbearia_id, nome, especialidade, whatsapp, ativo, disponivel, ordem)
           VALUES ($1,$2,$3,$4,true,true,$5)`,
          [barbId, p.nome.trim(), p.especialidade || "", p.whatsapp || "", i]
        );
      }
    }

    if (Array.isArray(planos)) {
      for (let i = 0; i < planos.length; i++) {
        const pl = planos[i];
        if (!pl.nome || isNaN(Number(pl.valor))) continue;
        await db.query(
          `INSERT INTO planos (barbearia_id, nome, descricao, cortes_mes, valor, ativo, ordem)
           VALUES ($1,$2,$3,$4,$5,true,$6)`,
          [barbId, pl.nome.trim(), pl.descricao || "", Number(pl.cortes_mes) || 0, Number(pl.valor), i]
        );
      }
    }

    console.log(`✅ Nova barbearia: ${barbSlug} (id ${barbId})`);
    res.status(201).json({
      sucesso:      true,
      slug:         barbSlug,
      painel:       `/${barbSlug}/admin`,
      agendamento:  `/${barbSlug}`
    });

  } catch (err) {
    console.error("Erro no cadastro:", err.message);
    res.status(500).json({ erro: "Erro interno ao criar barbearia" });
  }
});

// ── DEBUG ─────────────────────────────────────────────────────────────────
app.get("/debug-path", (req, res) => {
  const dir    = path.join(__dirname, '..', 'projeto');
  const existe = fs.existsSync(dir);
  res.json({ dir, existe, arquivos: existe ? fs.readdirSync(dir) : [] });
});

// ── CONFIG (salvar) ───────────────────────────────────────────────────────
app.put("/api/:slug/config", verificarAssinatura, async (req, res) => {
  const { nome, cidade, whatsapp, pix_chave, cor_primaria, sobre } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome inválido" });
  try {
    await db.query(
      `UPDATE barbearias
       SET nome=$1, cidade=$2, whatsapp=$3, pix_chave=$4, cor_primaria=$5, sobre=$6
       WHERE slug=$7`,
      [nome.trim(), cidade || "", whatsapp || "", pix_chave || "", cor_primaria || "#c8a96e", sobre || "", req.params.slug]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar configurações" }); }
});

// ── PROFISSIONAIS CRUD ────────────────────────────────────────────────────
app.post("/api/:slug/profissionais", verificarAssinatura, async (req, res) => {
  const { nome, especialidade, whatsapp, ordem, foto_url, disponivel } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome inválido" });
  try {
    const result = await db.query(
      `INSERT INTO profissionais
         (barbearia_id, nome, especialidade, whatsapp, ordem, foto_url, disponivel, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [req.barbearia.id, nome.trim(), especialidade || "", whatsapp || "", Number(ordem) || 0, foto_url || null, disponivel !== false]
    );
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao adicionar profissional" }); }
});

app.put("/api/:slug/profissionais/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { nome, especialidade, whatsapp, ordem, foto_url, disponivel } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome inválido" });
  try {
    const result = await db.query(
      `UPDATE profissionais
       SET nome=$1, especialidade=$2, whatsapp=$3, ordem=$4, foto_url=$5, disponivel=$6
       WHERE id=$7 AND barbearia_id=$8 RETURNING id`,
      [nome.trim(), especialidade || "", whatsapp || "", Number(ordem) || 0, foto_url || null, disponivel !== false, id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao editar profissional" }); }
});

app.delete("/api/:slug/profissionais/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    const result = await db.query(
      `UPDATE profissionais SET ativo = false WHERE id=$1 AND barbearia_id=$2 RETURNING id`,
      [id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao remover profissional" }); }
});

// ── SERVIÇOS ADMIN CRUD ───────────────────────────────────────────────────
app.get("/api/:slug/servicos/admin", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, preco, imagem FROM servicos WHERE barbearia_id=$1 ORDER BY id`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.json([]); }
});

app.post("/api/:slug/servicos", verificarAssinatura, async (req, res) => {
  const { nome, preco, imagem } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(preco)) || Number(preco) < 0)
    return res.status(400).json({ erro: "Preço inválido" });
  try {
    const result = await db.query(
      `INSERT INTO servicos (barbearia_id, nome, preco, imagem) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.barbearia.id, nome.trim(), Number(preco), imagem || null]
    );
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao adicionar serviço" }); }
});

app.put("/api/:slug/servicos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { nome, preco, imagem } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(preco)) || Number(preco) < 0)
    return res.status(400).json({ erro: "Preço inválido" });
  try {
    const result = await db.query(
      `UPDATE servicos SET nome=$1, preco=$2, imagem=$3 WHERE id=$4 AND barbearia_id=$5 RETURNING id`,
      [nome.trim(), Number(preco), imagem || null, id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Serviço não encontrado" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao editar serviço" }); }
});

app.delete("/api/:slug/servicos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(`DELETE FROM servicos WHERE id=$1 AND barbearia_id=$2`, [id, req.barbearia.id]);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao deletar serviço" }); }
});

// ── PLANOS CRUD ───────────────────────────────────────────────────────────
app.post("/api/:slug/planos", verificarAssinatura, async (req, res) => {
  const { nome, valor, cortes_mes, descricao, ordem, ativo } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(valor)) || Number(valor) < 0)
    return res.status(400).json({ erro: "Valor inválido" });
  try {
    const result = await db.query(
      `INSERT INTO planos (barbearia_id, nome, descricao, cortes_mes, valor, ativo, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.barbearia.id, nome.trim(), descricao || "", Number(cortes_mes) || 0, Number(valor), ativo !== false, Number(ordem) || 0]
    );
    res.json({ sucesso: true, id: result.rows[0].id });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao criar plano" }); }
});

app.put("/api/:slug/planos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { nome, valor, cortes_mes, descricao, ordem, ativo } = req.body;
  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });
  if (isNaN(Number(valor)) || Number(valor) < 0)
    return res.status(400).json({ erro: "Valor inválido" });
  try {
    const result = await db.query(
      `UPDATE planos SET nome=$1, descricao=$2, cortes_mes=$3, valor=$4, ativo=$5, ordem=$6
       WHERE id=$7 AND barbearia_id=$8 RETURNING id`,
      [nome.trim(), descricao || "", Number(cortes_mes) || 0, Number(valor), ativo !== false, Number(ordem) || 0, id, req.barbearia.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Plano não encontrado" });
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao editar plano" }); }
});

app.delete("/api/:slug/planos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    const check = await db.query(
      `SELECT COUNT(*) AS total FROM assinantes
       WHERE plano_id=$1 AND barbearia_id=$2 AND status IN ('ativo','aguardando')`,
      [id, req.barbearia.id]
    );
    if (Number(check.rows[0].total) > 0)
      return res.status(409).json({ erro: "Existem assinantes ativos neste plano. Cancele-os antes de excluir." });
    await db.query(`DELETE FROM planos WHERE id=$1 AND barbearia_id=$2`, [id, req.barbearia.id]);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao deletar plano" }); }
});

// ── HORÁRIOS POR PROFISSIONAL ─────────────────────────────────────────────
app.get("/api/:slug/profissionais/:id/horarios", async (req, res) => {
  const profId = Number(req.params.id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    const result = await db.query(
      `SELECT dias_semana, pausa_inicio, pausa_fim
       FROM profissional_horarios WHERE profissional_id=$1 AND barbearia_id=$2`,
      [profId, req.barbearia.id]
    );

    if (result.rows.length === 0) {
      const global = await db.query(
        `SELECT dias_semana, pausa_inicio, pausa_fim FROM horarios_barbearia WHERE barbearia_id=$1`,
        [req.barbearia.id]
      );
      if (global.rows.length > 0) {
        const row = global.rows[0];
        const cfg = typeof row.dias_semana === "string" ? JSON.parse(row.dias_semana) : (row.dias_semana || {});
        cfg.pausa_inicio = row.pausa_inicio || null;
        cfg.pausa_fim    = row.pausa_fim    || null;
        cfg._usa_global  = true;
        return res.json(cfg);
      }
      return res.json({ _usa_global: true });
    }

    const row = result.rows[0];
    const cfg = typeof row.dias_semana === "string" ? JSON.parse(row.dias_semana) : (row.dias_semana || {});
    cfg.pausa_inicio = row.pausa_inicio || null;
    cfg.pausa_fim    = row.pausa_fim    || null;
    cfg._usa_global  = false;
    res.json(cfg);
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao buscar horários do profissional" }); }
});

app.post("/api/:slug/profissionais/:id/horarios", verificarAssinatura, async (req, res) => {
  const profId = Number(req.params.id);
  if (!Number.isInteger(profId) || profId <= 0) return res.status(400).json({ erro: "ID inválido" });
  const { pausa_inicio, pausa_fim, usa_global, ...diasConfig } = req.body;
  try {
    const check = await db.query(
      `SELECT id FROM profissionais WHERE id=$1 AND barbearia_id=$2`,
      [profId, req.barbearia.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });

    if (usa_global) {
      await db.query(
        `DELETE FROM profissional_horarios WHERE profissional_id=$1 AND barbearia_id=$2`,
        [profId, req.barbearia.id]
      );
      return res.json({ sucesso: true, modo: "global" });
    }

    await db.query(
      `INSERT INTO profissional_horarios (profissional_id, barbearia_id, dias_semana, pausa_inicio, pausa_fim)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (profissional_id, barbearia_id)
       DO UPDATE SET dias_semana=$3, pausa_inicio=$4, pausa_fim=$5`,
      [profId, req.barbearia.id, JSON.stringify(diasConfig), pausa_inicio || null, pausa_fim || null]
    );
    res.json({ sucesso: true, modo: "individual" });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar horários do profissional" }); }
});

// ── ROTAS WHATSAPP POR SLUG ───────────────────────────────────────────────
app.get("/api/:slug/whatsapp-status", (req, res) => {
  const sessao = waSessoes[req.params.slug];
  res.json({
    conectado: sessao?.conectado || false,
    status:    sessao?.status    || "desconectado",
    temQr:     !!sessao?.qrBase64,
  });
});

app.post("/api/:slug/whatsapp/conectar", verificarAssinatura, async (req, res) => {
  const slug   = req.params.slug;
  const sessao = waSessoes[slug];

  if (sessao?.status === "conectado") return res.json({ conectado: true, status: "conectado" });
  if (sessao?.status === "aguardando_qr" && sessao.qrBase64) return res.json({ status: "aguardando_qr", qr: sessao.qrBase64 });

  iniciarWhatsAppSlug(slug);

  let tentativas = 0;
  await new Promise(resolve => {
    const check = setInterval(() => {
      const s = waSessoes[slug];
      tentativas++;
      if (s?.qrBase64 || s?.status === "conectado" || tentativas > 16) {
        clearInterval(check);
        resolve();
      }
    }, 500);
  });

  const s = waSessoes[slug];
  if (s?.status === "conectado") return res.json({ conectado: true, status: "conectado" });
  if (s?.qrBase64)               return res.json({ status: "aguardando_qr", qr: s.qrBase64 });
  res.json({ status: "aguardando_qr", qr: null, msg: "QR ainda sendo gerado. Tente novamente em 2s." });
});

app.get("/api/:slug/whatsapp/qr", verificarAssinatura, (req, res) => {
  const sessao = waSessoes[req.params.slug];
  if (!sessao)                       return res.json({ status: "desconectado" });
  if (sessao.status === "conectado") return res.json({ status: "conectado" });
  if (sessao.qrBase64)               return res.json({ status: "aguardando_qr", qr: sessao.qrBase64 });
  res.json({ status: sessao.status || "desconectado" });
});

app.post("/api/:slug/whatsapp/desconectar", verificarAssinatura, async (req, res) => {
  const slug   = req.params.slug;
  const sessao = waSessoes[slug];
  try {
    if (sessao?.socket) await sessao.socket.logout().catch(() => {});
  } catch {}
  const AUTH_DIR = `./auth_wa/${slug}`;
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  delete waSessoes[slug];
  res.json({ sucesso: true });
});

// ── ROTAS DE DIAGNÓSTICO ──────────────────────────────────────────────────
app.get("/testar-wa/:slug", async (req, res) => {
  try {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
    const qrcode = require("qrcode");
    const pino   = require("pino");
    res.json({ ok: true, msg: "Baileys carregou com sucesso" });
  } catch (err) {
    res.json({ ok: false, erro: err.message, code: err.code });
  }
});

app.get("/forcar-wa/:slug", async (req, res) => {
  const slug = req.params.slug;
  await iniciarWhatsAppSlug(slug);
  await new Promise(r => setTimeout(r, 8000));
  const s = waSessoes[slug];
  res.json({ status: s?.status || "nenhuma", temQr: !!s?.qrBase64, qr: s?.qrBase64 || null });
});

app.get("/debug-wa-erro/:slug", async (req, res) => {
  const slug = req.params.slug;
  const logs = [];
  try {
    logs.push("1. importando baileys...");
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
    const qrcode = require("qrcode");
    const pino   = require("pino");
    logs.push("2. baileys importado");
    const AUTH_DIR = `./auth_wa/${slug}`;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    logs.push("3. pasta criada");
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    logs.push("4. auth state ok");
    const { version } = await fetchLatestBaileysVersion();
    logs.push("5. versao obtida: " + JSON.stringify(version));
    res.json({ ok: true, logs });
  } catch (err) {
    res.json({ ok: false, logs, erro: err.message, stack: err.stack?.substring(0, 500) });
  }
});

app.get("/debug-wa-socket/:slug", async (req, res) => {
  const slug = req.params.slug;
  const logs = [];
  try {
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
    const pino   = require("pino");
    const qrcode = require("qrcode");
    const AUTH_DIR = `./auth_wa/${slug}`;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    logs.push("criando socket...");
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: "silent" }) });
    logs.push("socket criado, aguardando QR por 15s...");
    await new Promise((resolve) => {
      sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {
        if (qr) {
          logs.push("QR GERADO!");
          const qrBase64 = await qrcode.toDataURL(qr);
          res.json({ ok: true, logs, qr: qrBase64 });
          resolve();
        }
        if (connection === "open") {
          logs.push("CONECTADO!");
          res.json({ ok: true, logs, conectado: true });
          resolve();
        }
        if (connection === "close") {
          logs.push("FECHOU: " + (lastDisconnect?.error?.message || "desconhecido"));
          res.json({ ok: false, logs });
          resolve();
        }
      });
      setTimeout(() => {
        logs.push("timeout — nenhum evento em 15s");
        res.json({ ok: false, logs });
        resolve();
      }, 15000);
    });
  } catch (err) {
    res.json({ ok: false, logs, erro: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROTAS DE ADMIN MASTER (painel que lista TODAS as barbearias)
// ═══════════════════════════════════════════════════════════════════════
const SENHA_PAINEL_ADMIN = "ZinksggZ2";

function checarChaveAdmin(req, res, next) {
  const chave = req.headers["x-admin-key"] || req.query.chave;
  if (chave !== SENHA_PAINEL_ADMIN) {
    return res.status(401).json({ erro: "Senha de admin inválida" });
  }
  next();
}

app.get("/admin/barbearias", checarChaveAdmin, async (req, res) => {
  try {
    const barbearias = await db.query(`SELECT * FROM barbearias ORDER BY id DESC`);

    const resultado = [];
    for (const b of barbearias.rows) {
      const [servicos, profissionais, planos, horarios, assinantesCount, agendamentosCount] = await Promise.all([
        db.query(`SELECT * FROM servicos WHERE barbearia_id = $1 ORDER BY id`, [b.id]),
        db.query(`SELECT * FROM profissionais WHERE barbearia_id = $1 ORDER BY ordem`, [b.id]),
        db.query(`SELECT * FROM planos WHERE barbearia_id = $1 ORDER BY ordem`, [b.id]),
        db.query(`SELECT * FROM horarios_barbearia WHERE barbearia_id = $1`, [b.id]),
        db.query(`SELECT COUNT(*)::int AS total FROM assinantes WHERE barbearia_id = $1`, [b.id]),
        db.query(`SELECT COUNT(*)::int AS total FROM agendamentos WHERE barbearia_id = $1`, [b.id]),
      ]);

      resultado.push({
        ...b,
        servicos: servicos.rows,
        profissionais: profissionais.rows,
        planos: planos.rows,
        horarios: horarios.rows[0] || null,
        total_assinantes: assinantesCount.rows[0].total,
        total_agendamentos: agendamentosCount.rows[0].total,
      });
    }

    res.json(resultado);
  } catch (err) {
    console.error("Erro ao listar barbearias (admin):", err.message);
    res.status(500).json({ erro: "Erro ao listar barbearias" });
  }
});

app.put("/admin/barbearias/:id", checarChaveAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });

  const {
    nome, cidade, whatsapp, username, password,
    pix_chave, cor_primaria, sobre, ativo, vencimento
  } = req.body;

  if (!nome || typeof nome !== "string" || nome.trim().length < 2)
    return res.status(400).json({ erro: "Nome inválido" });

  try {
    const campos = [];
    const valores = [];
    let i = 1;

    const set = (col, val) => { campos.push(`${col} = $${i++}`); valores.push(val); };

    set("nome", nome.trim());
    set("cidade", cidade || "");
    set("whatsapp", whatsapp || "");
    if (username) set("username", username.trim());
    if (password) set("password", password);
    set("pix_chave", pix_chave || "");
    set("cor_primaria", cor_primaria || "#c8a96e");
    set("sobre", sobre || "");
    if (typeof ativo === "boolean") set("ativo", ativo);
    if (vencimento) set("vencimento", vencimento);

    valores.push(id);
    const sql = `UPDATE barbearias SET ${campos.join(", ")} WHERE id = $${i} RETURNING *`;
    const result = await db.query(sql, valores);

    if (result.rows.length === 0) return res.status(404).json({ erro: "Barbearia não encontrada" });
    res.json({ sucesso: true, barbearia: result.rows[0] });
  } catch (err) {
    console.error("Erro ao editar barbearia (admin):", err.message);
    res.status(500).json({ erro: "Erro ao editar barbearia" });
  }
});

app.delete("/admin/barbearias/:id", checarChaveAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });

  try {
    const barb = await db.query(`SELECT slug FROM barbearias WHERE id = $1`, [id]);
    if (barb.rows.length === 0) return res.status(404).json({ erro: "Barbearia não encontrada" });
    const slug = barb.rows[0].slug;

    await db.query(`DELETE FROM comissao_ajustes WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM assinantes WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM planos WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM agendamentos WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM gastos WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM servicos_destaque WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM servicos WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM profissional_pausas WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM profissional_horarios WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM profissionais WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM horarios_barbearia WHERE barbearia_id = $1`, [id]);
    await db.query(`DELETE FROM barbearias WHERE id = $1`, [id]);

    if (waSessoes[slug]?.socket) {
      try { await waSessoes[slug].socket.logout().catch(() => {}); } catch {}
    }
    delete waSessoes[slug];
    const AUTH_DIR = `./auth_wa/${slug}`;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });

    console.log(`🗑️  Barbearia apagada (admin): ${slug} (id ${id})`);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao apagar barbearia (admin):", err.message);
    res.status(500).json({ erro: "Erro ao apagar barbearia" });
  }
});

// ── ARQUIVOS ESTÁTICOS ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'projeto')));

// ── BANCO + START ─────────────────────────────────────────────────────────
db.query("SELECT NOW()")
  .then(r => console.log("✅ PostgreSQL conectado:", r.rows[0].now))
  .catch(e => console.log("❌ Erro conexão banco:", e.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor multi-tenant na porta ${PORT}`));