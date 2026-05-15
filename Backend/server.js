// server.js — Multi-tenant PostgreSQL + WhatsApp via Baileys
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");
const fs      = require("fs");

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: "10kb" }));

const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");

app.use(helmet());

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

// CORS corrigido — aceita Vercel, domínio próprio e localhost
const ORIGENS_PERMITIDAS = [
  "https://vtrip.com.br",
  "http://vtrip.com.br",
  "https://barbearias-flax.vercel.app",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisições sem origin (ex: Postman, curl) e origens da lista
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS bloqueado para: " + origin));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// Responde preflight OPTIONS em todas as rotas sem redirecionar
app.options("*", cors({
  origin: function (origin, callback) {
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS bloqueado para: " + origin));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// ARQUIVOS ESTÁTICOS
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'projeto')));

// WHATSAPP COM BAILEYS
let waSocket    = null;
let waConectado = false;

async function iniciarWhatsApp() {
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion
    } = require("@whiskeysockets/baileys");

    const qrcode = require("qrcode-terminal");

    const AUTH_DIR = "./auth_info_baileys";
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" })
    });

    waSocket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("\n╔══════════════════════════════════════╗");
        console.log("║  ESCANEIE O QR CODE NO SEU WHATSAPP  ║");
        console.log("╚══════════════════════════════════════╝\n");
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        waConectado = true;
        console.log("✅ WhatsApp conectado! Lembretes automáticos ativos.");
      }
      if (connection === "close") {
        waConectado = false;
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const deveReconectar = codigo !== DisconnectReason.loggedOut;
        console.log(`⚠️  WhatsApp desconectado. Código: ${codigo}`);
        if (deveReconectar) {
          console.log("🔄 Reconectando em 5s...");
          setTimeout(iniciarWhatsApp, 5000);
        } else {
          console.log("❌ Sessão encerrada. Delete a pasta auth_info_baileys e reinicie.");
        }
      }
    });

    waSocket.ev.on("creds.update", saveCreds);

  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      console.log("ℹ️  Baileys não instalado — WhatsApp desativado.");
    } else {
      console.error("Erro ao iniciar WhatsApp:", err.message);
      setTimeout(iniciarWhatsApp, 10000);
    }
  }
}

iniciarWhatsApp();

// LEMBRETE VIA WHATSAPP
async function enviarLembrete(ag) {
  if (!waSocket || !waConectado) {
    console.log(`⚠️  WhatsApp offline — lembrete não enviado para ${ag.nome}`);
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
    await waSocket.sendMessage(jid, { text: mensagem });
    console.log(`✅ Lembrete enviado → ${ag.nome} (${telefone})`);
  } catch (err) {
    console.error(`❌ Erro ao enviar lembrete para ${ag.nome}:`, err.message);
  }
}

// JOB DE LEMBRETES — a cada 60s, dispara ~1h antes
async function verificarLembretes() {
  try {
    const agora  = new Date();
    const result = await db.query(`
      SELECT a.id, a.nome, a.telefone, a.data, a.horario,
             b.nome AS nome_barbearia
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
      const dataHorario     = new Date(Number(ano), Number(mes) - 1, Number(dia), Number(hora), Number(min), 0);
      const diffMin         = (dataHorario - agora) / 60000;

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

// STATUS WHATSAPP
app.get("/whatsapp-status", (req, res) => {
  res.json({ conectado: waConectado });
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

  let slug = base;
  let tentativa = 0;
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
  } catch (err) {
    console.error(err);
    res.json({});
  }
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro no login" });
  }
});

// ── AGENDAR ───────────────────────────────────────────────────────────────

function validarAgendamento({ nome, data, horario, valor }) {
  if (!nome || typeof nome !== "string" || nome.trim().length < 2) return "Nome inválido";
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida";
  if (!horario || !/^\d{2}:\d{2}(:\d{2})?$/.test(horario)) return "Horário inválido";

  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m]          = horario.split(":").map(Number);
  const agendamentoUTC  = Date.UTC(ano, mes - 1, dia, h + 3, m, 0);
  const agoraUTC        = Date.now() - 2 * 60 * 1000;

  if (agendamentoUTC <= agoraUTC) return "Não é possível agendar em horário passado";
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
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao agendar" });
  }
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
    let query = `SELECT TRIM(horario) AS horario FROM agendamentos
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

// ── HORÁRIOS DA BARBEARIA (configuração) ──────────────────────────────────

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar horários" });
  }
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar horários" });
  }
});

