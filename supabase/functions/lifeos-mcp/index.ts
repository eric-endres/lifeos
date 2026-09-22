// lifeos-mcp - Supabase Edge Function
//
// Servidor MCP (Model Context Protocol) remoto do LifeOS (LifeOS)
// -- pensado pra ser cadastrado como "custom connector" em claude.ai (Settings
// > Connectors > Add custom connector, colando a URL desta function + token).
// Expoe tools de CONSULTA sobre todo o sistema (Notas, Tarefas, Projetos,
// Eventos, Manifestações, Finanças) e duas tools de ESCRITA: create_nota e
// create_movimentacao. Nenhuma outra escrita (update/delete, outros domínios)
// passa por aqui.
//
// Histórico: a 8ª rodada do autor original (set/2026) deixou só create_nota
// ("vamos deixar apenas o notas com tool para create"). Este fork acrescentou
// create_movimentacao (22/09/2026) para lançar gastos conversando com a IA
// no app do Claude. Consequência consciente: quem tiver a URL do conector
// passa a poder GRAVAR movimentações, não só ler — o token de 256 bits no
// path continua sendo a única fronteira. Continua SEM update/delete: um
// lançamento errado se corrige pela tela de Finanças.
//
// Transporte: Streamable HTTP, SEM estado entre chamadas (sem Mcp-Session-Id)
// -- cada POST e' um JSON-RPC 2.0 completo e independente, o que combina bem
// com o modelo stateless/efemero de Edge Functions. So POST e' implementado
// de fato (GET pra abrir stream SSE de server push nao e' necessario, ja que
// nenhuma tool empurra notificacao assincrona).
//
// AUTENTICACAO -- 2ª versão deste arquivo, desenho deliberadamente diferente
// do resto do projeto (pedido explícito do autor, 8ª rodada):
//   A 1ª versão pedia a senha mestre como PARÂMETRO em cada tool call. O
//   o autor achou isso pouco prático -- queria o token "na conexão", entrado
//   uma vez só. Claude.ai (custom connector pessoal, fora do fluxo de
//   diretório/enterprise) não expõe hoje um campo de header estático pra
//   conector pessoal -- só URL + OAuth opcional (ver AUTH.md §4 pra mais
//   contexto). A alternativa mais simples e' embutir o token no PRÓPRIO
//   PATH da URL: a Edge Function roteia qualquer sufixo de path pro mesmo
//   código (testado -- POST /lifeos-mcp/<qualquer-coisa> chega aqui igual),
//   então a "conexão" cadastrada em claude.ai é
//   `.../functions/v1/lifeos-mcp/<MCP_TOKEN>` -- colado UMA VEZ ao
//   adicionar o conector, nunca mais digitado.
//
//   O token vinha CHAPADO NO CÓDIGO até set/2026; hoje vem de
//   `admin_config.mcp_token` (ou do secret LIFEOS_MCP_TOKEN) --
//   não é o `access_tokens`/`check_master_token` do resto do app, é uma
//   constante própria só pra este conector, gerada com
//   `openssl rand -hex 32` (256 bits). Comparação simples (===) é
//   suficiente: o espaço de valores é grande demais pra brute-force
//   importar, e é overkill uma comparação timing-safe pra um servidor de
//   uso pessoal único. TODA a superfície (tools/list incluso) fica atrás
//   desse gate -- se o path não bate, nem chega a fazer parse do corpo
//   JSON-RPC.
//
//   verify_jwt = false: sem isso, o runtime da Supabase exigiria um JWT
//   valido no Authorization antes mesmo do codigo rodar -- e o cliente MCP
//   de Claude.ai nao tem ideia do que e' isso.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// O TOKEN NAO MORA MAIS NO CODIGO (set/2026).
//
// Ate esta mudanca ele era uma constante chapada aqui. Enquanto o repo era
// privado isso passava; com o projeto indo pra open-source, publicar este
// arquivo entregaria acesso de LEITURA ao LifeOS inteiro pra qualquer
// pessoa que abrisse o codigo no GitHub. Era o bloqueador numero um de
// tornar o repositorio publico.
//
// Agora vem de `admin_config.mcp_token`, a mesma tabela do github_pat,
// lida com a service role a cada requisicao. Duas consequencias boas:
//   - o valor some do controle de versao;
//   - da pra rotacionar o token sem redeployar a function (a tela
//     lifeos/mcp.html le a URL da mesma linha, entao os dois andam juntos).
//
// `LIFEOS_MCP_TOKEN` tem precedencia se estiver definida como secret --
// util pra quem preferir nao guardar o segredo em tabela.
//
// Gerar um valor: `openssl rand -hex 32` (256 bits).
async function tokenEsperado(REST: string, headers: Record<string, string>): Promise<string> {
  const doAmbiente = Deno.env.get("LIFEOS_MCP_TOKEN");
  if (doAmbiente) return doAmbiente;

  const r = await fetch(`${REST}/admin_config?key=eq.mcp_token&select=value`, { headers });
  if (!r.ok) return "";
  const rows: { value: string }[] = await r.json();
  return rows.length ? rows[0].value : "";
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Vocabulários ──────────────────────────────────────────────────────
// Desde a migration 0002 eles vivem em `lifeos_vocabularios`, editáveis em
// LifeOS > menu > Tags. As constantes abaixo viraram FALLBACK: se a leitura
// da tabela falhar, o servidor segue com o vocabulário embutido em vez de
// ficar sem nenhum.
//
// Antes disto havia uma cópia aqui e outra em cada Edge Function de
// domínio; adicionar um valor exigia editar e redeployar as duas.
const FALLBACK: Record<string, string[]> = {
  nota_tipo: ["Lembranças", "Análise de Leitura", "Pensamentos", "Conclusões", "Úteis",
    "Faculdade", "Vida", "Pesquisa", "Programação", "Pessoal", "Relato", "Documentação"],
  tarefa_status: ["Não Iniciado", "Em Andamento", "Feito"],
  tarefa_tipo: ["Vida", "Organização", "Documentação", "Estudo", "Avaliação", "Código", "Freelance", "Trabalho", "Tarefa"],
  projeto_status: ["Não Iniciado", "Em Progresso", "Feito", "Pausado"],
  projeto_tag: ["Pessoal", "Profissional", "Acadêmico", "Configuração"],
  evento_tipo: ["faculdade", "psicodelia", "trabalho", "lazer", "vida"],
  manifestacao_status: ["Não Iniciado", "Em Progresso", "Feito"],
  manifestacao_tag: ["Vida", "Financeiro", "Carreira", "Saúde", "Lazer"],
  mov_direcao: ["Entrada", "Saida"],
  mov_meio: ["Crédito", "Débito", "Pix", "Vale", "Boleto"],
  mov_categoria: ["Moradia", "Transporte", "Mercado", "Sítio", "Restaurante", "Saúde",
    "Compras", "Lazer", "Serviços", "Educação", "Alimentação", "Beleza", "Vestuário", "Eletrônicos", "Outros"],
};

// Preenchido uma vez por invocação, antes de montar as tools -- o enum de
// cada inputSchema precisa da lista já resolvida.
let VOCAB: Record<string, string[]> = { ...FALLBACK };

async function carregarVocab(REST: string, headers: Record<string, string>) {
  try {
    const r = await fetch(`${REST}/lifeos_vocabularios?select=dominio,valor,ordem&order=dominio.asc,ordem.asc`, { headers });
    if (!r.ok) return;
    const rows: { dominio: string; valor: string }[] = await r.json();
    if (!rows.length) return;
    const novo: Record<string, string[]> = {};
    for (const row of rows) (novo[row.dominio] ??= []).push(row.valor);
    // Só sobrescreve os domínios que vieram preenchidos; um domínio vazio
    // na tabela mantém o fallback em vez de zerar a lista.
    VOCAB = { ...FALLBACK, ...novo };
  } catch {
    // mantém o fallback
  }
}


// ── JSON-RPC 2.0 -- helpers de envelope ──────────────────────────────────
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
// Resultado de tool "bem-sucedido" na semantica MCP -- o texto vira contexto
// pro modelo ler; erros de DOMINIO (filtro invalido, projeto nao encontrado)
// tambem usam este formato com isError:true, nao um erro JSON-RPC -- assim
// o Claude LE o motivo e pode se corrigir, em vez de a chamada simplesmente
// falhar.
function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Cópia isolada de noteSnippet() (notas.js/lifeos.js) -- mesmo principio de
// cópia-não-import do resto do projeto (ver LIFEOS.md §2).
function noteSnippet(md: string | null, max = 220): string {
  if (!md) return "";
  const s = md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max).trim() + "…" : s;
}

