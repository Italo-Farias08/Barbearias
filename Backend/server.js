const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();

app.use(express.json());
app.use(cors());

app.get("/teste", (req, res) => {
  res.json({ ok: true });
});

// =========================
// AGENDAR
// =========================
app.post("/agendar", async (req, res) => {
  const { nome, data, horario, valor } = req.body;

  try {
    const existe = await db.query(
      `SELECT id FROM agendamentos 
       WHERE data = $1 AND horario = $2 AND status = 'pendente'`,
      [data, horario]
    );

    if (existe.rows.length > 0) {
      return res.json({ erro: "Horário já ocupado!" });
    }

    await db.query(
      `INSERT INTO agendamentos (nome, data, horario, valor)
       VALUES ($1, $2, $3, $4)`,
      [nome, data, horario, Number(valor) || 0]
    );

    res.json({ sucesso: true });

  } catch (err) {
    console.log(err);
    res.json({ erro: "Erro ao agendar" });
  }
});

// =========================
// LISTAR TODOS
// =========================
app.get("/agendamentos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM agendamentos ORDER BY id DESC`
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// =========================
// HORÁRIOS OCUPADOS
// =========================
app.get("/agendamentos/data/:data", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT TRIM(horario) AS horario
       FROM agendamentos
       WHERE data = $1 AND status = 'pendente'`,
      [req.params.data]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

// =========================
// CONCLUIR
// =========================
app.put("/agendamentos/concluir/:id", async (req, res) => {
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'concluido' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.log(err);
    res.json({ erro: "Erro ao concluir" });
  }
});

// =========================
// ⚠️ APAGAR CONCLUÍDOS — DEVE VIR ANTES DE DELETE /:id
// Se ficar depois, Express interpreta "concluidos" como :id
// =========================
app.delete("/agendamentos/concluidos", async (req, res) => {
  try {
    console.log("🔥 DELETE CONCLUÍDOS CHAMADO");
    const result = await db.query(
      `DELETE FROM agendamentos WHERE status = 'concluido'`
    );
    console.log("RESULT:", result.rowCount);
    res.json({ sucesso: true });
  } catch (err) {
    console.log("ERRO REAL:", err);
    res.json({ erro: "Erro ao apagar concluídos" });
  }
});

// =========================
// CANCELAR (vem DEPOIS de /concluidos)
// =========================
app.delete("/agendamentos/:id", async (req, res) => {
  try {
    await db.query(
      `UPDATE agendamentos SET status = 'cancelado' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao cancelar" });
  }
});

// =========================
// LOGIN
// =========================
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "admin" && password === "123") {
    return res.json({ token: "token_fake_123" });
  }

  return res.status(401).json({ erro: "Usuário ou senha inválidos" });
});

// =========================
// GASTOS — SALVAR
// =========================
app.post("/gastos", async (req, res) => {
  const { descricao, valor } = req.body;

  try {
    await db.query(
      `INSERT INTO gastos (descricao, valor) VALUES ($1, $2)`,
      [descricao, Number(valor)]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao salvar gasto" });
  }
});

// =========================
// GASTOS — LISTAR
// =========================
app.get("/gastos", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM gastos ORDER BY id DESC`
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});
app.delete("/gastos/:id", async (req, res) => {
  try {
    await db.query(
      `DELETE FROM gastos WHERE id = $1`,
      [req.params.id]
    );
    res.json({ sucesso: true });
  } catch {
    res.json({ erro: "Erro ao deletar" });
  }
});
app.get("/lucro-real", async (req, res) => {
  try {
    const ganhos = await db.query(
      `SELECT SUM(valor) as total FROM agendamentos WHERE status = 'concluido'`
    );
    const gastos = await db.query(
      `SELECT SUM(valor) as total FROM gastos`
    );
    const totalGanhos = Number(ganhos.rows[0].total) || 0;
    const totalGastos = Number(gastos.rows[0].total) || 0;
    res.json({
      ganhos: totalGanhos,
      gastos: totalGastos,
      lucro: totalGanhos - totalGastos
    });
  } catch (err) {
    console.log(err);
    res.json({ ganhos: 0, gastos: 0, lucro: 0 });
  }
});
db.query("SELECT NOW()")
  .then(res => console.log("✅ Banco conectado:", res.rows))
  .catch(err => console.log("❌ Erro conexão:", err));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta", PORT);
});