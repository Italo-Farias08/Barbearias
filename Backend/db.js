const { Pool } = require("pg");

const db = new Pool({
  user: "postgres",
  host: "localhost",
  database: "barber",
  password: "ZinksggZ2",
  port: 5432,
});

module.exports = db;