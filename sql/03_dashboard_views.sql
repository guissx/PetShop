-- Somente views: nao altera fatos, dimensoes ou dados do ETL.
BEGIN;

-- CREATE OR REPLACE VIEW nao remove coluna. Quando fat_vendas passou ao grao
-- agregado a medida de itens deixou de existir, e o replace falharia com
--   ERROR: cannot drop columns from view
-- Derrubar na ordem inversa da dependencia e recriar logo abaixo mantem o
-- arquivo idempotente e reaplicavel. Sem CASCADE de proposito: uma dependencia
-- nao prevista tem que aparecer como erro, nao sumir em silencio.
DO $$ DECLARE v text; BEGIN
 FOREACH v IN ARRAY ARRAY['vw_bi_concorrencia','vw_bi_comparacao_produtos','vw_bi_filiais','vw_bi_estado_civil','vw_bi_categorias','vw_bi_participacao','vw_bi_produtos','vw_bi_evolucao','vw_bi_resumo','vw_bi_totais','vw_bi_periodos','vw_bi_contexto','vw_bi_vendas'] LOOP
  EXECUTE format('DROP VIEW IF EXISTS public.%I',v);
 END LOOP;
END $$;

-- fat_vendas ja esta no grao produto x loja x quadrimestre x estado civil, entao
-- esta view e 1:1 com o fato. O GROUP BY continua aqui de proposito: ele agrupa
-- por id_produto/id_loja (chave natural), nao por sk, e portanto reune as
-- versoes SCD2 do mesmo produto — que e o que o BI quer ver.
--
-- Nao existe medida de linhas de pedido: no grao agregado o DW nao sabe quantos
-- itens formaram cada fato. Essa contagem vive em stg.cln_fat_vendas.
CREATE VIEW public.vw_bi_vendas WITH (security_invoker=true) AS
SELECT p.sk_produto, p.id_produto, p.produto, p.categoria,
       l.sk_loja, l.id_loja, l.loja, l.cidade, e.id_estado_civil, e.estado_civil,
       d.ano, d.quadrimestre,
       sum(f.quantidade)::bigint AS quantidade, sum(f.valor_venda)::numeric AS receita
FROM public.fat_vendas f
JOIN public.dim_produto p ON p.sk_produto=f.sk_produto
JOIN public.dim_loja l ON l.sk_loja=f.sk_loja
JOIN public.dim_estado_civil e ON e.id_estado_civil=f.id_estado_civil
JOIN public.dim_data d ON d.id_data=f.id_data
GROUP BY p.sk_produto,p.id_produto,p.produto,p.categoria,l.sk_loja,l.id_loja,l.loja,l.cidade,e.id_estado_civil,e.estado_civil,d.ano,d.quadrimestre;

-- Cada fato participa de quatro contextos disjuntos de consulta.
-- quadrimestre=0 significa anual; id_loja=0 significa rede.
CREATE VIEW public.vw_bi_contexto WITH (security_invoker=true) AS
SELECT v.id_produto,v.produto,v.categoria,v.id_estado_civil,v.estado_civil,v.ano,
       q.quadrimestre,s.id_loja,s.loja,s.cidade,
       CASE WHEN q.quadrimestre=0 THEN 'anual' ELSE 'quadrimestral' END AS granularidade,
       CASE WHEN s.id_loja=0 THEN 'rede' ELSE 'filial' END AS abrangencia,
       sum(v.quantidade)::bigint AS quantidade,sum(v.receita)::numeric AS receita
FROM public.vw_bi_vendas v
CROSS JOIN LATERAL (VALUES (0),(v.quadrimestre)) q(quadrimestre)
CROSS JOIN LATERAL (VALUES (0,'Toda a rede'::text,'Todas as cidades'::text),(v.id_loja,v.loja::text,v.cidade::text)) s(id_loja,loja,cidade)
GROUP BY v.id_produto,v.produto,v.categoria,v.id_estado_civil,v.estado_civil,v.ano,q.quadrimestre,s.id_loja,s.loja,s.cidade;

CREATE VIEW public.vw_bi_periodos WITH (security_invoker=true) AS
SELECT DISTINCT ano,quadrimestre FROM public.dim_data;

CREATE VIEW public.vw_bi_totais WITH (security_invoker=true) AS
SELECT ano,quadrimestre,id_loja,granularidade,abrangencia,
       sum(quantidade)::bigint AS quantidade,sum(receita)::numeric AS receita
FROM public.vw_bi_contexto GROUP BY ano,quadrimestre,id_loja,granularidade,abrangencia;

CREATE VIEW public.vw_bi_resumo WITH (security_invoker=true) AS
SELECT a.*,b.receita AS receita_anterior,b.quantidade AS quantidade_anterior,
       a.receita-b.receita AS diferenca_receita,a.quantidade-b.quantidade AS diferenca_quantidade,
       100.0*(a.receita-b.receita)/NULLIF(b.receita,0) AS variacao_receita,
       100.0*(a.quantidade-b.quantidade)/NULLIF(b.quantidade,0) AS variacao_quantidade
FROM public.vw_bi_totais a LEFT JOIN public.vw_bi_totais b
 ON b.ano=a.ano-1 AND b.quadrimestre=a.quadrimestre AND b.id_loja=a.id_loja;

CREATE VIEW public.vw_bi_evolucao WITH (security_invoker=true) AS
SELECT * FROM public.vw_bi_resumo WHERE quadrimestre<>0;

