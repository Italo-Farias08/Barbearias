// server.js — Multi-tenant PostgreSQL + WhatsApp via Baileys
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");
const fs      = require("fs");

const app = express();

// ============================================================
// SEGURANÇA — rate limiting e helmet
// ============================================================
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
              pix_chave,
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
// LOGIN
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
// AGENDAR — CORRIGIDO: salva profissional_id e valida conflito por profissional
// ============================================================
function validarAgendamento({ nome, data, horario, valor }) {
  if (!nome || typeof nome !== "string" || nome.trim().length < 2) return "Nome inválido";
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida";
  if (!horario || !/^\d{2}:\d{2}(:\d{2})?$/.test(horario)) return "Horário inválido";

  const [ano, mes, dia] = data.split("-").map(Number);
  const [h, m]          = horario.split(":").map(Number);

  // Brasília (UTC-3) → UTC = local + 3h
  const agendamentoUTC = Date.UTC(ano, mes - 1, dia, h + 3, m, 0);
  const agoraUTC = Date.now() - 2 * 60 * 1000;

  if (agendamentoUTC <= agoraUTC) return "Não é possível agendar em horário passado";

  if (valor !== undefined && (isNaN(Number(valor)) || Number(valor) < 0)) return "Valor inválido";
  return null;
}

