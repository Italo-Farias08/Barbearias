// server.js — Multi-tenant PostgreSQL + WhatsApp via Baileys
//
// ============================================================
// POR QUE BAILEYS E NÃO whatsapp-web.js?
//
// whatsapp-web.js usa Puppeteer + Chrome para simular o
// WhatsApp Web. Na nuvem (Render, Railway) isso quebra porque:
//   1. Chrome não está instalado por padrão
//   2. O Render mata processos ociosos — a sessão some
//   3. Usa ~500MB de RAM só pro Chrome
//
// Baileys conecta direto ao protocolo do WhatsApp (igual o
// app oficial), sem Chrome, sem Puppeteer. Usa ~30MB de RAM
// e funciona perfeitamente no Render/Railway.
//
// INSTALE (uma vez no terminal):
//   npm install @whiskeysockets/baileys qrcode-terminal
//
// COMO USAR:
//   1. node server.js
//   2. QR Code aparece no terminal (ou nos logs do Render)
//   3. WhatsApp no celular → Dispositivos conectados → Conectar
//   4. A sessão fica salva na pasta ./auth_info_baileys
//      (persiste entre reinicializações)
// ============================================================
require("dotenv").config();
const bcrypt = require("bcrypt");
const express = require("express");
const cors    = require("cors");
const db      = require("./db");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());
app.use(cors());

// 🔥 BLOQUEIO AQUI
app.use((req, res, next) => {
  if (
    req.path.startsWith("/api") ||
    req.path === "/teste" ||
    req.path === "/whatsapp-status"
  ) {
    return next();
  }

  console.log("⚠️ Tentativa:", req.path);
  return res.status(403).json({ erro: "Acesso bloqueado" });
});

// ============================================================
// WHATSAPP COM BAILEYS
// ============================================================
let waSocket   = null;   // conexão ativa
let waConectado = false;  // true quando pronto pra mandar msg

async function iniciarWhatsApp() {
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion
    } = require("@whiskeysockets/baileys");

    const qrcode = require("qrcode-terminal");

    // Pasta onde a sessão fica salva (persiste entre reinícios)
    const AUTH_DIR = "./auth_info_baileys";
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,   // vamos imprimir manualmente
      logger: require("pino")({ level: "silent" }) // silencia logs internos
    });

    // ── EVENTOS ──────────────────────────────────────────────

    waSocket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {

      // QR code gerado — imprime no terminal / logs do Render
      if (qr) {
        console.log("\n╔══════════════════════════════════════╗");
        console.log("║  ESCANEIE O QR CODE NO SEU WHATSAPP  ║");
        console.log("╚══════════════════════════════════════╝\n");
        qrcode.generate(qr, { small: true });
        console.log("\nWhatsApp → ⋮ → Dispositivos conectados → Conectar\n");
        console.log("(No Render: veja os logs em tempo real para ver o QR)\n");
      }

      if (connection === "open") {
        waConectado = true;
        console.log("✅ WhatsApp conectado! Lembretes automáticos ativos.");
      }

      if (connection === "close") {
        waConectado = false;
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const { Boom } = require("@hapi/boom");
        const deveReconectar = codigo !== DisconnectReason.loggedOut;

        console.log(`⚠️  WhatsApp desconectado. Código: ${codigo}`);

        if (deveReconectar) {
          console.log("🔄 Reconectando em 5s...");
          setTimeout(iniciarWhatsApp, 5000);
        } else {
          console.log("❌ Sessão encerrada. Delete a pasta auth_info_baileys e reinicie.");
          waConectado = false;
        }
      }
    });

    // Salva credenciais sempre que atualizar
    waSocket.ev.on("creds.update", saveCreds);

  } catch (err) {
    // Se Baileys não estiver instalado, avisa e segue sem WA
    if (err.code === "MODULE_NOT_FOUND") {
      console.log("ℹ️  Baileys não instalado — WhatsApp desativado.");
      console.log("    Para ativar: npm install @whiskeysockets/baileys qrcode-terminal pino");
    } else {
      console.error("Erro ao iniciar WhatsApp:", err.message);
      setTimeout(iniciarWhatsApp, 10000); // tenta de novo em 10s
    }
  }
}

iniciarWhatsApp();

