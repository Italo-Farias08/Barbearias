window.login = async function () {
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const msg = document.getElementById("msg");

  msg.style.color = "#ff4d4d";
  msg.innerText = "";

  if (!username || !password) {
    msg.innerText = "Preencha todos os campos";
    return;
  }

  try {
    const slug = new URLSearchParams(window.location.search).get("b");
    localStorage.setItem("slug", slug);

    const res = await fetch(`${BASE_URL}/api/${slug}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (data.erro) {
      msg.innerText = data.erro;
      return;
    }

    localStorage.setItem("token", data.token);

    msg.style.color = "#ffcc00";
    msg.innerText = "Login aprovado...";

    setTimeout(() => {
      window.location.href = `painel.html?b=${slug}`;
    }, 800);

  } catch (err) {
    console.log(err);
    msg.innerText = "Erro no servidor: " + err.message;
  }
};