CREATE VIEW public.vw_bi_produtos WITH (security_invoker=true) AS
WITH agregado AS (
 SELECT ano,quadrimestre,id_loja,granularidade,abrangencia,id_produto,produto,categoria,
        sum(quantidade)::bigint AS quantidade,sum(receita)::numeric AS receita
 FROM public.vw_bi_contexto GROUP BY ano,quadrimestre,id_loja,granularidade,abrangencia,id_produto,produto,categoria
)
SELECT *,dense_rank() OVER (PARTITION BY ano,quadrimestre,id_loja ORDER BY quantidade DESC) AS ranking_quantidade,
         dense_rank() OVER (PARTITION BY ano,quadrimestre,id_loja ORDER BY receita DESC) AS ranking_receita,
         100.0*receita/NULLIF(sum(receita) OVER (PARTITION BY ano,quadrimestre,id_loja),0) AS participacao_receita,
         100.0*quantidade/NULLIF(sum(quantidade) OVER (PARTITION BY ano,quadrimestre,id_loja),0) AS participacao_quantidade
FROM agregado;

CREATE VIEW public.vw_bi_participacao WITH (security_invoker=true) AS
SELECT * FROM public.vw_bi_produtos;

CREATE VIEW public.vw_bi_categorias WITH (security_invoker=true) AS
SELECT ano,quadrimestre,id_loja,granularidade,abrangencia,categoria,
 sum(quantidade)::bigint AS quantidade,sum(receita)::numeric AS receita
FROM public.vw_bi_contexto GROUP BY ano,quadrimestre,id_loja,granularidade,abrangencia,categoria;

CREATE VIEW public.vw_bi_estado_civil WITH (security_invoker=true) AS
SELECT ano,quadrimestre,id_loja,granularidade,abrangencia,id_estado_civil,estado_civil,
 sum(quantidade)::bigint AS quantidade,sum(receita)::numeric AS receita
FROM public.vw_bi_contexto GROUP BY ano,quadrimestre,id_loja,granularidade,abrangencia,id_estado_civil,estado_civil;

CREATE VIEW public.vw_bi_filiais WITH (security_invoker=true) AS
SELECT r.*,l.loja,l.cidade FROM public.vw_bi_resumo r
JOIN (SELECT DISTINCT id_loja,loja,cidade FROM public.vw_bi_contexto WHERE id_loja<>0) l USING(id_loja)
WHERE r.id_loja<>0;

-- Une as chaves dos dois anos para incluir produtos sem vendas no ano atual.
CREATE VIEW public.vw_bi_comparacao_produtos WITH (security_invoker=true) AS
WITH p AS (
 SELECT ano,quadrimestre,id_loja,id_produto,min(produto) AS produto,
        sum(quantidade)::bigint AS quantidade,sum(receita)::numeric AS receita
 FROM public.vw_bi_produtos GROUP BY ano,quadrimestre,id_loja,id_produto
), chaves AS (
 SELECT ano,quadrimestre,id_loja,id_produto FROM p
 UNION SELECT ano+1,quadrimestre,id_loja,id_produto FROM p
)
SELECT k.*,coalesce(a.produto,b.produto) AS produto,
 coalesce(a.quantidade,0)::bigint AS quantidade,
 CASE WHEN EXISTS(SELECT 1 FROM public.vw_bi_periodos d WHERE d.ano=k.ano-1) THEN coalesce(b.quantidade,0) END AS quantidade_anterior,
 CASE WHEN EXISTS(SELECT 1 FROM public.vw_bi_periodos d WHERE d.ano=k.ano-1) THEN coalesce(a.quantidade,0)-coalesce(b.quantidade,0) END AS diferenca_quantidade,
 100.0*(coalesce(a.quantidade,0)-b.quantidade)/NULLIF(b.quantidade,0) AS variacao_quantidade
FROM chaves k LEFT JOIN p a USING(ano,quadrimestre,id_loja,id_produto)
LEFT JOIN p b ON b.ano=k.ano-1 AND b.quadrimestre=k.quadrimestre AND b.id_loja=k.id_loja AND b.id_produto=k.id_produto
WHERE EXISTS(SELECT 1 FROM public.vw_bi_periodos d WHERE d.ano=k.ano);

CREATE VIEW public.vw_bi_concorrencia WITH (security_invoker=true) AS
WITH concorrente AS (
 SELECT d.ano,q.quadrimestre,sum(f.valor_venda)::numeric AS receita_concorrente
 FROM public.fat_concorrente f JOIN public.dim_data d USING(id_data)
 CROSS JOIN LATERAL (VALUES(0),(d.quadrimestre)) q(quadrimestre)
 GROUP BY d.ano,q.quadrimestre
)
SELECT coalesce(n.ano,c.ano) AS ano,coalesce(n.quadrimestre,c.quadrimestre) AS quadrimestre,
 n.receita AS receita_rede,c.receita_concorrente,
 n.receita-c.receita_concorrente AS diferenca_receita,
 100.0*(n.receita-c.receita_concorrente)/NULLIF(c.receita_concorrente,0) AS diferenca_percentual,
 NULL::bigint AS quantidade_concorrente
FROM (SELECT * FROM public.vw_bi_totais WHERE id_loja=0) n
FULL JOIN concorrente c USING(ano,quadrimestre);

DO $$ DECLARE v text; BEGIN
 FOREACH v IN ARRAY ARRAY['vw_bi_vendas','vw_bi_contexto','vw_bi_periodos','vw_bi_totais','vw_bi_resumo','vw_bi_evolucao','vw_bi_produtos','vw_bi_participacao','vw_bi_categorias','vw_bi_estado_civil','vw_bi_filiais','vw_bi_comparacao_produtos','vw_bi_concorrencia'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',v);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',v);
 END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
