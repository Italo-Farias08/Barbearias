(function(){
  const canvas=document.getElementById('particles'),
        ctx=canvas.getContext('2d');

  ctx.filter = 'blur(1.5px)'; // efeito desfocado

  let W,H,pts=[];

  function resize(){
    W=canvas.width=window.innerWidth;
    H=canvas.height=window.innerHeight;
  }

  resize();
  window.addEventListener('resize',resize);

  function rand(a,b){return a+Math.random()*(b-a);}

  for(let i=0;i<50;i++) 
    pts.push({
      x:rand(0,1),
      y:rand(0,1),
      size:rand(.6,2),
      speed:rand(.00008,.00018),
      alpha:rand(.05,.18), // mais suave
      drift:rand(-.0001,.0001)
    });

  (function draw(){
    ctx.clearRect(0,0,W,H);

    pts.forEach(p=>{
      p.y-=p.speed;
      p.x+=p.drift;

      if(p.y<0){
        p.y=1;
        p.x=rand(0,1);
      }

      if(p.x<0||p.x>1)
        p.x=rand(0,1);

      ctx.beginPath();
      ctx.arc(p.x*W,p.y*H,p.size,0,Math.PI*2);

      ctx.fillStyle = `rgba(240,240,240,${p.alpha})`; // branco suave
      ctx.fill();
    });

    requestAnimationFrame(draw);
  })();
})();
/* TOAST */
function toast(texto, cor){
  cor=cor||'#4caf7a';
  const el=document.createElement('div');
  el.className='toast'; el.textContent=texto; el.style.background=cor;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(),500); },2800);
}

/* CONTADOR ANIMADO */
function animarValor(el, destino, duracao){
  duracao=duracao||1200;
  const inicio=performance.now();
  const isNeg=destino<0;
  const abs=Math.abs(destino);
  (function tick(agora){
    const p=Math.min((agora-inicio)/duracao,1);
    const ease=1-Math.pow(1-p,3);
    const val=abs*ease;
    el.textContent=(isNeg?'-':'')+'R$ '+val.toFixed(2).replace('.',',');
    if(p<1) requestAnimationFrame(tick);
    else el.textContent=(isNeg?'-':'')+'R$ '+abs.toFixed(2).replace('.',',');
  })(inicio);
}

/* API */


const ganhosEl  = document.getElementById('ganhos');
const gastosEl  = document.getElementById('gastos');
const lucroEl   = document.getElementById('lucro');
const semanaEl  = document.getElementById('semana');
const mesEl     = document.getElementById('mes');
const qtdEl     = document.getElementById('qtdGastos');
const listaEl   = document.getElementById('lista');

/* LUCRO */
async function carregarLucro(){
  try {
    const res  = await fetch(`${API}/lucro-real`);
    const data = await res.json();
    const ganhos = Number(data.ganhos)||0;
    const gastos = Number(data.gastos)||0;
    const lucro  = Number(data.lucro)||0;
    animarValor(ganhosEl, ganhos);
    animarValor(gastosEl, gastos);
    animarValor(lucroEl,  lucro, 1400);
    lucroEl.className='lucro-val'+(lucro<0?' negativo':'');
  } catch(err){ console.error('Erro lucro:',err); }
}

/* SEMANA */
async function carregarSemana(){
  try {
    const res  = await fetch(`${API}/lucro-semana`);
    const data = await res.json();
    semanaEl.textContent='R$ '+Number(data.lucro||0).toFixed(2).replace('.',',');
  } catch { semanaEl.textContent='—'; }
}

/* MÊS */
async function carregarMes(){
  try {
    const res  = await fetch(`${API}/lucro-mes`);
    const data = await res.json();
    mesEl.textContent='R$ '+Number(data.lucro||0).toFixed(2).replace('.',',');
  } catch { mesEl.textContent='—'; }
}

/* ADICIONAR GASTO */
function addGasto(){
  const desc  = document.getElementById('desc').value.trim();
  const valor = document.getElementById('valor').value;
  if(!desc||!valor){ toast('Preencha descrição e valor','#c9a84c'); return; }

  fetch(`${API}/gastos`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({descricao:desc, valor})
  })
  .then(res=>res.json())
  .then(data=>{
    if(data.erro){ toast('Erro: '+data.erro,'#e05050'); return; }
    document.getElementById('desc').value='';
    document.getElementById('valor').value='';
    toast('✓ Gasto registrado!','#c9a84c');
    atualizarTudo();
  })
  .catch(err=>{ console.error(err); toast('Erro ao salvar','#e05050'); });
}

/* LISTAR GASTOS */
async function carregarGastos(){
  listaEl.innerHTML='<div class="loading-state"><div class="spin"></div>Carregando...</div>';
  try {
    const res   = await fetch(`${API}/gastos`);
    const dados = await res.json();

    listaEl.innerHTML='';

    /* ✅ qtdGastos agora existe no HTML — sem erro */
    if(qtdEl) qtdEl.textContent=dados.length;

    if(dados.length===0){
      listaEl.innerHTML=`<div class="empty"><div class="empty-icon">📭</div><div class="empty-txt">Nenhum gasto registrado</div></div>`;
      return;
    }

    dados.forEach((g,i)=>{
      const div=document.createElement('div');
      div.classList.add('item');
      div.style.animationDelay=(i*0.04)+'s';
      div.innerHTML=`
        <div class="item-info">
          <div class="item-desc">${g.descricao}</div>
          <div class="item-meta">ID #${g.id}</div>
        </div>
        <div class="item-right">
          <div class="item-valor">− R$${Number(g.valor).toFixed(2).replace('.',',')}</div>
          <button class="btn-del" onclick="deletarGasto(${g.id})" title="Remover">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 10L10 2M2 2l8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      `;
      listaEl.appendChild(div);
    });
  } catch(err){
    console.error('Erro gastos:',err);
    listaEl.innerHTML=`<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-txt">Erro ao carregar gastos</div></div>`;
  }
}

/* DELETAR GASTO */
function deletarGasto(id){
  fetch(`${API}/gastos/${id}`,{method:'DELETE'})
    .then(()=>{ toast('Gasto removido','#c9a84c'); atualizarTudo(); })
    .catch(err=>console.error(err));
}

/* ATUALIZA TUDO */
function atualizarTudo(){
  carregarLucro();
  carregarGastos();
  carregarSemana();
  carregarMes();
}

document.getElementById('valor').addEventListener('keydown',e=>{ if(e.key==='Enter') addGasto(); });
document.getElementById('desc').addEventListener('keydown', e=>{ if(e.key==='Enter') document.getElementById('valor').focus(); });

atualizarTudo();