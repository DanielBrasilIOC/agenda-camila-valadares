function out(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store"
  }});
}
function isValidDate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split("-").map(Number);
  const check = new Date(Date.UTC(y,m-1,d));
  return check.getUTCFullYear()===y && check.getUTCMonth()===m-1 && check.getUTCDate()===d;
}
function isValidTime(value) { return typeof value==="string" && /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(value); }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\\/+$/, "") || "/";
    if (path === "/api/appointments") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503);
      try {
        if (request.method === "GET") {
          const {results=[]}=await env.DB.prepare("SELECT id, client, phone, service, duration, date, time, notes, created_at FROM appointments ORDER BY date, time").all();
          return out(results);
        }
        if (request.method === "POST") {
          let body;
          try { body=await request.json(); } catch { return out({error:"Corpo JSON inválido."},400); }
          const {id,client,phone="",service,duration,date,time,notes=""}=body||{};
          const minutes=Number(duration);
          if (typeof id!=="string"||!id.trim()||typeof client!=="string"||!client.trim()||
              typeof phone!=="string"||typeof service!=="string"||!service.trim()||
              !isValidDate(date)||!isValidTime(time)||!Number.isInteger(minutes)||minutes<=0||
              minutes%30!==0||typeof notes!=="string") return out({error:"Dados do agendamento inválidos."},400);
          const [hour,minute]=time.split(":").map(Number),start=hour*60+minute;
          if (start<360||start+minutes>1320) return out({error:"O atendimento deve ocorrer entre 06:00 e 22:00."},400);
          const statements=[
            env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
            env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id),
            env.DB.prepare("INSERT INTO appointments (id, client, phone, service, duration, date, time, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id,client.trim(),phone.trim(),service.trim(),minutes,date,time,notes.trim())
          ];
          for(let offset=0;offset<minutes;offset+=30){
            const m=start+offset,slot=String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
            statements.push(env.DB.prepare("INSERT INTO appointment_slots (appointment_id, date, slot) VALUES (?, ?, ?)").bind(id,date,slot));
          }
          try { await env.DB.batch(statements); return out({ok:true,id}); }
          catch(error) {
            const message=String(error?.message||error);
            if(/UNIQUE|PRIMARY KEY|constraint/i.test(message)) return out({error:"Este horário já está ocupado. Atualize a agenda e escolha outro horário."},409);
            return out({error:"Não foi possível gravar o agendamento no banco D1."},500);
          }
        }
        return out({error:"Método não permitido."},405);
      } catch(error) { return out({error:"Erro ao consultar ou gravar os agendamentos."},500); }
    }
    const prefix="/api/appointments/";
    if(path.startsWith(prefix)&&request.method==="DELETE"){
      if(!env.DB)return out({error:"Binding D1 DB não configurado no Worker."},503);
      let id;try{id=decodeURIComponent(path.slice(prefix.length));}catch{return out({error:"Identificador inválido."},400);}
      if(!id)return out({error:"Identificador inválido."},400);
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
          env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id)
        ]);
        return out({ok:true,id});
      } catch(error) { return out({error:"Não foi possível excluir o agendamento."},500); }
    }
    if(request.method==="OPTIONS")return new Response(null,{status:204});
    if(env.ASSETS&&typeof env.ASSETS.fetch==="function")return env.ASSETS.fetch(request);
    return out({error:"Arquivos da agenda indisponíveis: configure o binding de Assets do Worker como ASSETS."},503);
  }
};