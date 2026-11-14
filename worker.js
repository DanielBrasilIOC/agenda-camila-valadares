const ALLOWED_ORIGINS = new Set(["https://danielbrasilioc.github.io"]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Origin",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type"
  };
  if (ALLOWED_ORIGINS.has(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}
function out(value, status = 200, request) {
  return new Response(JSON.stringify(value), { status, headers: corsHeaders(request) });
}
function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split("-").map(Number);
  const check = new Date(Date.UTC(y,m-1,d));
  return check.getUTCFullYear()===y && check.getUTCMonth()===m-1 && check.getUTCDate()===d;
}
function isValidTime(value) { return typeof value==="string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if(request.method==="OPTIONS" && (path==="/api/appointments" || path.startsWith("/api/appointments/"))) {
      return new Response(null,{status:204,headers:corsHeaders(request)});
    }
    if (path === "/api/appointments") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      try {
        await ensureReminderColumns(env.DB);
        if (request.method === "GET") {
          const {results=[]}=await env.DB.prepare("SELECT id, client, phone, service, duration, date, time, notes, created_at, completed_at, contacted_at FROM appointments ORDER BY date, time").all();
          return out(results,200,request);
        }
        if (request.method === "POST") {
          let body;
          try { body=await request.json(); } catch { return out({error:"Corpo JSON inválido."},400,request); }
          const {id,client,phone="",service,duration,date,time,notes="",completed_at=null,contacted_at=null}=body||{};
          const minutes=Number(duration);
          if (typeof id!=="string"||!id.trim()||typeof client!=="string"||!client.trim()||
              typeof phone!=="string"||typeof service!=="string"||!service.trim()||
              !isValidDate(date)||!isValidTime(time)||!Number.isInteger(minutes)||minutes<=0||
              minutes%30!==0||typeof notes!=="string"||(completed_at!==null&&typeof completed_at!=="string")||(contacted_at!==null&&typeof contacted_at!=="string")) return out({error:"Dados do agendamento inválidos."},400,request);
          const [hour,minute]=time.split(":").map(Number),start=hour*60+minute;
          if (start<360||start+minutes>1320) return out({error:"O atendimento deve ocorrer entre 06:00 e 22:00."},400,request);
          const statements=[
            env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
            env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id),
            env.DB.prepare("INSERT INTO appointments (id, client, phone, service, duration, date, time, notes, completed_at, contacted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id,client.trim(),phone.trim(),service.trim(),minutes,date,time,notes.trim(),completed_at,contacted_at)
          ];
          for(let offset=0;offset<minutes;offset+=30){
            const m=start+offset,slot=String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
            statements.push(env.DB.prepare("INSERT INTO appointment_slots (appointment_id, date, slot) VALUES (?, ?, ?)").bind(id,date,slot));
          }
          try { await env.DB.batch(statements); return out({ok:true,id},200,request); }
          catch(error) {
            const message=String(error?.message||error);
            if(/UNIQUE|PRIMARY KEY|constraint/i.test(message)) return out({error:"Este horário já está ocupado. Atualize a agenda e escolha outro horário."},409,request);
            return out({error:"Não foi possível gravar o agendamento no banco D1."},500,request);
          }
        }
        return out({error:"Método não permitido."},405,request);
      } catch(error) { return out({error:"Erro ao consultar ou gravar os agendamentos."},500,request); }
    }
    const prefix="/api/appointments/";
    if(path.startsWith(prefix)&&request.method==="PATCH"){
      if(!env.DB)return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      await ensureReminderColumns(env.DB);
      let id;try{id=decodeURIComponent(path.slice(prefix.length));}catch{return out({error:"Identificador inválido."},400,request);}
      let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
      const action=body?.action;
      if(!id||!["complete","contacted"].includes(action))return out({error:"Ação de atendimento inválida."},400,request);
      const column=action==="complete"?"completed_at":"contacted_at";
      try { const result=await env.DB.prepare("UPDATE appointments SET "+column+" = ? WHERE id = ?").bind(new Date().toISOString(),id).run();
        if(!result.meta?.changes)return out({error:"Agendamento não encontrado."},404,request);
        return out({ok:true,id,action},200,request);
      } catch(error){return out({error:"Não foi possível atualizar o status do atendimento."},500,request);}
    }
    if(path.startsWith(prefix)&&request.method==="DELETE"){
      if(!env.DB)return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      let id;try{id=decodeURIComponent(path.slice(prefix.length));}catch{return out({error:"Identificador inválido."},400,request);}
      if(!id)return out({error:"Identificador inválido."},400,request);
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
          env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id)
        ]);
        return out({ok:true,id},200,request);
      } catch(error) { return out({error:"Não foi possível excluir o agendamento."},500,request); }
    }
    if(env.ASSETS&&typeof env.ASSETS.fetch==="function")return env.ASSETS.fetch(request);
    return out({error:"Arquivos da agenda indisponíveis: configure o binding de Assets do Worker como ASSETS."},503,request);
  }
};