function clampLimit(v: unknown, def = 20, max = 50): number {
  return Math.max(1, Math.min(max, Number(v) || def));
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

// ── Definições das tools (JSON Schema) ────────────────────────────────────
//
// É uma FUNÇÃO, não uma constante: os `enum` de cada inputSchema saem do
// vocabulário carregado do banco a cada invocação. Como constante de módulo
// eles congelariam no fallback, e o modelo veria uma lista de valores
// diferente da que a validação aceita.
function buildTools() {
  return [
  {
    name: "search_notas",
    description:
      "Busca notas do LifeOS por nome, projeto(s) vinculado(s), tipo/tags e " +
      "intervalo de data. Todos os filtros são opcionais e combináveis (AND " +
      "entre filtros diferentes; arrays usam OR internamente). Sem filtro " +
      "nenhum, retorna as notas mais recentes. Cada nota já vem com o " +
      "conteúdo completo em markdown.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome da nota (busca parcial, case-insensitive)." },
        projetos: { type: "array", items: { type: "string" }, description: "Nomes (ou trechos) de projetos vinculados -- entra se bater com QUALQUER UM." },
        tipo: { type: "array", items: { type: "string", enum: VOCAB.nota_tipo }, description: "Um ou mais tipos/tags -- entra se tiver QUALQUER UM." },
        data_inicio: { type: "string", description: "Data mínima YYYY-MM-DD (inclusive)." },
        data_fim: { type: "string", description: "Data máxima YYYY-MM-DD (inclusive)." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  {
    name: "create_nota",
    description:
      "Cria uma nova nota no LifeOS. A data é sempre a data atual (não é um " +
      "parâmetro). Todos os outros campos são obrigatórios: nome, tipo/tags, " +
      "ao menos um projeto vinculado, e o conteúdo completo em markdown.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome/título da nota." },
        tipo: { type: "array", items: { type: "string", enum: VOCAB.nota_tipo }, minItems: 1, description: "Um ou mais tipos/tags (vocabulário fixo)." },
        projetos: { type: "array", items: { type: "string" }, minItems: 1, description: "Nomes de um ou mais projetos existentes aos quais vincular a nota." },
        conteudo_md: { type: "string", description: "Conteúdo completo da nota, em markdown." },
      },
      required: ["name", "tipo", "projetos", "conteudo_md"],
    },
  },
  {
    name: "create_movimentacao",
    description:
      "Lança uma movimentação financeira (gasto ou entrada) no LifeOS. Use quando o " +
      "usuário disser que gastou, pagou, comprou, recebeu ou quiser registrar um valor. " +
      "Regras: (1) `valor` é sempre positivo — a `direcao` diz se é gasto (Saida) ou " +
      "entrada (Entrada). (2) `data` é opcional e o padrão é HOJE no fuso de São Paulo; " +
      "só informe se o usuário falar outra ('ontem', 'dia 15'). (3) `meio`: se o usuário " +
      "NÃO disser como pagou, PERGUNTE antes de lançar — Crédito não sai do caixa no mês " +
      "(vira fatura futura) e os demais saem na hora, então chutar muda o saldo. " +
      "(4) `categoria`: escolha da lista a que melhor descreve o gasto (gasolina → " +
      "Transporte, almoço → Restaurante, aluguel → Moradia); se nenhuma servir com " +
      "segurança, pergunte. (5) `name` é a descrição curta, sem repetir a categoria. " +
      "(6) Pagamento de FATURA do cartão: direcao Saida, SEM meio, e a palavra 'fatura' " +
      "no name (ex.: 'Pagamento fatura setembro') — é assim que o sistema o reconhece. " +
      "(7) Vários gastos numa mensagem = uma chamada por gasto. Depois de lançar, " +
      "confirme ao usuário o que foi gravado. Não existe editar/apagar por aqui: se " +
      "errar, oriente a corrigir na tela de Finanças.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Descrição curta (ex.: 'gasolina', 'almoço com a equipe')." },
        valor: { type: "number", exclusiveMinimum: 0, description: "Valor em reais, positivo (ex.: 45.9)." },
        direcao: { type: "string", enum: VOCAB.mov_direcao, default: "Saida", description: "Saida = gasto; Entrada = dinheiro recebido." },
        meio: { type: "string", enum: VOCAB.mov_meio, description: "Meio de pagamento. Pergunte se o usuário não disser. Omitir = sem meio (só para pagamento de fatura ou quando o usuário pedir)." },
        categoria: { type: "string", enum: VOCAB.mov_categoria, description: "Categoria de gasto (opcional, recomendada para Saida)." },
        data: { type: "string", description: "YYYY-MM-DD. Opcional — padrão: hoje (São Paulo)." },
      },
      required: ["name", "valor", "direcao"],
    },
  },
  {
    name: "search_tarefas",
    description:
      "Busca tarefas do LifeOS por nome, projeto, status, tipo e intervalo " +
      "de data de entrega. Todos os filtros são opcionais e combináveis.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome da tarefa." },
        projetos: { type: "array", items: { type: "string" }, description: "Nomes (ou trechos) do projeto vinculado." },
        status: { type: "string", enum: VOCAB.tarefa_status, description: "Status exato da tarefa." },
        tipo: { type: "array", items: { type: "string", enum: VOCAB.tarefa_tipo }, description: "Um ou mais tipos -- entra se tiver QUALQUER UM." },
        data_entrega_inicio: { type: "string", description: "Data de entrega mínima YYYY-MM-DD (inclusive)." },
        data_entrega_fim: { type: "string", description: "Data de entrega máxima YYYY-MM-DD (inclusive)." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  {
    name: "search_projetos",
    description: "Busca projetos do LifeOS por nome, status e tags. Todos os filtros são opcionais e combináveis.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome do projeto." },
        status: { type: "string", enum: VOCAB.projeto_status, description: "Status exato do projeto." },
        tags: { type: "array", items: { type: "string", enum: VOCAB.projeto_tag }, description: "Uma ou mais tags -- entra se tiver QUALQUER UMA." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  {
    name: "search_eventos",
    description:
      "Busca eventos do calendário do LifeOS por nome, tipo, projeto e " +
      "intervalo de data. Todos os filtros são opcionais e combináveis.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome do evento." },
        tipo: { type: "array", items: { type: "string", enum: VOCAB.evento_tipo }, description: "Um ou mais tipos -- entra se tiver QUALQUER UM." },
        projetos: { type: "array", items: { type: "string" }, description: "Nomes (ou trechos) do projeto vinculado (nem todo evento tem um)." },
        data_inicio: { type: "string", description: "Data mínima YYYY-MM-DD (inclusive)." },
        data_fim: { type: "string", description: "Data máxima YYYY-MM-DD (inclusive)." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  {
    name: "search_manifestacoes",
    description: "Busca manifestações do LifeOS por nome, status e tags. Todos os filtros são opcionais e combináveis.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome da manifestação." },
        status: { type: "string", enum: VOCAB.manifestacao_status, description: "Status exato." },
        tags: { type: "array", items: { type: "string", enum: VOCAB.manifestacao_tag }, description: "Uma ou mais tags -- entra se tiver QUALQUER UMA." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  {
    name: "search_movimentacoes",
    description:
      "Busca movimentações financeiras do LifeOS por nome, direção " +
      "(Entrada/Saida), meio de pagamento, categoria de gasto, intervalo " +
      "de data e faixa de valor. Todos os filtros são opcionais e " +
      "combináveis. A resposta inclui o total somado dos resultados.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Trecho do nome/descrição da movimentação." },
        direcao: { type: "string", enum: VOCAB.mov_direcao, description: "Entrada ou Saida." },
        meio: { type: "array", items: { type: "string", enum: VOCAB.mov_meio }, description: "Um ou mais meios -- entra se tiver QUALQUER UM." },
        categoria: { type: "array", items: { type: "string", enum: VOCAB.mov_categoria }, description: "Uma ou mais categorias de gasto -- entra se for QUALQUER UMA." },
        data_inicio: { type: "string", description: "Data mínima YYYY-MM-DD (inclusive)." },
        data_fim: { type: "string", description: "Data máxima YYYY-MM-DD (inclusive)." },
        valor_min: { type: "number", description: "Valor mínimo (inclusive)." },
        valor_max: { type: "number", description: "Valor máximo (inclusive)." },
        limit: { type: "integer", description: "Máximo de resultados (padrão 20, máximo 50)." },
      },
    },
  },
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const REST = `${SUPABASE_URL}/rest/v1`;
  const restHeaders = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };

  await carregarVocab(REST, restHeaders);

  // Auth de CONEXÃO: token embutido no próprio path da URL (ver comentário
  // grande no topo do arquivo). Checado ANTES de tocar no corpo JSON-RPC --
  // toda a superfície, tools/list incluso, fica atrás disso.
  const esperado = await tokenEsperado(REST, restHeaders);
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const providedToken = segments[segments.length - 1] || "";

  // Sem token configurado, NINGUEM entra. O contrario (liberar quando a
  // config falta) transformaria um erro de instalacao num servidor aberto.
  if (!esperado || providedToken !== esperado) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return respond(rpcError(null, -32700, "Parse error"));
  }

  // Notificacao (sem "id") -- por spec, servidor nao responde. O unico caso
  // que o cliente MCP manda e' "notifications/initialized", apos o handshake.
  if (msg && typeof msg === "object" && !("id" in msg) && "method" in msg) {
    return new Response(null, { status: 202, headers: cors });
  }

  const id = msg?.id ?? null;
  const method = msg?.method;
  const params = msg?.params ?? {};

  try {
    if (method === "initialize") {
      return respond(rpcResult(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lifeos-mcp", version: "2.0.0" },
      }));
    }

    if (method === "ping") return respond(rpcResult(id, {}));

    if (method === "tools/list") {
      return respond(rpcResult(id, { tools: buildTools() }));
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const handlers: Record<string, (args: Record<string, any>) => Promise<unknown>> = {
        search_notas: (a) => handleSearchNotas(REST, restHeaders, a),
        create_nota: (a) => handleCreateNota(REST, restHeaders, a),
        create_movimentacao: (a) => handleCreateMovimentacao(REST, restHeaders, a),
        search_tarefas: (a) => handleSearchTarefas(REST, restHeaders, a),
        search_projetos: (a) => handleSearchProjetos(REST, restHeaders, a),
        search_eventos: (a) => handleSearchEventos(REST, restHeaders, a),
        search_manifestacoes: (a) => handleSearchManifestacoes(REST, restHeaders, a),
        search_movimentacoes: (a) => handleSearchMovimentacoes(REST, restHeaders, a),
      };
      const handler = handlers[toolName];
      if (!handler) return respond(rpcError(id, -32602, `Unknown tool: ${String(toolName)}`));
      return respond(rpcResult(id, await handler(args)));
    }

    return respond(rpcError(id, -32601, `Method not found: ${String(method)}`));
  } catch (e) {
    return respond(rpcError(id, -32603, String(e)));
  }
});

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── Projetos: fetch compartilhado por várias tools (join/label/filtro) ───
type ProjetoRow = { id: string; name: string; emoji: string | null; status: string; tags: string[] };
async function fetchAllProjetos(REST: string, headers: Record<string, string>): Promise<ProjetoRow[]> {
  const r = await fetch(`${REST}/lifeos_projetos?order=name.asc`, { headers });
  if (!r.ok) throw new Error(`select projetos -> ${r.status} ${await r.text()}`);
  return r.json();
}
function projetoLabel(p: { name: string; emoji: string | null }) {
  return (p.emoji ? p.emoji + " " : "") + p.name;
}
// Resolve termos de filtro (substring, case-insensitive) pra um conjunto de
// projeto_ids -- usado por qualquer tool que filtre "por projeto vinculado".
// Mesmo padrão em todo domínio: nunca falha, só relata warnings se algum
// termo não bater com nenhum projeto (o filtro resultante fica vazio, então
// nada passa -- reflete corretamente "esse projeto não existe").
function resolveProjetoFiltro(projetos: ProjetoRow[], termosRaw: string[]): { ids: Set<string> | null; warnings: string[] } {
  const termos = termosRaw.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!termos.length) return { ids: null, warnings: [] };
  const matched = new Set<string>();
  const warnings: string[] = [];
  for (const termo of termos) {
    const hits = projetos.filter((p) => p.name.toLowerCase().includes(termo));
    if (!hits.length) warnings.push(`nenhum projeto encontrado com "${termo}"`);
    hits.forEach((p) => matched.add(p.id));
  }
  return { ids: matched, warnings };
}

