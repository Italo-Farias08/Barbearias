/* ══════════════════════════════
   PARTÍCULAS
══════════════════════════════ */
(function(){
  const canvas=document.getElementById('particles'), ctx=canvas.getContext('2d');
  ctx.filter='blur(1.5px)';
  let W,H,pts=[];
  function resize(){ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
  resize(); window.addEventListener('resize',resize);
  function rand(a,b){ return a+Math.random()*(b-a); }
  for(let i=0;i<50;i++)
    pts.push({ x:rand(0,1), y:rand(0,1), size:rand(.6,2), speed:rand(.00008,.00018), alpha:rand(.05,.18), drift:rand(-.0001,.0001) });
  (function draw(){
    ctx.clearRect(0,0,W,H);
    pts.forEach(p=>{
      p.y-=p.speed; p.x+=p.drift;
      if(p.y<0){ p.y=1; p.x=rand(0,1); }
      if(p.x<0||p.x>1) p.x=rand(0,1);
      ctx.beginPath(); ctx.arc(p.x*W,p.y*H,p.size,0,Math.PI*2);
      ctx.fillStyle=`rgba(240,240,240,${p.alpha})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  })();
})();

/* ══════════════════════════════
   TOAST
══════════════════════════════ */
function toast(texto, cor){
  cor = cor || 'var(--gold)';
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = texto; el.style.background = cor;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 500); }, 2800);
}

/* ══════════════════════════════
   HELPERS
══════════════════════════════ */
const lista = document.getElementById('lista');
let _todos = []; // cache local com concluídos + faltas

function formatarData(dataStr){
  if(!dataStr) return '—';
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [y,m,d] = dataStr.split('-');
  return `${parseInt(d)} ${meses[parseInt(m)-1]} ${y}`;
}

function atualizarStats(dados){
  const concluidos = dados.filter(a => a.status === 'concluido' || a.status?.toLowerCase().includes('conclu'));
  const faltas     = dados.filter(a => a.status === 'falta');
  const total      = concluidos.length;
  const valor      = concluidos.reduce((s,a) => s + (Number(a.valor)||0), 0);
  const ticket     = total > 0 ? Math.round(valor / total) : 0;

  document.getElementById('statTotal').textContent  = total;
  document.getElementById('statValor').textContent  = 'R$' + valor;
  document.getElementById('statTicket').textContent = 'R$' + ticket;

  // Atualiza stat de faltas se o elemento existir
  const statFaltas = document.getElementById('statFaltas');
  if (statFaltas) statFaltas.textContent = faltas.length;
}

/* ══════════════════════════════
   MARCAR FALTA
══════════════════════════════ */
async function marcarFalta(id, btnEl) {
  if (!confirm('Confirmar falta para este cliente?')) return;
  btnEl.disabled = true;

  try {
    const r = await fetch(`${API}/agendamentos/falta/${id}`, { method: 'PUT' });
    const json = await r.json();
    if (!r.ok || json.erro) throw new Error(json.erro || 'Erro ao registrar falta');
    toast('⚠️ Falta registrada', '#c9a84c');
    carregarConcluidos();
  } catch(e) {
    toast(e.message || 'Erro', '#e05050');
    btnEl.disabled = false;
  }
}

/* ══════════════════════════════
   DESFAZER FALTA (volta p/ concluído)
══════════════════════════════ */
async function desfazerFalta(id, btnEl) {
  btnEl.disabled = true;
  try {
    const r = await fetch(`${API}/agendamentos/concluir/${id}`, { method: 'PUT' });
    const json = await r.json();
    if (!r.ok || json.erro) throw new Error(json.erro || 'Erro');
    toast('✓ Falta desfeita', 'var(--green)');
    carregarConcluidos();
  } catch(e) {
    toast(e.message || 'Erro', '#e05050');
    btnEl.disabled = false;
  }
}

/* ══════════════════════════════
   RENDERIZAR CARD
══════════════════════════════ */
function renderizarCard(item, i) {
  const card = document.createElement('div');
  card.classList.add('card');
  card.style.animationDelay = (i * 0.05) + 's';

  const isFalta    = item.status === 'falta';
  const isAutoConcluido = item.auto_concluido === true || item.auto_concluido === 'true';
  const horario    = (item.horario || '').toString().substring(0, 5);

  // Badge de status
  let statusHtml;
  if (isFalta) {
    statusHtml = `<span class="status-tag" style="background:rgba(224,80,80,.12);color:#e05050;border:1px solid rgba(224,80,80,.3);">Falta</span>`;
  } else if (isAutoConcluido) {
    statusHtml = `<span class="status-tag" style="background:rgba(201,168,76,.1);color:#c9a84c;border:1px solid rgba(201,168,76,.3);">Auto-concluído</span>`;
  } else {
    statusHtml = `<span class="status-tag">Concluído</span>`;
  }

  card.innerHTML = `
    <div class="info">
      <div class="info-item">
        <span class="info-label">Cliente</span>
        <span class="info-val"><strong>${item.nome || '—'}</strong></span>
      </div>
      ${item.profissional_nome ? `
      <div class="info-item">
        <span class="info-label">Profissional</span>
        <span class="info-val">${item.profissional_nome}</span>
      </div>` : ''}
      <div class="info-item">
        <span class="info-label">Data</span>
        <span class="info-val">${formatarData(item.data)}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Horário</span>
        <span class="info-val">${horario || '—'}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Status</span>
        <span class="info-val">${statusHtml}</span>
      </div>
    </div>
    <div class="valor-tag" style="${isFalta ? 'opacity:.35;text-decoration:line-through;' : ''}">R$${item.valor || 0}</div>
    <div class="card-actions" id="actions-${item.id}"></div>
  `;

  // Monta botões de ação
  const actionsEl = card.querySelector(`#actions-${item.id}`);

  if (!isFalta) {
    // Botão "Marcar falta" — aparece em concluídos (manuais ou automáticos)
    const btnFalta = document.createElement('button');
    btnFalta.className = 'btn-cancelar';
    btnFalta.style.cssText = 'font-size:9px;padding:8px 12px;';
    btnFalta.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg> Marcar falta`;
    btnFalta.addEventListener('click', () => marcarFalta(item.id, btnFalta));
    actionsEl.appendChild(btnFalta);
  } else {
    // Botão "Desfazer falta" — só aparece em faltas
    const btnDesfazer = document.createElement('button');
    btnDesfazer.className = 'btn-concluir';
    btnDesfazer.style.cssText = 'font-size:9px;padding:8px 12px;';
    btnDesfazer.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M1.5 5.5A4 4 0 1 1 5.5 9.5c-1.3 0-2.4-.6-3.1-1.5M1.5 2v3.5H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg> Desfazer falta`;
    btnDesfazer.addEventListener('click', () => desfazerFalta(item.id, btnDesfazer));
    actionsEl.appendChild(btnDesfazer);
  }

  return card;
}

/* ══════════════════════════════
   CARREGAR
══════════════════════════════ */
async function carregarConcluidos(){
  lista.innerHTML = '<div class="loading-state"><div class="spin"></div>Carregando histórico...</div>';

  try {
    const [resAg, resProf] = await Promise.all([
      fetch(`${API}/agendamentos`),
      fetch(`${API}/profissionais`)
    ]);

    const dados = await resAg.json();

    // Mapa de profissionais para mostrar nome
    let mapaProf = {};
    try {
      const profs = await resProf.json();
      if (Array.isArray(profs)) profs.forEach(p => { mapaProf[p.id] = p; });
    } catch(e) {}

    // Filtra concluídos E faltas
    _todos = dados
      .filter(a => {
        const s = (a.status || '').toLowerCase();
        return s.includes('conclu') || s === 'falta';
      })
      .map(a => ({
        ...a,
        profissional_nome: a.profissional_id && mapaProf[a.profissional_id]
          ? mapaProf[a.profissional_id].nome
          : (a.profissional_nome || null)
      }));

    atualizarStats(_todos);
    lista.innerHTML = '';

    if (_todos.length === 0) {
      lista.innerHTML = `
        <div class="empty">
          <div class="empty-icon">📋</div>
          <div class="empty-txt">Nenhum atendimento registrado ainda</div>
        </div>`;
      return;
    }

    // Separar concluídos e faltas
    const concluidos = _todos.filter(a => a.status !== 'falta');
    const faltas     = _todos.filter(a => a.status === 'falta');

    // Renderiza concluídos
    if (concluidos.length > 0) {
      const secLabel = document.createElement('div');
      secLabel.className = 'sec-label';
      secLabel.textContent = 'Atendimentos concluídos';
      lista.appendChild(secLabel);
      concluidos.forEach((item, i) => lista.appendChild(renderizarCard(item, i)));
    }

    // Renderiza faltas (se houver)
    if (faltas.length > 0) {
      const secFaltas = document.createElement('div');
      secFaltas.className = 'sec-label';
      secFaltas.style.marginTop = '40px';
      secFaltas.textContent = 'Faltas registradas';
      lista.appendChild(secFaltas);
      faltas.forEach((item, i) => lista.appendChild(renderizarCard(item, i)));
    }

  } catch(err) {
    console.error('ERRO:', err);
    lista.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-txt">Erro ao carregar dados</div></div>`;
  }
}

/* ══════════════════════════════
   CONFIRM MODAL (apagar todos)
══════════════════════════════ */
function confirmarApagar(){
  const concluidos = _todos.filter(a => a.status !== 'falta');
  if (concluidos.length === 0) { toast('Nada para apagar', '#c9a84c'); return; }
  document.getElementById('confirmOverlay').classList.add('aberto');
  document.getElementById('progressWrap').style.display = 'none';
  document.getElementById('confirmActions').style.display = 'flex';
}

function fecharConfirm(){
  document.getElementById('confirmOverlay').classList.remove('aberto');
}

async function executarApagar(){
  const progressWrap   = document.getElementById('progressWrap');
  const progressFill   = document.getElementById('progressFill');
  const progressTxt    = document.getElementById('progressTxt');
  const confirmActions = document.getElementById('confirmActions');

  // Apaga só os concluídos, NÃO as faltas
  const aApagar = _todos.filter(a => a.status !== 'falta');
  if (aApagar.length === 0) { fecharConfirm(); return; }

  confirmActions.style.display = 'none';
  progressWrap.style.display   = 'block';

  let deletados = 0;
  const total   = aApagar.length;

  for (const item of aApagar) {
    try {
      await fetch(`${API}/agendamentos/${item.id}`, { method: 'DELETE' });
    } catch(err) {
      console.error('Erro ao deletar id', item.id, err);
    }
    deletados++;
    const pct = Math.round((deletados / total) * 100);
    progressFill.style.width = pct + '%';
    progressTxt.textContent  = `Apagando ${deletados} de ${total}...`;
  }

  fecharConfirm();
  toast(`✓ ${total} registro${total > 1 ? 's' : ''} apagado${total > 1 ? 's' : ''}!`);
  carregarConcluidos();
}

/* ══════════════════════════════
   INIT
══════════════════════════════ */
carregarConcluidos();