app.post("/api/:slug/agendar", verificarAssinatura, async (req, res) => {
  // ✅ CORRIGIDO: extrai profissional_id do body
  const { nome, telefone, data, horario, valor, profissional_id } = req.body;

  const erro = validarAgendamento({ nome, data, horario, valor });
  if (erro) return res.status(400).json({ erro });

  const barbearia_id = req.barbearia.id;
  const horarioLimpo = horario.substring(0, 5);
  const profId       = profissional_id ? Number(profissional_id) : null;

  try {
    // ✅ CORRIGIDO: verifica conflito separado por profissional
    let queryConflito = `
      SELECT id FROM agendamentos
      WHERE barbearia_id = $1 AND data = $2 AND horario = $3 AND status = 'pendente'
    `;
    const paramsConflito = [barbearia_id, data, horarioLimpo];

    if (profId) {
      queryConflito += ` AND profissional_id = $4`;
      paramsConflito.push(profId);
    }

    const existe = await db.query(queryConflito, paramsConflito);
    if (existe.rows.length > 0) return res.json({ erro: "Horário já ocupado!" });

    // ✅ CORRIGIDO: salva profissional_id no INSERT
    await db.query(
      `INSERT INTO agendamentos
         (barbearia_id, nome, telefone, data, horario, valor, profissional_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [barbearia_id, nome.trim(), telefone || null, data, horarioLimpo, Number(valor) || 0, profId]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao agendar" });
  }
});

// ============================================================
// LISTAR AGENDAMENTOS — CORRIGIDO: traz nome do profissional
// ============================================================
app.get("/api/:slug/agendamentos", verificarAssinatura, async (req, res) => {
  try {
    // ✅ CORRIGIDO: JOIN com profissionais para trazer o nome no painel
    const result = await db.query(
      `SELECT a.*,
              p.nome   AS profissional_nome,
              p.foto_url AS profissional_foto
       FROM agendamentos a
       LEFT JOIN profissionais p ON p.id = a.profissional_id
       WHERE a.barbearia_id = $1
       ORDER BY a.id DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ============================================================
// HORÁRIOS OCUPADOS POR DATA — CORRIGIDO: filtra por profissional
// ============================================================
app.get("/api/:slug/agendamentos/data/:data", async (req, res) => {
  const { data } = req.params;
  // ✅ CORRIGIDO: recebe profissional_id da query string
  const { profissional_id } = req.query;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return res.status(400).json({ erro: "Data inválida" });
  }

  try {
    let query = `
      SELECT TRIM(horario) AS horario FROM agendamentos
      WHERE barbearia_id = $1 AND data = $2 AND status = 'pendente'
    `;
    const params = [req.barbearia.id, data];

    // ✅ CORRIGIDO: filtra por profissional se vier na query string
    if (profissional_id && !isNaN(Number(profissional_id))) {
      query += ` AND profissional_id = $3`;
      params.push(Number(profissional_id));
    }

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// ============================================================
// HORÁRIOS DA BARBEARIA (configuração)
// ============================================================
// ============================================================
// GET HORÁRIOS — retorna config por dia da semana
// ============================================================
app.get("/api/:slug/horarios", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM horarios_barbearia WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    const row = result.rows[0];

    // Se já tem dias_semana configurado, retorna ele
    if (row && row.dias_semana) {
      return res.json(row.dias_semana);
    }

    // Fallback: converte o formato antigo (hora_inicio/hora_fim global)
    // para o novo formato por dia, aplicando o mesmo horário pra todos os dias
    const hi  = (row && row.hora_inicio) ? row.hora_inicio : "08:00";
    const hf  = (row && row.hora_fim)    ? row.hora_fim    : "21:00";
    const intv = (row && row.intervalo_minutos) ? row.intervalo_minutos : 30;

    const fallback = { intervalo_minutos: intv };
    for (let d = 0; d <= 6; d++) {
      fallback[String(d)] = d === 0
        ? { aberto: false }
        : { aberto: true, hora_inicio: hi, hora_fim: hf };
    }
    res.json(fallback);

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar horários" });
  }
});

// ============================================================
// SALVAR HORÁRIOS POR DIA DA SEMANA (painel admin)
// ============================================================
app.post("/api/:slug/horarios", verificarAssinatura, async (req, res) => {
  const config = req.body; // recebe o objeto completo { intervalo_minutos, "0": {...}, "1": {...}, ... }

  if (!config || typeof config !== "object") {
    return res.status(400).json({ erro: "Config inválida" });
  }

  try {
    await db.query(
      `INSERT INTO horarios_barbearia (barbearia_id, dias_semana)
       VALUES ($1, $2)
       ON CONFLICT (barbearia_id)
       DO UPDATE SET dias_semana = $2`,
      [req.barbearia.id, JSON.stringify(config)]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar horários" });
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
      // CORRETO
    `SELECT id, nome, foto_url, especialidade, whatsapp
    FROM profissionais
    WHERE barbearia_id = $1 AND ativo = true
     ORDER BY ordem`
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ============================================================
// PLANOS
// ============================================================
app.get("/api/:slug/planos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, descricao, cortes_mes, valor
       FROM planos
       WHERE barbearia_id = $1 AND ativo = true
       ORDER BY ordem, valor`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ============================================================
// ASSINAR
// ============================================================
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
    if (plano.rows.length === 0)
      return res.status(400).json({ erro: "Plano não encontrado" });

    await db.query(
      `INSERT INTO assinantes (barbearia_id, plano_id, nome, telefone, status)
       VALUES ($1, $2, $3, $4, 'aguardando')`,
      [req.barbearia.id, Number(plano_id), nome.trim(), telefone || null]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao registrar assinatura" });
  }
});

// ============================================================
// LISTAR ASSINANTES
// ============================================================
app.get("/api/:slug/assinantes", verificarAssinatura, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, p.nome AS plano_nome, p.cortes_mes, p.valor AS plano_valor
       FROM assinantes a
       JOIN planos p ON p.id = a.plano_id
       WHERE a.barbearia_id = $1
       ORDER BY
         CASE a.status
           WHEN 'aguardando' THEN 0
           WHEN 'ativo'      THEN 1
           WHEN 'vencido'    THEN 2
           ELSE 3
         END,
         a.criado_em DESC`,
      [req.barbearia.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ============================================================
// APAGAR ASSINANTES CANCELADOS
// ============================================================
app.delete("/api/:slug/assinantes/cancelados", verificarAssinatura, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM assinantes WHERE barbearia_id = $1 AND status = 'cancelado'`,
      [req.barbearia.id]
    );
    console.log(`Assinantes cancelados apagados (${req.params.slug}):`, r.rowCount);
    res.json({ sucesso: true, apagados: r.rowCount });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao apagar cancelados" });
  }
});

// ============================================================
// AÇÕES DO ASSINANTE
// ============================================================
app.put("/api/:slug/assinantes/:id/:acao", verificarAssinatura, async (req, res) => {
  const id   = Number(req.params.id);
  const acao = req.params.acao;

  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ erro: "ID inválido" });

  const acoesValidas = ["confirmar", "usar-corte", "renovar", "cancelar"];
  if (!acoesValidas.includes(acao))
    return res.status(400).json({ erro: "Ação inválida" });

  try {
    const check = await db.query(
      `SELECT a.id, a.status, a.cortes_usados, p.cortes_mes
       FROM assinantes a JOIN planos p ON p.id = a.plano_id
       WHERE a.id = $1 AND a.barbearia_id = $2`,
      [id, req.barbearia.id]
    );
    if (check.rows.length === 0)
      return res.status(404).json({ erro: "Assinante não encontrado" });

    const ass = check.rows[0];

    if (acao === "confirmar") {
      await db.query(
        `UPDATE assinantes
         SET status = 'ativo',
             cortes_usados = 0,
             data_inicio = NOW(),
             data_vencimento = NOW() + INTERVAL '30 days'
         WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }

    if (acao === "usar-corte") {
      if (ass.status !== "ativo")
        return res.json({ erro: "Plano não está ativo" });
      if (ass.cortes_usados >= ass.cortes_mes)
        return res.json({ erro: "Limite de cortes atingido neste mês" });

      await db.query(
        `UPDATE assinantes SET cortes_usados = cortes_usados + 1 WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }

    if (acao === "renovar") {
      await db.query(
        `UPDATE assinantes
         SET status = 'aguardando', cortes_usados = 0,
             data_inicio = NULL, data_vencimento = NULL
         WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }

    if (acao === "cancelar") {
      await db.query(
        `UPDATE assinantes SET status = 'cancelado' WHERE id = $1`,
        [id]
      );
      return res.json({ sucesso: true });
    }

  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao executar ação" });
  }
});
// ============================================================
// SERVIÇOS DESTAQUE (home)
// ============================================================
app.get("/api/:slug/servicos-destaque", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nome, descricao, preco, imagem
       FROM servicos_destaque
       WHERE barbearia_id = $1
       ORDER BY ordem, id`,
      [req.barbearia.id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

app.post("/api/:slug/servicos-destaque", verificarAssinatura, async (req, res) => {
  const { nome, descricao, preco, ordem, imagem } = req.body;

  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });

  if (isNaN(Number(preco)) || Number(preco) < 0)
    return res.status(400).json({ erro: "Preço inválido" });

  try {
    await db.query(
      `INSERT INTO servicos_destaque 
       (barbearia_id, nome, descricao, preco, ordem, imagem)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.barbearia.id,
        nome.trim(),
        descricao || "",
        Number(preco),
        Number(ordem) || 0,
        imagem || null
      ]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao salvar" });
  }
});

app.delete("/api/:slug/servicos-destaque/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ erro: "ID inválido" });

  try {
    await db.query(
      `DELETE FROM servicos_destaque 
       WHERE id = $1 AND barbearia_id = $2`,
      [id, req.barbearia.id]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao deletar" });
  }
});

app.put("/api/:slug/servicos-destaque/:id", verificarAssinatura, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ erro: "ID inválido" });

  const { nome, descricao, preco, ordem, imagem } = req.body;

  if (!nome || typeof nome !== "string" || nome.trim().length === 0)
    return res.status(400).json({ erro: "Nome inválido" });

  if (isNaN(Number(preco)) || Number(preco) < 0)
    return res.status(400).json({ erro: "Preço inválido" });

  try {
    await db.query(
      `UPDATE servicos_destaque
       SET nome = $1, descricao = $2, preco = $3, ordem = $4, imagem = $5
       WHERE id = $6 AND barbearia_id = $7`,
      [
        nome.trim(),
        descricao || "",
        Number(preco),
        Number(ordem) || 0,
        imagem || null,
        id,
        req.barbearia.id
      ]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.json({ erro: "Erro ao atualizar" });
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