// ── Tool: search_notas ────────────────────────────────────────────────────
async function fetchProjetoIdsByNota(REST: string, headers: Record<string, string>, notaIds: string[]) {
  const map: Record<string, string[]> = {};
  if (!notaIds.length) return map;
  const idsFilter = notaIds.join(",");
  const r = await fetch(`${REST}/lifeos_notas_projetos?nota_id=in.(${idsFilter})`, { headers });
  if (!r.ok) throw new Error(`select notas_projetos -> ${r.status} ${await r.text()}`);
  const rows: { nota_id: string; projeto_id: string }[] = await r.json();
  for (const row of rows) {
    if (!map[row.nota_id]) map[row.nota_id] = [];
    map[row.nota_id].push(row.projeto_id);
  }
  return map;
}

async function handleSearchNotas(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const tipoFiltro = strArray(args?.tipo);
  const dataInicio = args?.data_inicio ? String(args.data_inicio) : "";
  const dataFim = args?.data_fim ? String(args.data_fim) : "";
  const limit = clampLimit(args?.limit);

  const invalidTipo = tipoFiltro.filter((t) => !VOCAB.nota_tipo.includes(t));
  if (invalidTipo.length) return toolText(`Tipo(s) inválido(s): ${invalidTipo.join(", ")}. Valores aceitos: ${VOCAB.nota_tipo.join(", ")}.`, true);

  const [notasRes, projetos] = await Promise.all([
    fetch(`${REST}/lifeos_notas?order=data.desc.nullslast,created_at.desc`, { headers }),
    fetchAllProjetos(REST, headers),
  ]);
  if (!notasRes.ok) throw new Error(`select notas -> ${notasRes.status} ${await notasRes.text()}`);
  const rows = await notasRes.json();
  const projetoMap = await fetchProjetoIdsByNota(REST, headers, rows.map((r: any) => r.id));
  const projetoById = new Map(projetos.map((p) => [p.id, p]));

  const { ids: projetoIdsFiltro, warnings } = resolveProjetoFiltro(projetos, strArray(args?.projetos));

  let notas = rows.map((row: any) => ({
    id: row.id, name: row.name, tipo: row.tipo ?? [], data: row.data,
    conteudo_md: row.conteudo_md, projeto_ids: projetoMap[row.id] ?? [],
  }));

  if (nome) notas = notas.filter((n: any) => n.name.toLowerCase().includes(nome));
  if (tipoFiltro.length) notas = notas.filter((n: any) => (n.tipo || []).some((t: string) => tipoFiltro.includes(t)));
  if (projetoIdsFiltro) notas = notas.filter((n: any) => (n.projeto_ids || []).some((pid: string) => projetoIdsFiltro.has(pid)));
  if (dataInicio) notas = notas.filter((n: any) => n.data && n.data >= dataInicio);
  if (dataFim) notas = notas.filter((n: any) => n.data && n.data <= dataFim);

  const totalMatches = notas.length;
  const returned = notas.slice(0, limit).map((n: any) => ({
    id: n.id, name: n.name, tipo: n.tipo, data: n.data,
    projetos: (n.projeto_ids || []).map((pid: string) => projetoById.get(pid)).filter(Boolean).map((p: any) => ({ id: p.id, name: projetoLabel(p) })),
    snippet: noteSnippet(n.conteudo_md),
    conteudo_md: n.conteudo_md,
  }));

  return toolText(JSON.stringify({
    total_matches: totalMatches, returned: returned.length, truncated: totalMatches > returned.length,
    warnings: warnings.length ? warnings : undefined, notas: returned,
  }, null, 2));
}

