// server.js — Multi-tenant PostgreSQL + WhatsApp via Baileys
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");
const fs      = require("fs");

const app = express();

// ============================================================
// SEGURANÇA — rate limiting e helmet
// npm install express-rate-limit helmet
// ============================================================
const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");

app.use(helmet());

// Limite global: 200 req/min por IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: "Muitas requisições. Tente novamente em 1 minuto." }
}));

// Limite mais restrito para login: 10 tentativas/min por IP
const limiterLogin = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { erro: "Muitas tentativas de login. Aguarde 1 minuto." }
});

app.use(express.json({ limit: "10kb" }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : "*",
  methods: ["GET", "POST", "PUT", "DELETE"]
}));

// ============================================================
// WHATSAPP COM BAILEYS
// ============================================================
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

// ============================================================
// LEMBRETE VIA WHATSAPP
// ============================================================
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

// ============================================================
// JOB DE LEMBRETES — a cada 60s, dispara ~1h antes
// ============================================================
async function verificarLembretes() {
  try {
    const agora = new Date();
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

// ============================================================
// STATUS WHATSAPP
// ============================================================
app.get("/whatsapp-status", (req, res) => {
  res.json({ conectado: waConectado });
});

app.get("/teste", (req, res) => res.json({ ok: true, modo: "multi-tenant" }));

// ============================================================
// HELPERS
// ============================================================

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

// ============================================================
// MIDDLEWARES
// ============================================================
async function resolveBarbearia(req, res, next) {
  const { slug } = req.params;

  if (!slugValido(slug)) {
    return res.status(400).json({ erro: "Slug inválido" });
  }

  try {
    const result = await db.query(
      `SELECT id, nome, slug, telefone FROM barbearias WHERE slug = $1`,
      [slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: "Barbearia não encontrada" });
    }
    req.barbearia = result.rows[0];
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro interno" });
  }
}

async function verificarAssinatura(req, res, next) {
  const permitido = await podeUsarSistema(req.params.slug);
  if (!permitido) {
    return res.status(403).json({ erro: "Assinatura vencida" });
  }
  next();
}

app.use("/api/:slug", resolveBarbearia);

// ============================================================
// CONFIG PÚBLICA DA BARBEARIA
// ============================================================
app.get("/api/:slug/config", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT slug, nome, cidade, horario_func, whatsapp,
              cor_primaria, logo_url, sobre
       FROM barbearias WHERE slug = $1`,
      [req.params.slug]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.json({});
  }
});

// ============================================================
// LOGIN — com rate limit próprio
// ============================================================
app.post("/api/:slug/login", limiterLogin, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password || typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ erro: "Dados inválidos" });
  }
  if (username.length > 50 || password.length > 100) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  try {
    const result = await db.query(
      `SELECT id, username, password, slug
       FROM barbearias
       WHERE slug = $1 AND username = $2`,
      [req.params.slug, username.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ erro: "Usuário ou senha inválidos" });
    }

    const user = result.rows[0];

    // ⚠️  IMPORTANTE: troque para bcrypt quando puder.
    if (password !== user.password) {
      return res.status(401).json({ erro: "Usuário ou senha inválidos" });
    }

    res.json({
      token: `token_${user.slug}_${Date.now()}`,
      slug: user.slug
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro no login" });
  }
});

// ============================================================
// AGENDAR
// ============================================================

// ✅ CORRIGIDO: valida horário usando a data EXATA enviada pelo cliente
// (sem converter para UTC), comparando com o horário de Brasília.
// O servidor pode estar em UTC, mas a data/hora vem do frontend já no fuso certo.
function validarAgendamento({ nome, data, horario, valor }) {
  if (!nome || typeof nome !== "string" || nome.trim().length < 2) return "Nome inválido";
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida";
  if (!horario || !/^\d{2}:\d{2}(:\d{2})?$/.test(horario)) return "Horário inválido";

  // Pega hora atual de Brasília (UTC-3) — independente do fuso do servidor
  const agora = new Date();
  const agoraBrasilia = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

  const [h, m]      = horario.split(":");
  const [ano, mes, dia] = data.split("-");

  // Monta a data/hora do agendamento como se fosse no horário de Brasília
  const dataHorarioBrasilia = new Date(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    Number(h),
    Number(m),
    0
  );

  // Compara: se o horário de Brasília do agendamento já passou, rejeita
  if (dataHorarioBrasilia <= agoraBrasilia) return "Não é possível agendar em horário passado";

  if (valor !== undefined && (isNaN(Number(valor)) || Number(valor) < 0)) return "Valor inválido";
  return null;
}

app.post("/api/:slug/agendar", verificarAssinatura, async (req, res) => {
  const { nome, telefone, data, horario, valor } = req.body;

  const erro = validarAgendamento({ nome, data, horario, valor });
  if (erro) return res.status(400).json({ erro });

  const barbearia_id = req.barbearia.id;
  const horarioLimpo = horario.substring(0, 5);

  try {
    const existe = await db.query(
      `SELECT id FROM agendamentos
       WHERE barbearia_id = $1 AND data = $2 AND horario = $3 AND status = 'pendente'`,
      [barbearia_id, data, horarioLimpo]
    );
    if (existe.rows.length > 0) return res.json({ erro: "Horário já ocupado!" });

    await db.query(
      `INSERT INTO agendamentos (barbearia_id, nome, telefone, data, horario, valor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [barbearia_id, nome.trim(), telefone || null, data, horarioLimpo, Number(valor) || 0]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao agendar" });
  }
});

