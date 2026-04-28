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


const lista = document.getElementById('lista');
let concluidos = []; // cache local

/* FORMATA DATA */
function formatarData(dataStr){
  if(!dataStr) return '—';
  const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [y,m,d]=dataStr.split('-');
  return `${parseInt(d)} ${meses[parseInt(m)-1]} ${y}`;
}

/* STATS */
function atualizarStats(dados){
  const total = dados.length;
  const valor = dados.reduce((s,a)=>s+(Number(a.valor)||0),0);
  const ticket = total>0 ? Math.round(valor/total) : 0;

  document.getElementById('statTotal').textContent = total;
  document.getElementById('statValor').textContent = 'R$'+valor;
  document.getElementById('statTicket').textContent = 'R$'+ticket;
}

/* CARREGAR */
function carregarConcluidos(){
  lista.innerHTML='<div class="loading-state"><div class="spin"></div>Carregando histórico...</div>';

  fetch(`${API}/agendamentos`)
    .then(res=>res.json())
    .then(dados=>{
      lista.innerHTML='';

      concluidos = dados.filter(a =>
  (a.status || '').toLowerCase().includes('conclu')
);

      atualizarStats(concluidos);

      if(concluidos.length===0){
        lista.innerHTML=`
          <div class="empty">
            <div class="empty-icon">📋</div>
            <div class="empty-txt">Nenhum agendamento concluído ainda</div>
          </div>`;
        return;
      }

      concluidos.forEach((item,i)=>{
        const card=document.createElement('div');
        card.classList.add('card');
        card.style.animationDelay=(i*0.05)+'s';

        const horario=(item.horario||'').toString().substring(0,5);

        card.innerHTML=`
          <div class="info">
            <div class="info-item">
              <span class="info-label">Cliente</span>
              <span class="info-val"><strong>${item.nome||'—'}</strong></span>
            </div>
            <div class="info-item">
              <span class="info-label">Data</span>
              <span class="info-val">${formatarData(item.data)}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Horário</span>
              <span class="info-val">${horario||'—'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Status</span>
              <span class="info-val"><span class="status-tag">Concluído</span></span>
            </div>
          </div>
          <div class="valor-tag">R$${item.valor||0}</div>
        `;

        lista.appendChild(card);
      });
    })
    .catch(err=>{
      console.error('ERRO:',err);
      lista.innerHTML=`<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-txt">Erro ao carregar dados</div></div>`;
    });
}

/* CONFIRM MODAL */
function confirmarApagar(){
  if(concluidos.length===0){ toast('Nada para apagar','#c9a84c'); return; }
  document.getElementById('confirmOverlay').classList.add('aberto');
  document.getElementById('progressWrap').style.display='none';
  document.getElementById('confirmActions').style.display='flex';
}

function fecharConfirm(){
  document.getElementById('confirmOverlay').classList.remove('aberto');
}

/* ─────────────────────────────────────────────────────────
   FIX DO BUG: a rota DELETE /agendamentos/concluidos no
   Express é interceptada por DELETE /agendamentos/:id
   (o Express lê "concluidos" como o parâmetro :id).
   
   SOLUÇÃO: buscar os IDs dos concluídos e deletar um a um
   usando DELETE /agendamentos/:id — que já funciona 100%.
───────────────────────────────────────────────────────── */
async function executarApagar(){
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressTxt  = document.getElementById('progressTxt');
  const confirmActions = document.getElementById('confirmActions');

  if(concluidos.length===0){ fecharConfirm(); return; }

  // mostra barra de progresso
  confirmActions.style.display='none';
  progressWrap.style.display='block';

  let deletados=0;
  const total=concluidos.length;

  for(const item of concluidos){
    try {
      await fetch(`${API}/agendamentos/${item.id}`,{ method:'DELETE' });
    } catch(err){
      console.error('Erro ao deletar id',item.id,err);
    }
    deletados++;
    const pct = Math.round((deletados/total)*100);
    progressFill.style.width = pct+'%';
    progressTxt.textContent = `Apagando ${deletados} de ${total}...`;
  }

  fecharConfirm();
  toast(`✓ ${total} registro${total>1?'s':''} apagado${total>1?'s':''}!`);
  carregarConcluidos();
}

/* INIT */
carregarConcluidos();