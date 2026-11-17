const ALLOWED_ORIGINS = new Set(["https://danielbrasilioc.github.io"]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Origin",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
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
async function ensureSchema(db) {
  const info=await db.prepare("PRAGMA table_info(appointments)").all();
  const cols=new Set((info.results||[]).map(x=>x.name));
  for(const [n,sql] of [["service_price","ALTER TABLE appointments ADD COLUMN service_price REAL NOT NULL DEFAULT 0"],["completed_at","ALTER TABLE appointments ADD COLUMN completed_at TEXT"],["contacted_at","ALTER TABLE appointments ADD COLUMN contacted_at TEXT"]]) if(!cols.has(n)) await db.prepare(sql).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, phone_normalized TEXT NOT NULL UNIQUE, birthday TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name COLLATE NOCASE)").run();
}
function normalizePhone(value) { return String(value??"").replace(/\\D/g,""); }
function validContact(body) {
  const name=typeof body?.name==="string"?body.name.trim():"";
  const phone=typeof body?.phone==="string"?body.phone.trim():"";
  const normalized=normalizePhone(phone);
  const birthday=body?.birthday==null?"":body.birthday;
  const notes=body?.notes==null?"":body.notes;
  if(!name||name.length>100||!phone||normalized.length<8||normalized.length>15||
     (birthday!==""&&!isValidDate(birthday))||typeof notes!=="string"||notes.length>1000) return null;
  return {name,phone,normalized,birthday,notes};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if(request.method==="OPTIONS" && (path==="/api/appointments" || path.startsWith("/api/appointments/") || path==="/api/contacts" || path.startsWith("/api/contacts/"))) {
      return new Response(null,{status:204,headers:corsHeaders(request)});
    }
    const contactsPath="/api/contacts";
    if(path===contactsPath || path.startsWith(contactsPath+"/")) {
      if(!env.DB)return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      if(!env.CONTACTS_API_KEY)return out({error:"A área de contatos ainda não foi habilitada pelo administrador."},503,request);
      if(request.headers.get("Authorization")!=="Bearer "+env.CONTACTS_API_KEY)return out({error:"Acesso não autorizado à área de contatos."},401,request);
      try {
        await ensureSchema(env.DB);
        if(path===contactsPath && request.method==="GET") {
          const {results=[]}=await env.DB.prepare("SELECT id, name, phone, birthday, notes, created_at, updated_at FROM contacts ORDER BY name COLLATE NOCASE").all();
          return out(results,200,request);
        }
        if(path===contactsPath && request.method==="POST") {
          let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
          const contact=validContact(body);if(!contact)return out({error:"Informe nome e telefone válidos. Aniversário e observações são opcionais."},400,request);
          const id=typeof body.id==="string"&&body.id.trim()?body.id.trim():crypto.randomUUID();
          try {
            await env.DB.prepare("INSERT INTO contacts (id,name,phone,phone_normalized,birthday,notes) VALUES (?,?,?,?,?,?)").bind(id,contact.name,contact.phone,contact.normalized,contact.birthday,contact.notes).run();
            return out({ok:true,id},201,request);
          } catch(error) {
            if(/UNIQUE|PRIMARY KEY|constraint/i.test(String(error?.message||error)))return out({error:"Já existe um contato cadastrado com este telefone."},409,request);
            throw error;
          }
        }
        if(path===contactsPath+"/import" && request.method==="POST") {
          let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
          if(!Array.isArray(body?.contacts)||body.contacts.length>500)return out({error:"Envie uma lista de até 500 contatos."},400,request);
          const byPhone=new Map(),conflicts=[],invalid=[];
          for(let i=0;i<body.contacts.length;i++){
            const c=validContact(body.contacts[i]);
            if(!c){invalid.push({index:i+1,name:body.contacts[i]?.name||""});continue;}
            const prior=byPhone.get(c.normalized);
            if(prior && prior.name.toLocaleLowerCase("pt-BR")!==c.name.toLocaleLowerCase("pt-BR")){
              conflicts.push({phone:c.phone,names:[prior.name,c.name]});byPhone.delete(c.normalized);continue;
            }
            if(!prior&&!conflicts.some(x=>normalizePhone(x.phone)===c.normalized))byPhone.set(c.normalized,c);
          }
          const candidates=[...byPhone.values()],existing=new Set();
          for(let i=0;i<candidates.length;i+=80){
            const chunk=candidates.slice(i,i+80),marks=chunk.map(()=>"?").join(",");
            const rows=await env.DB.prepare("SELECT phone_normalized FROM contacts WHERE phone_normalized IN ("+marks+")").bind(...chunk.map(x=>x.normalized)).all();
            for(const row of rows.results||[])existing.add(row.phone_normalized);
          }
          const fresh=candidates.filter(c=>!existing.has(c.normalized));
          const statements=fresh.map(c=>env.DB.prepare("INSERT OR IGNORE INTO contacts (id,name,phone,phone_normalized,birthday,notes) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),c.name,c.phone,c.normalized,c.birthday,c.notes));
          let inserted=0;
          for(let i=0;i<statements.length;i+=80){const results=await env.DB.batch(statements.slice(i,i+80));inserted+=(results||[]).reduce((n,x)=>n+Number(x?.meta?.changes||0),0);}
          return out({ok:true,received:body.contacts.length,inserted,already_registered:existing.size,duplicate_numbers:conflicts,invalid},200,request);
        }
        if(path===contactsPath+"/upsert" && request.method==="POST") {
          let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
          const contact=validContact(body);if(!contact)return out({error:"Informe nome e telefone válidos."},400,request);
          const existing=await env.DB.prepare("SELECT id FROM contacts WHERE phone_normalized=?").bind(contact.normalized).first();
          if(existing)return out({ok:true,id:existing.id,existing:true},200,request);
          const id=crypto.randomUUID();
          try{await env.DB.prepare("INSERT INTO contacts (id,name,phone,phone_normalized,birthday,notes) VALUES (?,?,?,?,?,?)").bind(id,contact.name,contact.phone,contact.normalized,contact.birthday,contact.notes).run();return out({ok:true,id,created:true},201,request);}
          catch(error){if(/UNIQUE|PRIMARY KEY|constraint/i.test(String(error?.message||error))){const row=await env.DB.prepare("SELECT id FROM contacts WHERE phone_normalized=?").bind(contact.normalized).first();if(row)return out({ok:true,id:row.id,existing:true},200,request);}throw error;}
        }
        const contactPrefix=contactsPath+"/";
        if(path.startsWith(contactPrefix)) {
          let id;try{id=decodeURIComponent(path.slice(contactPrefix.length));}catch{return out({error:"Identificador inválido."},400,request);}
          if(!id||id==="import"||id==="upsert")return out({error:"Identificador inválido."},400,request);
          if(request.method==="PATCH") {
            let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
            const contact=validContact(body);if(!contact)return out({error:"Informe nome e telefone válidos."},400,request);
            try{const result=await env.DB.prepare("UPDATE contacts SET name=?,phone=?,phone_normalized=?,birthday=?,notes=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(contact.name,contact.phone,contact.normalized,contact.birthday,contact.notes,id).run();if(!result.meta?.changes)return out({error:"Contato não encontrado."},404,request);return out({ok:true,id},200,request);}
            catch(error){if(/UNIQUE|constraint/i.test(String(error?.message||error)))return out({error:"Outro contato já utiliza este telefone."},409,request);throw error;}
          }
          if(request.method==="DELETE") {
            const result=await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run();
            if(!result.meta?.changes)return out({error:"Contato não encontrado."},404,request);
            return out({ok:true,id},200,request);
          }
        }
        return out({error:"Método não permitido."},405,request);
      } catch(error) { return out({error:"Não foi possível consultar ou atualizar os contatos no banco D1."},500,request); }
    }
    if (path === "/api/appointments") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      try { await ensureSchema(env.DB);
        if (request.method === "GET") {
          const {results=[]}=await env.DB.prepare("SELECT id, client, phone, service, duration, date, time, notes, created_at, service_price, completed_at, contacted_at FROM appointments ORDER BY date, time").all();
          return out(results,200,request);
        }
        if (request.method === "POST") {
          let body;
          try { body=await request.json(); } catch { return out({error:"Corpo JSON inválido."},400,request); }
          const {id,client,phone="",service,duration,date,time,notes="",service_price=0}=body||{}; const price=Number(service_price);
          const minutes=Number(duration);
          if (typeof id!=="string"||!id.trim()||typeof client!=="string"||!client.trim()||
              typeof phone!=="string"||typeof service!=="string"||!service.trim()||
              !isValidDate(date)||!isValidTime(time)||!Number.isInteger(minutes)||minutes<=0||
              minutes%15!==0||!Number.isFinite(price)||price<0||typeof notes!=="string") return out({error:"Dados do agendamento inválidos."},400,request);
          const [hour,minute]=time.split(":").map(Number),start=hour*60+minute;
          if (start<360||start+minutes>1320) return out({error:"O atendimento deve ocorrer entre 06:00 e 22:00."},400,request);
          const previous=await env.DB.prepare("SELECT completed_at, contacted_at FROM appointments WHERE id = ?").bind(id).first();
          const statements=[
            env.DB.prepare("DELETE FROM appointment_slots WHERE appointment_id = ?").bind(id),
            env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id),
            env.DB.prepare("INSERT INTO appointments (id, client, phone, service, duration, date, time, notes, service_price, completed_at, contacted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id,client.trim(),phone.trim(),service.trim(),minutes,date,time,notes.trim(),price,previous?.completed_at||null,previous?.contacted_at||null)
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
      try{await ensureSchema(env.DB);let id;try{id=decodeURIComponent(path.slice(prefix.length));}catch{return out({error:"Identificador inválido."},400,request);}
      let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
      const action=body?.action;if(!id||!["complete","contacted"].includes(action))return out({error:"Ação inválida."},400,request);
      const row=await env.DB.prepare("SELECT id, service, date, time FROM appointments WHERE id = ?").bind(id).first();if(!row)return out({error:"Agendamento não encontrado."},404,request);
      if(action==="complete"){if(String(row.service).startsWith("Bloqueio"))return out({error:"Bloqueios não são serviços realizados."},400,request);const scheduled=new Date(row.date+"T"+row.time+":00-03:00");if(scheduled.getTime()>Date.now())return out({error:"O horário agendado ainda não ocorreu."},409,request);const completedAt=scheduled.toISOString();await env.DB.prepare("UPDATE appointments SET completed_at=COALESCE(completed_at, ?) WHERE id=?").bind(completedAt,id).run();;}
      else await env.DB.prepare("UPDATE appointments SET contacted_at=COALESCE(contacted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=?").bind(id).run();
      return out({ok:true,id,action},200,request);}catch{return out({error:"Não foi possível atualizar o atendimento."},500,request);}
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