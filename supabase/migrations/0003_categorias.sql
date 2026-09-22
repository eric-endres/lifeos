-- ════════════════════════════════════════════════════════════════════════
-- 0003_categorias.sql — categoria nas movimentações financeiras
--
-- Até aqui uma movimentação tinha só direção (Entrada/Saida) e meio de
-- pagamento, os dois misturados no array `tipo`. "Onde o dinheiro foi" não
-- existia como dado — FINANCAS.md §10 listava isso como o que faltava.
--
-- Esta migration adiciona:
--   1. a coluna `categoria` (escalar, opcional) em lifeos_movimentacoes;
--   2. o domínio `mov_categoria` em lifeos_vocabularios, com cor — editável
--      em LifeOS → menu → Tags, como os tipos de evento;
--   3. o ramo `mov_categoria` nas RPCs de renomear e de contar uso.
--
-- Por que uma coluna própria e não mais uma tag em `tipo`: direção e meio já
-- dividem aquele array por herança do Notion (FINANCAS.md §7), e toda a
-- conta de saldo e fatura lê o array com `includes`. Uma categoria chamada
-- "Crédito" ou "Pix" colidiria com a lógica. Coluna separada não colide.
--
-- ⚠ NÃO destrói dado. A coluna nasce nula; linhas antigas continuam
--   válidas e aparecem como "Sem categoria". Rodar de novo é seguro.
-- ════════════════════════════════════════════════════════════════════════

alter table public.lifeos_movimentacoes
  add column if not exists categoria text;

-- ────────────────────────────────────────────────────────────────────────
-- SEED DO VOCABULÁRIO
--
-- As oito primeiras levam cor, na ORDEM de uma paleta categórica validada
-- para daltonismo contra o fundo escuro do painel (pior par vizinho ΔE 8,4,
-- visão normal ΔE 19,3, contraste ≥ 3:1 em todas). A ordem importa: o donut
-- de Finanças desenha as fatias na `ordem` do vocabulário, não por valor,
-- justamente para que as vizinhas no círculo sejam os pares validados.
--
-- As demais nascem SEM cor: no gráfico elas se agrupam em "Outras" (cinza).
-- Oito fatias é o teto — uma nona cor ficaria indistinguível das vizinhas.
-- Se mais de oito categorias tiverem cor (dá para colorir em Tags), o donut
-- mostra as sete maiores do mês e agrupa o resto em "Outras"; o ranking ao
-- lado continua listando todas, com nome.
-- ────────────────────────────────────────────────────────────────────────

insert into public.lifeos_vocabularios (dominio, valor, cor, ordem, protegido)
values
  ('mov_categoria', 'Moradia',     '#3987e5',  10, false),
  ('mov_categoria', 'Transporte',  '#d95926',  20, false),
  ('mov_categoria', 'Mercado',     '#199e70',  30, false),
  ('mov_categoria', 'Sítio',       '#c98500',  40, false),
  ('mov_categoria', 'Restaurante', '#d55181',  50, false),
  ('mov_categoria', 'Saúde',       '#008300',  60, false),
  ('mov_categoria', 'Compras',     '#9085e9',  70, false),
  ('mov_categoria', 'Lazer',       '#e66767',  80, false),
  ('mov_categoria', 'Serviços',     null,      90, false),
  ('mov_categoria', 'Educação',     null,     100, false),
  ('mov_categoria', 'Alimentação',  null,     110, false),
  ('mov_categoria', 'Beleza',       null,     120, false),
  ('mov_categoria', 'Vestuário',    null,     130, false),
  ('mov_categoria', 'Eletrônicos',  null,     140, false),
  ('mov_categoria', 'Outros',       null,     150, false)
on conflict (dominio, valor) do nothing;

-- ────────────────────────────────────────────────────────────────────────
-- RPCs — as duas de 0002 ganham o ramo `mov_categoria` (coluna escalar).
-- Corpo completo repetido porque `create or replace` troca a função inteira.
-- ────────────────────────────────────────────────────────────────────────

create or replace function public.lifeos_renomear_vocabulario(
  p_dominio text, p_de text, p_para text
) returns integer language plpgsql security definer set search_path to '' as $$
declare
  v_linhas integer := 0;