// ── Tool: create_nota (escrita) ───────────────────────────────────────────
async function resolveProjetoNomes(projetos: ProjetoRow[], nomes: string[]) {
  const resolved: { id: string; name: string }[] = [];
  const naoEncontrados: string[] = [];
  for (const nomeRaw of nomes) {
    const nome = nomeRaw.trim();
    const nomeLower = nome.toLowerCase();
    let hit = projetos.find((p) => p.name.toLowerCase() === nomeLower);
    if (!hit) {
      const candidatos = projetos.filter((p) => p.name.toLowerCase().includes(nomeLower));
      if (candidatos.length === 1) hit = candidatos[0];
    }
    if (hit) resolved.push({ id: hit.id, name: projetoLabel(hit) });
    else naoEncontrados.push(nome);
  }
  return { resolved, naoEncontrados };
}

async function handleCreateNota(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const name = String(args?.name ?? "").trim();
  if (!name) return toolText("O parâmetro name (nome da nota) é obrigatório e não pode ser vazio.", true);

  const tipo = strArray(args?.tipo);
  if (!tipo.length) return toolText("O parâmetro tipo é obrigatório e precisa ter ao menos um valor.", true);
  const invalidTipo = tipo.filter((t) => !VOCAB.nota_tipo.includes(t));
  if (invalidTipo.length) return toolText(`Tipo(s) inválido(s): ${invalidTipo.join(", ")}. Valores aceitos: ${VOCAB.nota_tipo.join(", ")}.`, true);

  const projetosNomes = strArray(args?.projetos);
  if (!projetosNomes.length) return toolText("O parâmetro projetos é obrigatório e precisa ter ao menos um nome de projeto.", true);

  const conteudo_md = typeof args?.conteudo_md === "string" ? args.conteudo_md.trim() : "";
  if (!conteudo_md) return toolText("O parâmetro conteudo_md é obrigatório e não pode ser vazio.", true);

  const projetos = await fetchAllProjetos(REST, headers);
  const { resolved, naoEncontrados } = await resolveProjetoNomes(projetos, projetosNomes);
  if (naoEncontrados.length) {
    const disponiveis = projetos.map((p) => p.name).join(", ");
    return toolText(`Projeto(s) não encontrado(s) ou ambíguo(s): ${naoEncontrados.join(", ")}. Projetos existentes: ${disponiveis}.`, true);
  }

  const data = todayInSaoPaulo();
  const insertRes = await fetch(`${REST}/lifeos_notas`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ name, tipo, data, conteudo_md }),
  });
  if (!insertRes.ok) return toolText(`Erro ao salvar a nota: ${insertRes.status} ${await insertRes.text()}`, true);
  const created = (await insertRes.json())[0];

  const linkRows = resolved.map((p) => ({ nota_id: created.id, projeto_id: p.id }));
  const linkRes = await fetch(`${REST}/lifeos_notas_projetos`, { method: "POST", headers, body: JSON.stringify(linkRows) });
  if (!linkRes.ok) return toolText(`Nota criada (id ${created.id}), mas falhou ao vincular projetos: ${linkRes.status} ${await linkRes.text()}`, true);

  return toolText(JSON.stringify({
    ok: true,
    nota: { id: created.id, name: created.name, tipo: created.tipo ?? [], data: created.data, projetos: resolved, conteudo_md: created.conteudo_md, created_at: created.created_at },
  }, null, 2));
}

