// db.js — conexão com PostgreSQL usando a lib "pg"
//
// INSTALE (uma vez):
//   npm install pg
//
// Configure a variável de ambiente DATABASE_URL no Render/Railway:
//   DATABASE_URL=postgresql://usuario:senha@host:5432/banco
//
// Rodando LOCAL: crie um .env com DATABASE_URL e use dotenv,
// ou exporte a variável no terminal antes de rodar:
//   export DATABASE_URL="postgresql://postgres:senha@localhost:5432/barber"
 
const { Pool } = require("pg");
 
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL é obrigatório no Render, Railway, Neon, Supabase etc.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});
 
pool.on("error", (err) => {
  console.error("❌ Erro inesperado no pool PostgreSQL:", err.message);
});
 
module.exports = {
  query: (text, params) => pool.query(text, params)
};
 