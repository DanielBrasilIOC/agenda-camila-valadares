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
async function ensureSchema(db) {
  const info = await db.prepare("PRAGMA table_info(appointments)").all();
  const cols = new Set((info.results || []).map(x => x.name));
  for (const [n, sql] of [
    ["service_price", "ALTER TABLE appointments ADD COLUMN service_price REAL NOT NULL DEFAULT 0"],
    ["completed_at", "ALTER TABLE appointments ADD COLUMN completed_at TEXT"],
    ["contacted_at", "ALTER TABLE appointments ADD COLUMN contacted_at TEXT"]
  ]) if (!cols.has(n)) await db.prepare(sql).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    phone_secondary TEXT NOT NULL DEFAULT '',
    birthday TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`).run();
  await db.prepare("CREATE TABLE IF NOT EXISTS app_migrations (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))").run();
  const duplicateNamesMigration = await db.prepare("SELECT key FROM app_migrations WHERE key = ?").bind("contacts_allow_duplicate_names_v1").first();
  if (!duplicateNamesMigration) {
    await db.prepare("DROP INDEX IF EXISTS idx_contacts_name_unique").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_contacts_name_lookup ON contacts(lower(trim(name)))").run();
    await db.prepare("INSERT OR IGNORE INTO app_migrations (key) VALUES (?)").bind("contacts_allow_duplicate_names_v1").run();
  }

  const migration = await db.prepare("SELECT key FROM app_migrations WHERE key = ?").bind("contacts_backfill_v1").first();
  if (!migration) {
    const { results = [] } = await db.prepare("SELECT client, phone FROM appointments WHERE TRIM(COALESCE(client,'')) <> '' ORDER BY date, time").all();
    const grouped = new Map();
    for (const row of results) {
      const name = String(row.client || "").trim();
      const key = name.toLocaleLowerCase("pt-BR");
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, { name, phones: [] });
      const phone = String(row.phone || "").trim();
      const item = grouped.get(key);
      if (phone && !item.phones.includes(phone) && item.phones.length < 2) item.phones.push(phone);
    }
    const statements = [];
    for (const item of grouped.values()) {
      statements.push(db.prepare("INSERT OR IGNORE INTO contacts (id, name, phone, phone_secondary) VALUES (?, ?, ?, ?)")
        .bind(crypto.randomUUID(), item.name, item.phones[0] || "", item.phones[1] || ""));
    }
    statements.push(db.prepare("INSERT OR IGNORE INTO app_migrations (key) VALUES (?)").bind("contacts_backfill_v1"));
    await db.batch(statements);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if(request.method==="OPTIONS" && (path==="/api/appointments" || path.startsWith("/api/appointments/") || path==="/api/contacts" || path.startsWith("/api/contacts/"))) {
      return new Response(null,{status:204,headers:corsHeaders(request)});
    }
    if (path === "/" || path === "/health") {
      return out({ ok: true, service: "agenda-camila-valadares", status: "online", api: ["/api/appointments", "/api/contacts"] }, 200, request);
    }

    if (path === "/api/contacts") {
      if (!env.DB) return out({ error: "Binding D1 DB não configurado no Worker." }, 503, request);
      try {
        await ensureSchema(env.DB);
        if (request.method === "GET") {
          const { results = [] } = await env.DB.prepare(
            "SELECT id, name, phone, phone_secondary, birthday, notes, created_at, updated_at FROM contacts ORDER BY name COLLATE NOCASE"
          ).all();
          return out(results, 200, request);
        }
        if (request.method === "POST") {
          let body;
          try { body = await request.json(); } catch { return out({ error: "Corpo JSON inválido." }, 400, request); }
          const name = typeof body?.name === "string" ? body.name.trim() : "";
          const phone = body?.phone ?? "";
          const phoneSecondary = body?.phone_secondary ?? "";
          const birthday = body?.birthday ?? "";
          const notes = body?.notes ?? "";
          if (!name || name.length > 120 || typeof phone !== "string" || typeof phoneSecondary !== "string" ||
              typeof birthday !== "string" || (birthday && !isValidDate(birthday)) || typeof notes !== "string" ||
              phone.length > 40 || phoneSecondary.length > 40 || notes.length > 1000) {
            return out({ error: "Dados do contato inválidos." }, 400, request);
          }
          const requestedId = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : "";
          const existing = requestedId
            ? await env.DB.prepare("SELECT id FROM contacts WHERE id = ?").bind(requestedId).first()
            : await env.DB.prepare("SELECT id FROM contacts WHERE lower(trim(name)) = lower(trim(?)) ORDER BY created_at LIMIT 1").bind(name).first();
          const id = existing?.id || requestedId || crypto.randomUUID();
          if (existing) {
            await env.DB.prepare("UPDATE contacts SET name=?, phone=?, phone_secondary=?, birthday=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
              .bind(name, phone.trim(), phoneSecondary.trim(), birthday, notes.trim(), id).run();
          } else {
            await env.DB.prepare("INSERT INTO contacts (id, name, phone, phone_secondary, birthday, notes) VALUES (?, ?, ?, ?, ?, ?)")
              .bind(id, name, phone.trim(), phoneSecondary.trim(), birthday, notes.trim()).run();
          }
          return out({ ok: true, id }, existing ? 200 : 201, request);
        }
        return out({ error: "Método não permitido." }, 405, request);
      } catch (error) {
        const message = String(error?.message || error);
        if (/UNIQUE|constraint/i.test(message)) return out({ error: "Já existe um contato com esse nome." }, 409, request);
        return out({ error: "Não foi possível consultar ou gravar os contatos." }, 500, request);
      }
    }

    const contactPrefix = "/api/contacts/";
    if (path.startsWith(contactPrefix)) {
      if (!env.DB) return out({ error: "Binding D1 DB não configurado no Worker." }, 503, request);
      try {
        await ensureSchema(env.DB);
        let id;
        try { id = decodeURIComponent(path.slice(contactPrefix.length)); }
        catch { return out({ error: "Identificador inválido." }, 400, request); }
        if (!id) return out({ error: "Identificador inválido." }, 400, request);
        if (request.method === "PATCH") {
          let body;
          try { body = await request.json(); } catch { return out({ error: "Corpo JSON inválido." }, 400, request); }
          const current = await env.DB.prepare("SELECT id, name, phone, phone_secondary, birthday, notes FROM contacts WHERE id=?").bind(id).first();
          if (!current) return out({ error: "Contato não encontrado." }, 404, request);
          const name = body?.name === undefined ? current.name : String(body.name).trim();
          const phone = body?.phone === undefined ? current.phone : body.phone;
          const phoneSecondary = body?.phone_secondary === undefined ? current.phone_secondary : body.phone_secondary;
          const birthday = body?.birthday === undefined ? current.birthday : body.birthday;
          const notes = body?.notes === undefined ? current.notes : body.notes;
          if (!name || name.length > 120 || typeof phone !== "string" || typeof phoneSecondary !== "string" ||
              typeof birthday !== "string" || (birthday && !isValidDate(birthday)) || typeof notes !== "string" ||
              phone.length > 40 || phoneSecondary.length > 40 || notes.length > 1000) {
            return out({ error: "Dados do contato inválidos." }, 400, request);
          }
          await env.DB.prepare("UPDATE contacts SET name=?, phone=?, phone_secondary=?, birthday=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .bind(name, phone.trim(), phoneSecondary.trim(), birthday, notes.trim(), id).run();
          return out({ ok: true, id }, 200, request);
        }
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM contacts WHERE id=?").bind(id).run();
          return out({ ok: true, id }, 200, request);
        }
        return out({ error: "Método não permitido." }, 405, request);
      } catch (error) {
        const message = String(error?.message || error);
        if (/UNIQUE|constraint/i.test(message)) return out({ error: "Já existe outro contato com esse nome." }, 409, request);
        return out({ error: "Não foi possível atualizar o contato." }, 500, request);
      }
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
          const existingContact = await env.DB.prepare("SELECT id, phone, phone_secondary FROM contacts WHERE lower(trim(name)) = lower(trim(?))").bind(client.trim()).first();
          const incomingPhone = phone.trim();
          let contactStatement;
          if (existingContact) {
            const primaryPhone = existingContact.phone || incomingPhone;
            const secondaryPhone = existingContact.phone_secondary || (incomingPhone && existingContact.phone && incomingPhone !== existingContact.phone ? incomingPhone : "");
            contactStatement = env.DB.prepare("UPDATE contacts SET phone=?, phone_secondary=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
              .bind(primaryPhone, secondaryPhone, existingContact.id);
          } else {
            contactStatement = env.DB.prepare("INSERT INTO contacts (id, name, phone) VALUES (?, ?, ?)")
              .bind(crypto.randomUUID(), client.trim(), incomingPhone);
          }
          const statements=[
            contactStatement,
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
    return out({error:"Rota não encontrada.", service:"agenda-camila-valadares"},404,request);
  }
};