// ── Tool: create_movimentacao (escrita) ───────────────────────────────────
// Mesma validação de lifeos-movimentacoes (direção exatamente uma, meio e
// categoria do vocabulário, valor positivo), só que com mensagens em texto
// pro modelo LER e se corrigir. Cópia isolada, não import (LIFEOS.md §2).

// Competência de crédito, cópia de faturaDestino() em financas.js: a fatura
// fecha no ÚLTIMO dia do mês — compra antes dele cai em M+1; no último dia,
// em M+2. Só serve pra confirmação ficar útil ("vai pra fatura de outubro").
function faturaDestino(data: string): string {
  const [y, m, d] = data.split("-").map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const salto = d < ultimo ? 1 : 2;
  const alvo = new Date(Date.UTC(y, m - 1 + salto, 1));
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dataValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

async function handleCreateMovimentacao(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const name = String(args?.name ?? "").trim();
  if (!name) return toolText("O parâmetro name (descrição do gasto) é obrigatório.", true);

  const valor = Number(args?.valor);
  if (!Number.isFinite(valor) || valor <= 0) return toolText("O parâmetro valor precisa ser um número positivo — o sinal vem da direção, não do número.", true);

  const direcao = String(args?.direcao ?? "Saida");
  if (!VOCAB.mov_direcao.includes(direcao)) return toolText(`Direção inválida: ${direcao}. Valores aceitos: ${VOCAB.mov_direcao.join(", ")}.`, true);

  const meio = args?.meio ? String(args.meio).trim() : "";
  if (meio && !VOCAB.mov_meio.includes(meio)) return toolText(`Meio inválido: ${meio}. Valores aceitos: ${VOCAB.mov_meio.join(", ")}.`, true);

  const categoria = args?.categoria ? String(args.categoria).trim() : "";
  if (categoria && !VOCAB.mov_categoria.includes(categoria)) return toolText(`Categoria inválida: ${categoria}. Valores aceitos: ${VOCAB.mov_categoria.join(", ")}.`, true);

  const data = args?.data ? String(args.data).trim() : todayInSaoPaulo();
  if (!dataValida(data)) return toolText(`Data inválida: ${data}. Use YYYY-MM-DD (ex.: ${todayInSaoPaulo()}).`, true);

  const tipo = meio ? [direcao, meio] : [direcao];
  const res = await fetch(`${REST}/lifeos_movimentacoes`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ name, valor: Math.round(valor * 100) / 100, date: data, tipo, categoria: categoria || null }),
  });
  if (!res.ok) return toolText(`Erro ao gravar a movimentação: ${res.status} ${await res.text()}`, true);
  const row = (await res.json())[0];

  const credito = direcao === "Saida" && meio === "Crédito";
  const pagamentoFatura = direcao === "Saida" && !meio && /fatura/i.test(name);
  return toolText(JSON.stringify({
    ok: true,
    movimentacao: { id: row.id, name: row.name, valor: Number(row.valor), date: row.date, tipo: row.tipo, categoria: row.categoria ?? null },
    // Contexto pro modelo confirmar em linguagem natural sem adivinhar a regra.
    efeito: credito
      ? `compra no crédito: não sai do caixa agora, entra na fatura de ${faturaDestino(data)}`
      : pagamentoFatura
        ? "pagamento de fatura: abate a fatura que fecha neste mês"
        : (direcao === "Saida" ? "saída de caixa na data informada" : "entrada de caixa na data informada"),
  }, null, 2));
}