begin
  if p_de = p_para then return 0; end if;

  if not exists (
    select 1 from public.lifeos_vocabularios
    where dominio = p_dominio and valor = p_de
  ) then
    raise exception 'valor_inexistente';
  end if;

  if exists (
    select 1 from public.lifeos_vocabularios
    where dominio = p_dominio and valor = p_para
  ) then
    raise exception 'valor_duplicado';
  end if;

  case p_dominio
    when 'nota_tipo' then
      update public.lifeos_notas set tipo = array_replace(tipo, p_de, p_para)
       where p_de = any(tipo);
    when 'tarefa_status' then
      update public.lifeos_tarefas set status = p_para where status = p_de;
    when 'tarefa_tipo' then
      update public.lifeos_tarefas set tipo = array_replace(tipo, p_de, p_para)
       where p_de = any(tipo);
    when 'projeto_status' then
      update public.lifeos_projetos set status = p_para where status = p_de;
    when 'projeto_tag' then
      update public.lifeos_projetos set tags = array_replace(tags, p_de, p_para)
       where p_de = any(tags);
    when 'evento_tipo' then
      update public.lifeos_eventos set tipo = p_para where tipo = p_de;
    when 'manifestacao_status' then
      update public.lifeos_manifestacoes set status = p_para where status = p_de;
    when 'manifestacao_tag' then
      update public.lifeos_manifestacoes set tags = array_replace(tags, p_de, p_para)
       where p_de = any(tags);
    when 'mov_direcao', 'mov_meio' then
      update public.lifeos_movimentacoes set tipo = array_replace(tipo, p_de, p_para)
       where p_de = any(tipo);
    when 'mov_categoria' then
      update public.lifeos_movimentacoes set categoria = p_para where categoria = p_de;
    else
      raise exception 'dominio_invalido';
  end case;

  get diagnostics v_linhas = row_count;

  update public.lifeos_vocabularios
     set valor = p_para
   where dominio = p_dominio and valor = p_de;

  return v_linhas;
end;
$$;

create or replace function public.lifeos_uso_vocabulario(
  p_dominio text, p_valor text
) returns integer language plpgsql security definer set search_path to '' as $$
declare v_n integer := 0;
begin
  case p_dominio
    when 'nota_tipo' then
      select count(*) into v_n from public.lifeos_notas where p_valor = any(tipo);
    when 'tarefa_status' then
      select count(*) into v_n from public.lifeos_tarefas where status = p_valor;
    when 'tarefa_tipo' then
      select count(*) into v_n from public.lifeos_tarefas where p_valor = any(tipo);
    when 'projeto_status' then
      select count(*) into v_n from public.lifeos_projetos where status = p_valor;
    when 'projeto_tag' then
      select count(*) into v_n from public.lifeos_projetos where p_valor = any(tags);
    when 'evento_tipo' then
      select count(*) into v_n from public.lifeos_eventos where tipo = p_valor;
    when 'manifestacao_status' then
      select count(*) into v_n from public.lifeos_manifestacoes where status = p_valor;
    when 'manifestacao_tag' then
      select count(*) into v_n from public.lifeos_manifestacoes where p_valor = any(tags);
    when 'mov_direcao', 'mov_meio' then
      select count(*) into v_n from public.lifeos_movimentacoes where p_valor = any(tipo);
    when 'mov_categoria' then
      select count(*) into v_n from public.lifeos_movimentacoes where categoria = p_valor;
    else
      raise exception 'dominio_invalido';
  end case;
  return v_n;
end;
$$;

-- `create or replace` preserva os grants existentes, mas repetir deixa o
-- arquivo correto sozinho num banco onde 0002 não tenha rodado os revokes.
revoke execute on function public.lifeos_renomear_vocabulario(text, text, text) from public, anon, authenticated;
revoke execute on function public.lifeos_uso_vocabulario(text, text) from public, anon, authenticated;
grant  execute on function public.lifeos_renomear_vocabulario(text, text, text) to service_role;
grant  execute on function public.lifeos_uso_vocabulario(text, text) to service_role;
