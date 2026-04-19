(function(){
  const canvas=document.getElementById('particles');
  const ctx=canvas.getContext('2d');
  let W,H,pts=[];
  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;}
  resize(); window.addEventListener('resize',resize);
  function rand(a,b){return a+Math.random()*(b-a);}
  for(let i=0;i<45;i++) pts.push({x:rand(0,1),y:rand(0,1),size:rand(.4,1.6),speed:rand(.00006,.0002),alpha:rand(.1,.4),drift:rand(-.0001,.0001)});
  (function draw(){
    ctx.clearRect(0,0,W,H);
    pts.forEach(p=>{
      p.y-=p.speed; p.x+=p.drift;
      if(p.y<0){p.y=1;p.x=rand(0,1);}
      if(p.x<0||p.x>1){p.x=rand(0,1);}
      ctx.beginPath();ctx.arc(p.x*W,p.y*H,p.size,0,Math.PI*2);
      ctx.fillStyle=`rgba(201,168,76,${p.alpha})`;ctx.fill();
    });
    requestAnimationFrame(draw);
  })();
})();

/* ENTER no input */
document.addEventListener('keydown', e=>{ if(e.key==='Enter') login(); });

/* LOGIN */
async function login(){
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const msg      = document.getElementById('msg');
  const btn      = document.getElementById('btnLogin');

  // reset msg
  msg.className='msg';
  msg.innerText='';

  if(!username || !password){
    msg.className='msg show erro';
    msg.innerText='Preencha todos os campos';
    return;
  }

  // loading
  btn.classList.add('loading');
  btn.disabled=true;

  try {
    const res = await fetch('https://barber-7p3h.onrender.com/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password})
    });

    const data = await res.json();

    if(data.erro){
      msg.className='msg show erro';
      msg.innerText=data.erro;
      btn.classList.remove('loading'); btn.disabled=false;
      return;
    }

    if(!data.token){
      msg.className='msg show erro';
      msg.innerText='Erro inesperado';
      btn.classList.remove('loading'); btn.disabled=false;
      return;
    }

    localStorage.setItem('token', data.token);

    msg.className='msg show ok';
    msg.innerText='✓ Acesso autorizado...';

    setTimeout(()=>{ window.location.href='painel.html'; }, 900);

  } catch(err){
    console.error(err);
    msg.className='msg show erro';
    msg.innerText='Erro no servidor: '+err.message;
    btn.classList.remove('loading'); btn.disabled=false;
  }
}