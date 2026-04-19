const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");

const db = new sqlite3.Database("./banco.db");

async function criar() {
  const username = "admin";
  const senha = "123";

  const senhaHash = await bcrypt.hash(senha, 10);

  db.run(
    "INSERT OR REPLACE INTO admins (id, username, password) VALUES (1, ?, ?)",
    [username, senhaHash],
    () => {
      console.log("Admin atualizado!");
      console.log("Login:", username);
      console.log("Senha:", senha);
    }
  );
}

criar();