// ============================================================
// FUNÇÃO QUE ENVIA O LEMBRETE
// ============================================================
async function enviarLembrete(ag) {
  if (!waSocket || !waConectado) {
    console.log(`⚠️  WhatsApp offline — lembrete não enviado para ${ag.nome}`);
    return;
  }

  const telefone = ag.telefone.replace(/\D/g, ""); // só dígitos
  const horario  = ag.horario.substring(0, 5);
  const nomeBarbearia = ag.nome_barbearia || "sua barbearia";

  const mensagem =
    `Olá, ${ag.nome}! 💈\n\n` +
    `Lembrando que seu corte na *${nomeBarbearia}* está marcado para hoje às *${horario}*.\n\n` +
    `Te esperamos! ✂️`;

  // Formato Baileys: 55 + DDD + número + @s.whatsapp.net
  const jid = `55${telefone}@s.whatsapp.net`;

  try {
    await waSocket.sendMessage(jid, { text: mensagem });
    console.log(`✅ Lembrete enviado → ${ag.nome} (${telefone})`);
  } catch (err) {
    console.error(`❌ Erro ao enviar lembrete para ${ag.nome}:`, err.message);
  }
}

// ============================================================
// JOB DE LEMBRETES — verifica a cada 60 segundos
// Dispara ~1 hora antes do agendamento
// ============================================================
async function verificarLembretes() {
  try {
    const agora = new Date();

    const result = await db.query(`
      SELECT
        a.id, a.nome, a.telefone, a.data, a.horario,
        b.nome AS nome_barbearia
      FROM agendamentos a
      JOIN barbearias b ON b.id = a.barbearia_id
      WHERE a.status = 'pendente'
        AND a.telefone IS NOT NULL
        AND a.telefone != ''
        AND (a.lembrete_enviado IS NULL OR a.lembrete_enviado = FALSE)
    `);

    for (const ag of result.rows) {
      // Converte data do banco (pode vir como objeto Date ou string)
      const dataStr = ag.data instanceof Date
        ? ag.data.toISOString().split("T")[0]
        : ag.data;

      const [ano, mes, dia] = dataStr.split("-");
      const [hora, min]     = ag.horario.substring(0, 5).split(":");
      const dataHorario     = new Date(Number(ano), Number(mes) - 1, Number(dia), Number(hora), Number(min), 0);

      const diffMin = (dataHorario - agora) / 60000;

      // Janela entre 55 e 65 min antes (compensa variação do setInterval)
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
// STATUS WHATSAPP — GET /whatsapp-status
// ============================================================
app.get("/whatsapp-status", (req, res) => {
  res.json({ conectado: waConectado });
});

// ============================================================
// TESTE
// ============================================================
app.get("/teste", (req, res) => res.json({ ok: true, modo: "multi-tenant" }));

// ============================================================
// MIDDLEWARE — resolve barbearia pelo slug
// ============================================================
async function resolveBarbearia(req, res, next) {
  try {
    const result = await db.query(
      `SELECT id, nome, slug, telefone FROM barbearias WHERE slug = $1`,
      [req.params.slug]
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
app.use("/api/:slug", resolveBarbearia, verificarAssinatura);

// ============================================================
// CONFIG PÚBLICA DA BARBEARIA — GET /api/:slug/config
// O front chama isso pra pegar nome, cor, cidade etc.
// ============================================================
app.get("/api/:slug/config", resolveBarbearia, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT slug, nome, cidade, horario_func, whatsapp,
              cor_primaria, logo_url
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
app.post("/api/:slug/login", async (req, res) => {
  const { username, password } = req.body;

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
// AGENDAR
// ============================================================
app.post("/api/:slug/agendar", resolveBarbearia, async (req, res) => {
  const { nome, telefone, data, horario, valor } = req.body;
  const barbearia_id = req.barbearia.id;
  try {
    const existe = await db.query(
      `SELECT id FROM agendamentos
       WHERE barbearia_id = $1 AND data = $2 AND horario = $3 AND status = 'pendente'`,
      [barbearia_id, data, horario]
    );
    if (existe.rows.length > 0) return res.json({ erro: "Horário já ocupado!" });
    await db.query(
      `INSERT INTO agendamentos (barbearia_id, nome, telefone, data, horario, valor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [barbearia_id, nome, telefone || null, data, horario, Number(valor) || 0]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao agendar" }); }
});

app.post("/agendar", async (req, res) => {
  const { nome, telefone, data, horario, valor, barbearia_id } = req.body;
  const bid = barbearia_id || 1;
  try {
    const existe = await db.query(
      `SELECT id FROM agendamentos
       WHERE barbearia_id = $1 AND data = $2 AND horario = $3 AND status = 'pendente'`,
      [bid, data, horario]
    );
    if (existe.rows.length > 0) return res.json({ erro: "Horário já ocupado!" });
    await db.query(
      `INSERT INTO agendamentos (barbearia_id, nome, telefone, data, horario, valor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bid, nome, telefone || null, data, horario, Number(valor) || 0]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao agendar" }); }
});

// ============================================================
// LISTAR AGENDAMENTOS
// ============================================================
app.get("/api/:slug/agendamentos", resolveBarbearia, async (req, res) => {
  const { slug } = req.params;

  const permitido = await podeUsarSistema(slug);

  if (!permitido) {
    return res.status(403).json({
      erro: "Assinatura vencida"
    });
  }

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

app.get("/agendamentos", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM agendamentos WHERE barbearia_id = 1 ORDER BY id DESC`);
    res.json(result.rows);
  } catch { res.json([]); }
});

// ============================================================
// HORÁRIOS OCUPADOS
// ============================================================
app.get("/api/:slug/agendamentos/data/:data", resolveBarbearia, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT TRIM(horario) AS horario FROM agendamentos
       WHERE barbearia_id = $1 AND data = $2 AND status = 'pendente'`,
      [req.barbearia.id, req.params.data]
    );
    res.json(result.rows);
  } catch { res.json([]); }
});

app.get("/agendamentos/data/:data", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT TRIM(horario) AS horario FROM agendamentos
       WHERE barbearia_id = 1 AND data = $1 AND status = 'pendente'`,
      [req.params.data]
    );
    res.json(result.rows);
  } catch { res.json([]); }
});

// ============================================================
// CONCLUIR
// ============================================================
app.put("/api/:slug/agendamentos/concluir/:id", resolveBarbearia, async (req, res) => {
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'concluido' WHERE id = $1 AND barbearia_id = $2`,
      [req.params.id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao concluir" }); }
});

app.put("/agendamentos/concluir/:id", async (req, res) => {
  try {
    await db.query(`UPDATE agendamentos SET status = 'concluido' WHERE id = $1`, [req.params.id]);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao concluir" }); }
});

// ============================================================
// ⚠️ APAGAR CONCLUÍDOS — VEM ANTES DE /:id
// ============================================================
app.delete("/api/:slug/agendamentos/concluidos", resolveBarbearia, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM agendamentos WHERE barbearia_id = $1 AND status = 'concluido'`,
      [req.barbearia.id]
    );
    console.log(`Concluídos apagados (${req.params.slug}):`, r.rowCount);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao apagar" }); }
});

app.delete("/agendamentos/concluidos", async (req, res) => {
  try {
    const r = await db.query(`DELETE FROM agendamentos WHERE barbearia_id = 1 AND status = 'concluido'`);
    console.log("Concluídos apagados:", r.rowCount);
    res.json({ sucesso: true });
  } catch (err) { console.error(err); res.json({ erro: "Erro ao apagar" }); }
});

// ============================================================
// CANCELAR — DEPOIS de /concluidos
// ============================================================
app.delete("/api/:slug/agendamentos/:id", resolveBarbearia, async (req, res) => {
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'cancelado' WHERE id = $1 AND barbearia_id = $2`,
      [req.params.id, req.barbearia.id]
    );
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao cancelar" }); }
});

app.delete("/agendamentos/:id", async (req, res) => {
  try {
    await db.query(`UPDATE agendamentos SET status = 'cancelado' WHERE id = $1`, [req.params.id]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao cancelar" }); }
});

// ============================================================
// GASTOS
// ============================================================
app.post("/api/:slug/gastos", resolveBarbearia, async (req, res) => {
  const { descricao, valor } = req.body;
  try {
    await db.query(`INSERT INTO gastos (barbearia_id, descricao, valor) VALUES ($1, $2, $3)`,
      [req.barbearia.id, descricao, Number(valor)]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao salvar gasto" }); }
});

app.post("/gastos", async (req, res) => {
  const { descricao, valor, barbearia_id } = req.body;
  try {
    await db.query(`INSERT INTO gastos (barbearia_id, descricao, valor) VALUES ($1, $2, $3)`,
      [barbearia_id || 1, descricao, Number(valor)]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao salvar gasto" }); }
});

app.get("/api/:slug/gastos", resolveBarbearia, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM gastos WHERE barbearia_id = $1 ORDER BY id DESC`, [req.barbearia.id]);
    res.json(result.rows);
  } catch { res.json([]); }
});

app.get("/gastos", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM gastos WHERE barbearia_id = 1 ORDER BY id DESC`);
    res.json(result.rows);
  } catch { res.json([]); }
});

app.delete("/api/:slug/gastos/:id", resolveBarbearia, async (req, res) => {
  try {
    await db.query(`DELETE FROM gastos WHERE id = $1 AND barbearia_id = $2`, [req.params.id, req.barbearia.id]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao deletar" }); }
});

app.delete("/gastos/:id", async (req, res) => {
  try {
    await db.query(`DELETE FROM gastos WHERE id = $1`, [req.params.id]);
    res.json({ sucesso: true });
  } catch { res.json({ erro: "Erro ao deletar" }); }
});

// ============================================================
// LUCRO REAL
// ============================================================
app.get("/api/:slug/lucro-real", resolveBarbearia, async (req, res) => {
  try {
    const ganhos = await db.query(
      `SELECT COALESCE(SUM(valor),0) AS total FROM agendamentos WHERE barbearia_id = $1 AND status = 'concluido'`,
      [req.barbearia.id]
    );
    const gastos = await db.query(
      `SELECT COALESCE(SUM(valor),0) AS total FROM gastos WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );
    const tg = Number(ganhos.rows[0].total);
    const tga = Number(gastos.rows[0].total);
    res.json({ ganhos: tg, gastos: tga, lucro: tg - tga });
  } catch (err) { console.error(err); res.json({ ganhos: 0, gastos: 0, lucro: 0 }); }
});

app.get("/lucro-real", async (req, res) => {
  try {
    const ganhos = await db.query(`SELECT COALESCE(SUM(valor),0) AS total FROM agendamentos WHERE barbearia_id = 1 AND status = 'concluido'`);
    const gastos = await db.query(`SELECT COALESCE(SUM(valor),0) AS total FROM gastos WHERE barbearia_id = 1`);
    const tg = Number(ganhos.rows[0].total);
    const tga = Number(gastos.rows[0].total);
    res.json({ ganhos: tg, gastos: tga, lucro: tg - tga });
  } catch (err) { console.error(err); res.json({ ganhos: 0, gastos: 0, lucro: 0 }); }
});
app.get("/api/:slug/servicos", resolveBarbearia, async (req, res) => {
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

async function podeUsarSistema(slug) {
  const result = await db.query(
    "SELECT ativo, vencimento FROM barbearias WHERE slug = $1",
    [slug]
  );

  const barb = result.rows[0];

  if (!barb || !barb.vencimento) return false;

  const hoje = new Date();
  const vencimento = new Date(barb.vencimento);

  if (!barb.ativo || hoje > vencimento) {
    return false;
  }

  return true;
}
async function verificarAssinatura(req, res, next) {
  const { slug } = req.params;

  const permitido = await podeUsarSistema(slug);

  if (!permitido) {
    return res.status(403).json({
      erro: "Assinatura vencida"
    });
  }

  next(); // libera se estiver pago
}
app.get('/api/:slug/horarios', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM horarios_barbearia WHERE barbearia_id = $1',
      [req.barbearia.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        hora_inicio: "08:00",
        hora_fim: "21:00",
        intervalo_minutos: 30
      });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar horários" });
  }
});
app.get("/api/:slug/horarios", resolveBarbearia, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM horarios_barbearia WHERE barbearia_id = $1`,
      [req.barbearia.id]
    );

    res.json(result.rows[0] || {});
  } catch (err) {
    console.error(err);
    res.json({});
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