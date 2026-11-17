import fs from "node:fs";
import { createHash } from "node:crypto";

const API = "https://agenda-camila-valadares.brasil-moura.workers.dev";
const data = JSON.parse(fs.readFileSync("data/contacts-import-20261117.json", "utf8"));
const contacts = data.contacts || [];
const normalize = value => String(value || "").normalize("NFC").trim().toLocaleLowerCase("pt-BR");
const nameCounts = contacts.reduce((acc, item) => {
  const key = normalize(item.name);
  acc.set(key, (acc.get(key) || 0) + 1);
  return acc;
}, new Map());
const idFor = item => "imp-" + createHash("sha256")
  .update([normalize(item.name), item.phone || "", item.phone_secondary || ""].join("\u0000"))
  .digest("hex").slice(0, 32);
const request = async (path, options) => {
  const response = await fetch(API + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(path + " returned " + response.status + ": " + JSON.stringify(body));
  return body;
};
const existing = await request("/api/contacts");
if (!Array.isArray(existing)) throw new Error("A API não retornou uma lista de contatos.");
let inserted = 0, updated = 0, skipped = 0;
const sameName = item => existing.filter(row => normalize(row.name) === normalize(item.name));
const exact = (row, item) =>
  String(row.phone || "").trim() === (item.phone || "") &&
  String(row.phone_secondary || "").trim() === (item.phone_secondary || "");
const post = async item => {
  const id = idFor(item);
  await request("/api/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name: item.name, phone: item.phone || "", phone_secondary: item.phone_secondary || "", birthday: "", notes: "" })
  });
  existing.push({ id, name: item.name, phone: item.phone || "", phone_secondary: item.phone_secondary || "" });
  inserted++;
};
const patch = async (row, item) => {
  await request("/api/contacts/" + encodeURIComponent(row.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: item.name, phone: item.phone || "", phone_secondary: item.phone_secondary || "", birthday: "", notes: "" })
  });
  row.name = item.name;
  row.phone = item.phone || "";
  row.phone_secondary = item.phone_secondary || "";
  updated++;
};

for (const item of contacts) {
  const matches = sameName(item);
  if (matches.some(row => exact(row, item))) {
    skipped++;
    continue;
  }

  // Fernanda Bombinho: consolidar os dois números confirmados no mesmo cadastro.
  if (normalize(item.name) === normalize("Fernanda Bombinho D’elas") && item.phone_secondary) {
    const candidate = matches.find(row =>
      [item.phone, item.phone_secondary].includes(String(row.phone || "").trim()) ||
      [item.phone, item.phone_secondary].includes(String(row.phone_secondary || "").trim())
    );
    if (candidate) {
      await patch(candidate, item);
      continue;
    }
  }

  // Atualiza um cadastro único já existente sem telefone; não mistura nomes repetidos.
  if ((nameCounts.get(normalize(item.name)) || 0) === 1 && matches.length === 1 &&
      !String(matches[0].phone || "").trim() && !String(matches[0].phone_secondary || "").trim() &&
      (item.phone || item.phone_secondary)) {
    await patch(matches[0], item);
    continue;
  }

  // Nomes repetidos com números diferentes permanecem como registros independentes.
  await post(item);
}

console.log(JSON.stringify({
  ok: true,
  totalNaLista: contacts.length,
  inseridos: inserted,
  atualizados: updated,
  jaExistentes: skipped,
  telefonesSemNome: data.unassigned_phones || [],
  observacao: "Aniversário e observações permaneceram vazios."
}, null, 2));
