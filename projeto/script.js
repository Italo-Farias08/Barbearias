(function(){
  const canvas=document.getElementById('particles');
  const ctx=canvas.getContext('2d');
  let W,H,pts=[];
  function resize(){W=canvas.width=window.innerWidth;H=canvas.height=window.innerHeight;}
  resize(); window.addEventListener('resize',resize);
  function rand(a,b){return a+Math.random()*(b-a);}
  for(let i=0;i<50;i++) pts.push({x:rand(0,1),y:rand(0,1),size:rand(.5,1.8),speed:rand(.00008,.00022),alpha:rand(.12,.45),drift:rand(-.0001,.0001)});
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

/* BADGE */
const valorServico=Number(localStorage.getItem('valorServico'))||0;
const nomeServico=localStorage.getItem('nomeServico')||'';
if(nomeServico)  document.getElementById('nomeServicoDisplay').textContent=nomeServico;
if(valorServico) document.getElementById('valorServicoDisplay').textContent='R$'+valorServico;

/* NOTIFICAÇÃO */
function mostrarMensagem(texto,cor){
  cor=cor||'#c9a84c';
  const el=document.createElement('div');
  el.className='notif';el.textContent=texto;el.style.background=cor;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  setTimeout(()=>{el.classList.remove('show');setTimeout(()=>el.remove(),500);},2600);
}

/* FORMATA TELEFONE — remove tudo exceto dígitos */
function limparTelefone(tel){
  return tel.replace(/\D/g,'');
}

/* MASCARA TELEFONE ao digitar */
document.getElementById('telefoneCliente').addEventListener('input',function(){
  let v=this.value.replace(/\D/g,'');
  if(v.length>11) v=v.slice(0,11);
  if(v.length<=2)       this.value=v.replace(/(\d{0,2})/,'($1');
  else if(v.length<=7)  this.value=v.replace(/(\d{2})(\d{0,5})/,'($1) $2');
  else if(v.length<=11) this.value=v.replace(/(\d{2})(\d{1})(\d{0,4})(\d{0,4})/,'($1) $2 $3-$4');
});

/* API */
const API=
  window.location.hostname==='localhost'||window.location.hostname==='127.0.0.1'
    ?'http://127.0.0.1:3000'
    :'https://barbearias-muti-tenant.onrender.com';

const diasDiv=document.getElementById('dias');
const horariosDiv=document.getElementById('horarios');
const botao=document.querySelector('.btn-confirmar');
const modal=document.getElementById('modalNome');
const inputNome=document.getElementById('nomeCliente');
const inputTel=document.getElementById('telefoneCliente');
const confirmarNomeBtn=document.getElementById('confirmarNome');

let dataSelecionada=null;
let horarioSelecionado=null;


const horarios = [
  "08:00","09:00","10:00","11:00","12:00",
  "13:00","14:00","15:00","16:00","17:00",
  "18:00","19:00","20:00","21:00",
  "23:59" // 🔥 horário fake pra teste
];

const nomesDias=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const meses=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const hoje=new Date();

/* GERAR DIAS */
function gerarProximosDias(qtd){
  qtd=qtd||10;diasDiv.innerHTML='';
  for(let i=0;i<qtd;i++){
    const data=new Date();data.setDate(hoje.getDate()+i);
    if(data.getDay()===0) continue;
    const div=document.createElement('div');
    div.classList.add('dia');
    div.dataset.label=`${data.getDate()} de ${meses[data.getMonth()]}`;
    div.innerHTML=`<small>${nomesDias[data.getDay()]}</small><strong>${data.getDate()}</strong><span>${meses[data.getMonth()]}</span>`;
    div.onclick=()=>selecionarDia(div,data);
    diasDiv.appendChild(div);
  }
}

/* SELECIONAR DIA */
function selecionarDia(elemento,data){
  document.querySelectorAll('.dia').forEach(d=>d.classList.remove('selecionado'));
  elemento.classList.add('selecionado');
  dataSelecionada=data;horarioSelecionado=null;
  document.getElementById('resumo').classList.remove('visivel');
  botao.disabled=true;

  const dataFormatada=data.toISOString().split('T')[0];
  horariosDiv.innerHTML='<div class="loading-txt">Carregando horários...</div>';

  fetch(`${API}/agendamentos/data/${dataFormatada}`)
    .then(res=>{if(!res.ok) throw new Error();return res.json();})
    .then(ocupados=>{
      const horariosOcupados=Array.isArray(ocupados)?ocupados.map(h=>h.horario).filter(Boolean):[];
      renderizarHorarios(horariosOcupados);
    })
    .catch(()=>renderizarHorarios([]));
}

/* RENDERIZAR HORÁRIOS */
function renderizarHorarios(horariosOcupados){
  horariosDiv.innerHTML='';
  const agora=new Date();
  horarios.forEach(h=>{
    const btn=document.createElement('div');
    btn.classList.add('horario');btn.textContent=h;
    const [hora,minuto]=h.split(':');
    const dataHora=new Date(dataSelecionada);
    dataHora.setHours(hora,minuto,0,0);
    const jaPassou=dataHora<agora;
    const ocupado=horariosOcupados.includes(h);
    if(ocupado||jaPassou){
      btn.textContent+=' ✕';
      btn.style.opacity='.3';
      btn.style.pointerEvents='none';
      btn.style.textDecoration='line-through';
    } else {
      btn.onclick=()=>selecionarHorario(btn);
    }
    horariosDiv.appendChild(btn);
  });
}

/* SELECIONAR HORÁRIO */
function selecionarHorario(elemento){
  document.querySelectorAll('.horario').forEach(h=>h.classList.remove('selecionado'));
  elemento.classList.add('selecionado');
  horarioSelecionado=elemento.textContent.replace(' ✕','').trim();

  const diaSel=document.querySelector('.dia.selecionado');
  document.getElementById('resumoServico').textContent=nomeServico||'—';
  document.getElementById('resumoData').textContent=diaSel?diaSel.dataset.label:'—';
  document.getElementById('resumoHora').textContent=horarioSelecionado;
  document.getElementById('resumoValor').textContent=valorServico?'R$'+valorServico:'—';
  document.getElementById('resumo').classList.add('visivel');
  botao.disabled=false;
}

/* BOTÃO CONFIRMAR */
botao.addEventListener('click',()=>{
  if(!dataSelecionada||!horarioSelecionado){mostrarMensagem('⚠️ Selecione dia e horário!','#e05050');return;}
  modal.classList.add('aberto');
  setTimeout(()=>inputNome.focus(),300);
});

/* CANCELAR */
document.getElementById('cancelarModal').addEventListener('click',()=>modal.classList.remove('aberto'));

/* CONFIRMAR NOME + TELEFONE */
confirmarNomeBtn.addEventListener('click',()=>{
  const nome=inputNome.value.trim();
  const telefoneRaw=inputTel.value.trim();
  const telefone=limparTelefone(telefoneRaw);

  if(!nome){mostrarMensagem('Digite seu nome!','#e05050');inputNome.focus();return;}
  if(!telefone||telefone.length<10){mostrarMensagem('Digite um WhatsApp válido!','#e05050');inputTel.focus();return;}
  if(!valorServico){mostrarMensagem('Selecione um serviço!','#e05050');return;}

  const dataFormatada=dataSelecionada.toISOString().split('T')[0];
  const horarioFinal=horarioSelecionado;

  /* WhatsApp do barbeiro — abre imediato */
  const numeroBarbeiro='5581991204180';
  const mensagem=`🧾 *AGENDAMENTO CONFIRMADO*\n\n👤 Nome: ${nome}\n📱 WhatsApp: ${telefone}\n💰 Serviço: R$${valorServico}\n📅 Data: ${dataFormatada}\n⏰ Horário: ${horarioFinal}\n\n💈 Novo agendamento recebido!`;
  window.open(`https://api.whatsapp.com/send?phone=${numeroBarbeiro}&text=${encodeURIComponent(mensagem)}`,'_blank');

  /* Salva no back com telefone */
  fetch(`${API}/agendar`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({nome,telefone,data:dataFormatada,horario:horarioFinal,valor:valorServico})
  })
    .then(res=>res.json())
    .then(res=>{
      modal.classList.remove('aberto');
      if(res.erro){mostrarMensagem(res.erro,'#e05050');return;}
      mostrarMensagem('✅ Agendado com sucesso!');
    })
    .catch(()=>mostrarMensagem('Erro ao agendar!','#e05050'));
});

/* Enter nos inputs */
inputNome.addEventListener('keydown',e=>{if(e.key==='Enter') inputTel.focus();});
inputTel.addEventListener('keydown', e=>{if(e.key==='Enter') confirmarNomeBtn.click();});

gerarProximosDias();