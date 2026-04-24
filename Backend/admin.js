// admin.js — cria admin usando PostgreSQL (igual server.js)

require("dotenv").config();
const db = require("./db");
const bcrypt = require("bcrypt");

async function criarAdmin() {
  try {
    const username = "admin";
    const senha = "123";

    // hash da senha (SEGURANÇA REAL)
    const senhaHash = await bcrypt.hash(senha, 10);

    // cria tabela se não existir (opcional mas útil)
    await db.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      );
    `);

    // insere ou atualiza admin
    await db.query(
      `
      INSERT INTO admins (username, password)
      VALUES ($1, $2)
      ON CONFLICT (username)
      DO UPDATE SET password = EXCLUDED.password;
      `,
      [username, senhaHash]
    );

    console.log("✅ Admin criado/atualizado com sucesso!");
    console.log("👤 Login:", username);
    console.log("🔑 Senha:", senha);

    process.exit();
  } catch (err) {
    console.error("❌ Erro ao criar admin:", err.message);
    process.exit(1);
  }
}

criarAdmin();