// ── CONCLUIR AGENDAMENTO ──────────────────────────────────────────────────

app.put("/api/:slug/agendamentos/concluir/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'concluido' WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao concluir" }); }
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
  } catch (err) {
    console.error(err);
    res.json({ ganhos: 0, gastos: 0, lucro: 0 });
  }
});

// ── SERVIÇOS (agendamento) ────────────────────────────────────────────────

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
    const profCheck = await db.query(`SELECT id FROM profissionais WHERE id = $1 AND barbearia_id = $2`, [profId, req.barbearia.id]);
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
    const r = await db.query(`DELETE FROM assinantes WHERE barbearia_id = $1 AND status = 'cancelado'`, [req.barbearia.id]);
    res.json({ sucesso: true, apagados: r.rowCount });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao apagar cancelados" }); }
});

// ── AÇÕES DO ASSINANTE ────────────────────────────────────────────────────

app.put("/api/:slug/assinantes/:id/:acao", verificarAssinatura, async (req, res) => {
  const id   = Number(req.params.id);
  const acao = req.params.acao;
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  const acoesValidas = ["confirmar", "usar-corte", "renovar", "cancelar"];
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
        `UPDATE assinantes SET status = 'ativo', cortes_usados = 0, data_inicio = NOW(), data_vencimento = NOW() + INTERVAL '30 days' WHERE id = $1`,
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
        `UPDATE assinantes SET status = 'aguardando', cortes_usados = 0, data_inicio = NULL, data_vencimento = NULL WHERE id = $1`,
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

// ── SERVIÇOS DESTAQUE (vitrine) ───────────────────────────────────────────

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
      `INSERT INTO servicos_destaque (barbearia_id, nome, descricao, preco, ordem, imagem) VALUES ($1, $2, $3, $4, $5, $6)`,
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
      `UPDATE servicos_destaque SET nome = $1, descricao = $2, preco = $3, ordem = $4, imagem = $5
       WHERE id = $6 AND barbearia_id = $7`,
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
  const { percentual, valor_fixo } = req.body;
  const pct = Number(percentual);
  const vfx = Number(valor_fixo);
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

  if (data_fim && /^\d{4}-\d{2}-\d{2}$/.test(data_fim) && data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
    dataInicio = data; dataFim = data_fim; referenciaAjustes = data.substring(0, 7);
  } else if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) {
    dataInicio = data; dataFim = data; referenciaAjustes = data.substring(0, 7);
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
    const check = await db.query(`SELECT id FROM profissionais WHERE id = $1 AND barbearia_id = $2`, [profId, req.barbearia.id]);
    if (check.rows.length === 0) return res.status(404).json({ erro: "Profissional não encontrado" });
    await db.query(
      `INSERT INTO comissao_ajustes (barbearia_id, profissional_id, descricao, valor, referencia_mes) VALUES ($1, $2, $3, $4, $5)`,
      [req.barbearia.id, profId, descricao.trim(), Number(valor), referencia_mes]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.status(500).json({ erro: "Erro ao salvar ajuste" }); }
});

app.delete("/api/:slug/comissoes/ajuste/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });
  try {
    await db.query(`DELETE FROM comissao_ajustes WHERE id = $1 AND barbearia_id = $2`, [id, req.barbearia.id]);
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
      sucesso: true,
      slug: barbSlug,
      painel: `/${barbSlug}/admin`,
      agendamento: `/${barbSlug}`
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

// ── BANCO + START ─────────────────────────────────────────────────────────

db.query("SELECT NOW()")
  .then(r => console.log("✅ PostgreSQL conectado:", r.rows[0].now))
  .catch(e => console.log("❌ Erro conexão banco:", e.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor multi-tenant na porta ${PORT}`));