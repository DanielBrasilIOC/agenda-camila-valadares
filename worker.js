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
    ["contacted_at", "ALTER TABLE appointments ADD COLUMN contacted_at TEXT"],
    ["recurrence_group_id", "ALTER TABLE appointments ADD COLUMN recurrence_group_id TEXT"],
    ["recurrence_index", "ALTER TABLE appointments ADD COLUMN recurrence_index INTEGER"],
    ["recurrence_total", "ALTER TABLE appointments ADD COLUMN recurrence_total INTEGER"]
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS birthday_messages (
    contact_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    contact_name TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (contact_id, year)
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

    if (path === "/api/birthday-messages") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      try {
        await ensureSchema(env.DB);
        if (request.method === "GET") {
          const {results=[]}=await env.DB.prepare("SELECT contact_id, year, contact_name, sent_at FROM birthday_messages ORDER BY year DESC, sent_at DESC").all();
          return out(results,200,request);
        }
        if (request.method === "POST") {
          let body;try{body=await request.json();}catch{return out({error:"Corpo JSON inválido."},400,request);}
          const contactId=typeof body?.contactId==="string"?body.contactId.trim():"";
          const year=Number(body?.year);
          if(!contactId||!Number.isInteger(year)||year<2000||year>2100)return out({error:"Contato ou ano do aniversário inválido."},400,request);
          const contact=await env.DB.prepare("SELECT id, name, birthday FROM contacts WHERE id=?").bind(contactId).first();
          if(!contact)return out({error:"Contato não encontrado."},404,request);
          if(!contact.birthday)return out({error:"A cliente não possui aniversário cadastrado."},409,request);
          const monthDay=contact.birthday.slice(5);
          const expectedYear=year+"-"+monthDay;
          if(!isValidDate(expectedYear))return out({error:"Data de aniversário inválida."},400,request);
          await env.DB.prepare("INSERT OR IGNORE INTO birthday_messages (contact_id, year, contact_name) VALUES (?, ?, ?)").bind(contactId,year,contact.name).run();
          const saved=await env.DB.prepare("SELECT contact_id, year, contact_name, sent_at FROM birthday_messages WHERE contact_id=? AND year=?").bind(contactId,year).first();
          return out({ok:true,alreadyRegistered:true,...saved},200,request);
        }
        return out({error:"Método não permitido."},405,request);
      } catch(error) { return out({error:"Não foi possível consultar ou registrar o histórico de aniversários."},500,request); }
    }

    if (path === "/api/appointments/recurring" && request.method === "POST") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      try {
        await ensureSchema(env.DB);
        let body;
        try { body = await request.json(); } catch { return out({error:"Corpo JSON inválido."},400,request); }
        const groupId = body?.recurrenceGroupId;
        const items = body?.appointments;
        if (typeof groupId !== "string" || !groupId.trim() || !Array.isArray(items) || items.length < 2 || items.length > 52) {
          return out({error:"Série recorrente inválida. Informe de 2 a 52 ocorrências."},400,request);
        }
        const first = items[0], ids = new Set(), dates = new Set();
        for (let index=0; index<items.length; index++) {
          const item = items[index] || {}, price = Number(item.service_price), minutes = Number(item.duration);
          if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) ||
              typeof item.client !== "string" || !item.client.trim() ||
              typeof item.phone !== "string" || typeof item.service !== "string" || !item.service.trim() ||
              !isValidDate(item.date) || !isValidTime(item.time) ||
              !Number.isInteger(minutes) || minutes <= 0 || minutes % 15 !== 0 ||
              !Number.isFinite(price) || price < 0 || typeof item.notes !== "string" ||
              item.client !== first.client || item.phone !== first.phone || item.service !== first.service ||
              minutes !== Number(first.duration) || price !== Number(first.service_price) || item.notes !== first.notes ||
              dates.has(item.date) || item.recurrence_group_id !== groupId ||
              item.recurrence_index !== index+1 || item.recurrence_total !== items.length) {
            return out({error:"Os dados da série recorrente são inválidos ou inconsistentes."},400,request);
          }
          const [hour,minute] = item.time.split(":").map(Number), start = hour*60+minute;
          if (start < 360 || start+minutes > 1320) return out({error:"O atendimento deve ocorrer entre 06:00 e 22:00."},400,request);
          ids.add(item.id); dates.add(item.date);
        }
        const existingContact = await env.DB.prepare("SELECT id, phone, phone_secondary FROM contacts WHERE lower(trim(name)) = lower(trim(?))").bind(first.client.trim()).first();
        const incomingPhone = first.phone.trim();
        let contactStatement;
        if (existingContact) {
          const primaryPhone = existingContact.phone || incomingPhone;
          const secondaryPhone = existingContact.phone_secondary || (incomingPhone && existingContact.phone && incomingPhone !== existingContact.phone ? incomingPhone : "");
          contactStatement = env.DB.prepare("UPDATE contacts SET phone=?, phone_secondary=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
            .bind(primaryPhone, secondaryPhone, existingContact.id);
        } else {
          contactStatement = env.DB.prepare("INSERT INTO contacts (id, name, phone) VALUES (?, ?, ?)")
            .bind(crypto.randomUUID(), first.client.trim(), incomingPhone);
        }
        const statements = [contactStatement];
        for (const item of items) {
          statements.push(env.DB.prepare("INSERT INTO appointments (id, client, phone, service, duration, date, time, notes, service_price, completed_at, contacted_at, recurrence_group_id, recurrence_index, recurrence_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)")
            .bind(item.id,item.client.trim(),item.phone.trim(),item.service.trim(),Number(item.duration),item.date,item.time,item.notes.trim(),Number(item.service_price),groupId,item.recurrence_index,item.recurrence_total));
          const [hour,minute] = item.time.split(":").map(Number), start = hour*60+minute;
          for (let offset=0; offset<Number(item.duration); offset+=30) {
            const m=start+offset, slot=String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");
            statements.push(env.DB.prepare("INSERT INTO appointment_slots (appointment_id, date, slot) VALUES (?, ?, ?)").bind(item.id,item.date,slot));
          }
        }
        try {
          await env.DB.batch(statements);
          return out({ok:true,recurrenceGroupId:groupId,ids:items.map(x=>x.id),count:items.length},201,request);
        } catch(error) {
          const message=String(error?.message||error);
          if(/UNIQUE|PRIMARY KEY|constraint/i.test(message)) return out({error:"A série encontrou um horário já ocupado. Nenhuma ocorrência foi gravada; atualize a agenda e escolha outra data ou horário."},409,request);
          return out({error:"Não foi possível gravar a série recorrente no banco D1."},500,request);
        }
      } catch(error) {
        return out({error:"Erro ao validar ou gravar a série recorrente."},500,request);
      }
    }

    if (path === "/api/appointments") {
      if (!env.DB) return out({error:"Binding D1 DB não configurado no Worker."},503,request);
      try { await ensureSchema(env.DB);
        if (request.method === "GET") {
          const {results=[]}=await env.DB.prepare("SELECT id, client, phone, service, duration, date, time, notes, created_at, service_price, completed_at, contacted_at, recurrence_group_id, recurrence_index, recurrence_total FROM appointments ORDER BY date, time").all();
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