// ============================================================
// LISTAR AGENDAMENTOS
// ============================================================
app.get("/api/:slug/agendamentos", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM agendamentos WHERE barbearia_id = $1 ORDER BY id DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ============================================================
// HORÁRIOS OCUPADOS POR DATA
// ============================================================
app.get("/api/:slug/agendamentos/data/:data", async (req, res) => {
  const { data } = req.params;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ erro: "Data inválida" });
  }

  try {
    const result = await db.query(
      `SELECT TRIM(horario) AS horario FROM agendamentos
       WHERE barbearia_id = $1 AND data = $2 AND status = 'pendente'`,
      [req.barbearia.id, data]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ============================================================
// HORÁRIOS DA BARBEARIA (configuração)
// ============================================================
app.get("/api/:slug/horarios", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM horarios_barbearia WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );

    res.json(result.rows[0] || {
      hora_inicio: "08:00",
      hora_fim: "21:00",
      intervalo_minutos: 30
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar horários" });
  }
});

// ============================================================
// CONCLUIR AGENDAMENTO
// ============================================================
app.put("/api/:slug/agendamentos/concluir/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });

  try {
    await db.query(
      `UPDATE agendamentos SET status = 'concluido' WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao concluir" });
  }
});

// ============================================================
// APAGAR CONCLUÍDOS — vem antes de /:id
// ============================================================
app.delete("/api/:slug/agendamentos/concluidos", verificarAssinatura, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM agendamentos WHERE barbearia_id = $1 AND status = 'concluido'`,
      [req.barbearia.id]
    );
    console.log(`Concluídos apagados (${req.params.slug}):`, r.rowCount);
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao apagar" });
  }
});

// ============================================================
// CANCELAR AGENDAMENTO
// ============================================================
app.delete("/api/:slug/agendamentos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });

  try {
    await db.query(
      `UPDATE agendamentos SET status = 'cancelado' WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao cancelar" });
  }
});

// ============================================================
// GASTOS
// ============================================================
app.post("/api/:slug/gastos", verificarAssinatura, async (req, res) => {
  const { descricao, valor } = req.body;
  if (!descricao || typeof descricao !== "string" || descricao.trim().length === 0) {
    return res.status(400).json({ erro: "Descrição inválida" });
  }
  if (isNaN(Number(valor)) || Number(valor) < 0) {
    return res.status(400).json({ erro: "Valor inválido" });
  }
  try {
    await db.query(
      `INSERT INTO gastos (barbearia_id, descricao, valor) VALUES ($1, $2, $3)`,
      [req.barbearia.id, descricao.trim(), Number(valor)]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao salvar gasto" });
  }
});

app.get("/api/:slug/gastos", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM gastos WHERE barbearia_id = $1 ORDER BY id DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

app.delete("/api/:slug/gastos/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: "ID inválido" });

  try {
    await db.query(
      `DELETE FROM gastos WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao deletar" });
  }
});

// ============================================================
// LUCRO REAL
// ============================================================
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

// ============================================================
// SERVIÇOS
// ============================================================
app.get("/api/:slug/servicos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT nome, preco, imagem FROM servicos WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});
// ============================================================
// PROFISSIONAIS
// ============================================================
app.get("/api/:slug/profissionais", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, foto_url, especialidade
       FROM profissionais
       WHERE barbearia_id = $1 AND ativo = true
       ORDER BY ordem`,
      [req.barbearia.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ============================================================
// BANCO + START
// ============================================================
db.query("SELECT NOW()")
  .then(r => console.log("✅ PostgreSQL conectado:", r.rows[0].now))
  .catch(e => console.log("❌ Erro conexão banco:", e.message));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor multi-tenant na porta ${PORT}`));