// ── Tool: search_tarefas ──────────────────────────────────────────────────
async function handleSearchTarefas(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const status = args?.status ? String(args.status) : "";
  if (status && !VOCAB.tarefa_status.includes(status)) return toolText(`Status inválido: ${status}. Valores aceitos: ${VOCAB.tarefa_status.join(", ")}.`, true);
  const tipoFiltro = strArray(args?.tipo);
  const invalidTipo = tipoFiltro.filter((t) => !VOCAB.tarefa_tipo.includes(t));
  if (invalidTipo.length) return toolText(`Tipo(s) inválido(s): ${invalidTipo.join(", ")}. Valores aceitos: ${VOCAB.tarefa_tipo.join(", ")}.`, true);
  const dataInicio = args?.data_entrega_inicio ? String(args.data_entrega_inicio) : "";
  const dataFim = args?.data_entrega_fim ? String(args.data_entrega_fim) : "";
  const limit = clampLimit(args?.limit);

  const [tarefasRes, projetos] = await Promise.all([
    fetch(`${REST}/lifeos_tarefas?order=created_at.asc`, { headers }),
    fetchAllProjetos(REST, headers),
  ]);
  if (!tarefasRes.ok) throw new Error(`select tarefas -> ${tarefasRes.status} ${await tarefasRes.text()}`);
  const rows = await tarefasRes.json();
  const projetoById = new Map(projetos.map((p) => [p.id, p]));
  const { ids: projetoIdsFiltro, warnings } = resolveProjetoFiltro(projetos, strArray(args?.projetos));

  let tarefas = rows.map((r: any) => ({ id: r.id, name: r.name, status: r.status, tipo: r.tipo ?? [], projeto_id: r.projeto_id, data_entrega: r.data_entrega }));

  if (nome) tarefas = tarefas.filter((t: any) => t.name.toLowerCase().includes(nome));
  if (status) tarefas = tarefas.filter((t: any) => t.status === status);
  if (tipoFiltro.length) tarefas = tarefas.filter((t: any) => (t.tipo || []).some((x: string) => tipoFiltro.includes(x)));
  if (projetoIdsFiltro) tarefas = tarefas.filter((t: any) => projetoIdsFiltro.has(t.projeto_id));
  if (dataInicio) tarefas = tarefas.filter((t: any) => t.data_entrega && t.data_entrega >= dataInicio);
  if (dataFim) tarefas = tarefas.filter((t: any) => t.data_entrega && t.data_entrega <= dataFim);

  const totalMatches = tarefas.length;
  const returned = tarefas.slice(0, limit).map((t: any) => ({
    id: t.id, name: t.name, status: t.status, tipo: t.tipo, data_entrega: t.data_entrega,
    projeto: projetoById.has(t.projeto_id) ? { id: t.projeto_id, name: projetoLabel(projetoById.get(t.projeto_id)!) } : null,
  }));

  return toolText(JSON.stringify({
    total_matches: totalMatches, returned: returned.length, truncated: totalMatches > returned.length,
    warnings: warnings.length ? warnings : undefined, tarefas: returned,
  }, null, 2));
}

