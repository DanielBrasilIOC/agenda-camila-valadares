# Agenda Camila Valadares

Agenda profissional web independente para Camila Valadares.

## Área privada de contatos

A lista de clientes contém dados pessoais e não deve ser armazenada em arquivos públicos do repositório. Os contatos ficam no banco Cloudflare D1, por meio da API protegida do Worker.

Antes de habilitar a área de contatos:

1. No GitHub, abra **Settings → Secrets and variables → Actions** do repositório.
2. Crie um secret chamado `CONTACTS_API_KEY` com uma chave aleatória forte.
3. Faça o deploy do Worker pela rotina **Deploy Agenda Camila Worker**.
4. Acesse a aba **Contatos** na agenda e informe a mesma chave para abrir a lista.

A chave é enviada apenas no cabeçalho `Authorization` das chamadas da API e fica guardada em `sessionStorage` durante a sessão do navegador. Sem a chave, a API não libera leitura nem alteração dos contatos.

## Dados e importação

- Nome e telefone são obrigatórios.
- Aniversário e observações são opcionais.
- A tabela `contacts` é criada no D1 sem alterar a tabela de agendamentos.
- A importação aceita JSON com uma lista de objetos `{ "name": "...", "phone": "..." }` (até 500 registros).
- Telefones são normalizados para detectar duplicidades; contatos já existentes não são sobrescritos na importação.
- Contatos podem ser incluídos, editados e excluídos. Excluir um contato não apaga agendamentos anteriores.
- Ao salvar um agendamento, a agenda pode cadastrar o contato novo sem duplicar um telefone já existente.

**Privacidade:** nunca inclua nomes, telefones ou a lista real de clientes em arquivos, commits ou issues deste repositório público.