// ── Tool: search_projetos ─────────────────────────────────────────────────
async function handleSearchProjetos(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const status = args?.status ? String(args.status) : "";
  if (status && !VOCAB.projeto_status.includes(status)) return toolText(`Status inválido: ${status}. Valores aceitos: ${VOCAB.projeto_status.join(", ")}.`, true);
  const tagsFiltro = strArray(args?.tags);
  const invalidTags = tagsFiltro.filter((t) => !VOCAB.projeto_tag.includes(t));
  if (invalidTags.length) return toolText(`Tag(s) inválida(s): ${invalidTags.join(", ")}. Valores aceitos: ${VOCAB.projeto_tag.join(", ")}.`, true);
  const limit = clampLimit(args?.limit);

  let projetos = await fetchAllProjetos(REST, headers);
  if (nome) projetos = projetos.filter((p) => p.name.toLowerCase().includes(nome));
  if (status) projetos = projetos.filter((p) => p.status === status);
  if (tagsFiltro.length) projetos = projetos.filter((p) => (p.tags || []).some((t) => tagsFiltro.includes(t)));

  const totalMatches = projetos.length;
  const returned = projetos.slice(0, limit).map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, status: p.status, tags: p.tags }));

  return toolText(JSON.stringify({
    total_matches: totalMatches, returned: returned.length, truncated: totalMatches > returned.length, projetos: returned,
  }, null, 2));
}

// ── Tool: search_eventos ──────────────────────────────────────────────────
async function handleSearchEventos(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const tipoFiltro = strArray(args?.tipo);
  const invalidTipo = tipoFiltro.filter((t) => !VOCAB.evento_tipo.includes(t));
  if (invalidTipo.length) return toolText(`Tipo(s) inválido(s): ${invalidTipo.join(", ")}. Valores aceitos: ${VOCAB.evento_tipo.join(", ")}.`, true);
  const dataInicio = args?.data_inicio ? String(args.data_inicio) : "";
  const dataFim = args?.data_fim ? String(args.data_fim) : "";
  const limit = clampLimit(args?.limit);

  const [eventosRes, projetos] = await Promise.all([
    fetch(`${REST}/lifeos_eventos?order=date.desc`, { headers }),
    fetchAllProjetos(REST, headers),
  ]);
  if (!eventosRes.ok) throw new Error(`select eventos -> ${eventosRes.status} ${await eventosRes.text()}`);
  const rows = await eventosRes.json();
  const projetoById = new Map(projetos.map((p) => [p.id, p]));
  const { ids: projetoIdsFiltro, warnings } = resolveProjetoFiltro(projetos, strArray(args?.projetos));

  let eventos = rows.map((r: any) => ({ id: r.id, name: r.name, date: r.date, tipo: r.tipo, projeto_id: r.projeto_id ?? null }));

  if (nome) eventos = eventos.filter((e: any) => e.name.toLowerCase().includes(nome));
  if (tipoFiltro.length) eventos = eventos.filter((e: any) => tipoFiltro.includes(e.tipo));
  if (projetoIdsFiltro) eventos = eventos.filter((e: any) => e.projeto_id && projetoIdsFiltro.has(e.projeto_id));
  if (dataInicio) eventos = eventos.filter((e: any) => e.date >= dataInicio);
  if (dataFim) eventos = eventos.filter((e: any) => e.date <= dataFim);

  const totalMatches = eventos.length;
  const returned = eventos.slice(0, limit).map((e: any) => ({
    id: e.id, name: e.name, date: e.date, tipo: e.tipo,
    projeto: (e.projeto_id && projetoById.has(e.projeto_id)) ? { id: e.projeto_id, name: projetoLabel(projetoById.get(e.projeto_id)!) } : null,
  }));

  return toolText(JSON.stringify({
    total_matches: totalMatches, returned: returned.length, truncated: totalMatches > returned.length,
    warnings: warnings.length ? warnings : undefined, eventos: returned,
  }, null, 2));
}

// ── Tool: search_manifestacoes ────────────────────────────────────────────
async function handleSearchManifestacoes(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const status = args?.status ? String(args.status) : "";
  if (status && !VOCAB.manifestacao_status.includes(status)) return toolText(`Status inválido: ${status}. Valores aceitos: ${VOCAB.manifestacao_status.join(", ")}.`, true);
  const tagsFiltro = strArray(args?.tags);
  const invalidTags = tagsFiltro.filter((t) => !VOCAB.manifestacao_tag.includes(t));
  if (invalidTags.length) return toolText(`Tag(s) inválida(s): ${invalidTags.join(", ")}. Valores aceitos: ${VOCAB.manifestacao_tag.join(", ")}.`, true);
  const limit = clampLimit(args?.limit);

  const r = await fetch(`${REST}/lifeos_manifestacoes?order=created_at.asc`, { headers });
  if (!r.ok) throw new Error(`select manifestacoes -> ${r.status} ${await r.text()}`);
  const rows = await r.json();

  let manifestacoes = rows.map((row: any) => ({ id: row.id, name: row.name, status: row.status, tags: row.tags ?? [], descricao: row.descricao, banner_url: row.banner_url }));
  if (nome) manifestacoes = manifestacoes.filter((m: any) => m.name.toLowerCase().includes(nome));
  if (status) manifestacoes = manifestacoes.filter((m: any) => m.status === status);
  if (tagsFiltro.length) manifestacoes = manifestacoes.filter((m: any) => (m.tags || []).some((t: string) => tagsFiltro.includes(t)));

  const totalMatches = manifestacoes.length;
  const returned = manifestacoes.slice(0, limit);

  return toolText(JSON.stringify({
    total_matches: totalMatches, returned: returned.length, truncated: totalMatches > returned.length, manifestacoes: returned,
  }, null, 2));
}

// ── Tool: search_movimentacoes (Finanças) ─────────────────────────────────
async function handleSearchMovimentacoes(REST: string, headers: Record<string, string>, args: Record<string, any>) {
  const nome = args?.nome ? String(args.nome).trim().toLowerCase() : "";
  const direcao = args?.direcao ? String(args.direcao) : "";
  if (direcao && !VOCAB.mov_direcao.includes(direcao)) return toolText(`Direção inválida: ${direcao}. Valores aceitos: ${VOCAB.mov_direcao.join(", ")}.`, true);
  const meioFiltro = strArray(args?.meio);
  const invalidMeio = meioFiltro.filter((m) => !VOCAB.mov_meio.includes(m));
  if (invalidMeio.length) return toolText(`Meio(s) inválido(s): ${invalidMeio.join(", ")}. Valores aceitos: ${VOCAB.mov_meio.join(", ")}.`, true);
  const catFiltro = strArray(args?.categoria);
  const invalidCat = catFiltro.filter((c) => !VOCAB.mov_categoria.includes(c));
  if (invalidCat.length) return toolText(`Categoria(s) inválida(s): ${invalidCat.join(", ")}. Valores aceitos: ${VOCAB.mov_categoria.join(", ")}.`, true);
  const dataInicio = args?.data_inicio ? String(args.data_inicio) : "";
  const dataFim = args?.data_fim ? String(args.data_fim) : "";
  const valorMin = args?.valor_min !== undefined ? Number(args.valor_min) : null;
  const valorMax = args?.valor_max !== undefined ? Number(args.valor_max) : null;
  const limit = clampLimit(args?.limit);

  const r = await fetch(`${REST}/lifeos_movimentacoes?order=date.desc`, { headers });
  if (!r.ok) throw new Error(`select movimentacoes -> ${r.status} ${await r.text()}`);
  const rows = await r.json();

  let movs = rows.map((row: any) => ({ id: row.id, name: row.name, valor: row.valor === null ? null : Number(row.valor), date: row.date, tipo: row.tipo ?? [], categoria: row.categoria ?? null }));

  if (nome) movs = movs.filter((m: any) => m.name.toLowerCase().includes(nome));
  if (direcao) movs = movs.filter((m: any) => (m.tipo || []).includes(direcao));
  if (meioFiltro.length) movs = movs.filter((m: any) => (m.tipo || []).some((t: string) => meioFiltro.includes(t)));
  if (catFiltro.length) movs = movs.filter((m: any) => m.categoria && catFiltro.includes(m.categoria));
  if (dataInicio) movs = movs.filter((m: any) => m.date >= dataInicio);
  if (dataFim) movs = movs.filter((m: any) => m.date <= dataFim);
  if (valorMin !== null) movs = movs.filter((m: any) => m.valor !== null && m.valor >= valorMin);
  if (valorMax !== null) movs = movs.filter((m: any) => m.valor !== null && m.valor <= valorMax);

  const totalMatches = movs.length;
  const returned = movs.slice(0, limit);
  // Soma de TODOS os resultados (não só dos devolvidos): perguntas como
  // "quanto gastei com mercado em agosto?" precisam do total mesmo quando a
  // lista vem truncada pelo limit.
  const valorTotal = Math.round(movs.reduce((s: number, m: any) => s + (m.valor ?? 0), 0) * 100) / 100;

  return toolText(JSON.stringify({
    total_matches: totalMatches, valor_total: valorTotal, returned: returned.length, truncated: totalMatches > returned.length, movimentacoes: returned,
  }, null, 2));
}
