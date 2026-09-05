import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createFixture} from './fixtures/dashboard-db.mjs';
import {parseFilters,scenario} from '../packages/analytics/src/index';
import {signSession,verifySession,SESSION_SECONDS} from '../packages/analytics/src/session';
import {answerQuestion,type Completion} from '../packages/analytics/src/assistant';

test('views preservam fontes, agrupam dimensoes e isolam contextos',async()=>{
 const db=await createFixture();
 try{
  const rows=async(sql:string)=>(await db.query(sql)).rows as Record<string,unknown>[];
  const [totals]=await rows('SELECT sum(itens)::int AS itens,sum(quantidade)::int AS quantidade,sum(receita)::text AS receita FROM vw_bi_resumo WHERE quadrimestre=0 AND id_loja=0');
  assert.deepEqual(totals,{itens:6621,quantidade:16482,receita:'1309440.83'});
  assert.equal((await rows('SELECT count(*)::int AS n FROM vw_bi_vendas'))[0].n,1382);
  const [single]=await rows("SELECT sum(itens)::int AS itens,sum(quantidade)::int AS quantidade,sum(receita)::text AS receita FROM vw_bi_vendas WHERE id_produto=1 AND id_loja=1 AND id_estado_civil=3 AND ano=2024 AND quadrimestre=3");
  assert.deepEqual(single,{itens:26,quantidade:58,receita:'7534.20'});
  const mismatch=await rows(`SELECT a.ano,a.id_loja FROM vw_bi_resumo a JOIN (SELECT ano,id_loja,sum(receita) AS receita FROM vw_bi_resumo WHERE quadrimestre>0 GROUP BY ano,id_loja) q USING(ano,id_loja) WHERE a.quadrimestre=0 AND a.receita<>q.receita`);
  assert.equal(mismatch.length,0);
  assert.equal((await rows('SELECT ano FROM vw_bi_participacao GROUP BY ano,quadrimestre,id_loja HAVING abs(sum(participacao_receita)-100)>0.000001 OR abs(sum(participacao_quantidade)-100)>0.000001')).length,0);
  assert.equal((await rows('SELECT * FROM vw_bi_concorrencia WHERE quantidade_concorrente IS NOT NULL')).length,0);
  const [competitor]=await rows('SELECT (SELECT sum(receita_concorrente) FROM vw_bi_concorrencia WHERE quadrimestre=0)=(SELECT sum(valor_venda) FROM fat_concorrente) AS ok');assert.equal(competitor.ok,true);
  assert.equal((await rows('SELECT * FROM vw_bi_resumo WHERE ano=2024 AND variacao_receita IS NOT NULL')).length,0);
  assert.equal((await rows('SELECT * FROM vw_bi_resumo WHERE ano=1999')).length,0);
  assert.equal((await rows("SELECT has_table_privilege('anon','public.vw_bi_resumo','SELECT') AS ok"))[0].ok,false);
  assert.equal((await rows("SELECT has_table_privilege('authenticated','public.vw_bi_resumo','SELECT') AS ok"))[0].ok,false);
  await db.exec('SET ROLE service_role');assert.equal((await rows('SELECT count(*)::int AS n FROM vw_bi_resumo WHERE quadrimestre=0 AND id_loja=0'))[0].n,2);await db.exec('RESET ROLE');
  // Reapplying does not change data or fail because of dependencies.
  await db.exec(await readFile(new URL('../sql/03_dashboard_views.sql',import.meta.url),'utf8'));
  assert.equal((await rows('SELECT count(*)::int AS n FROM fat_vendas'))[0].n,6621);
  // Synthetic mutation inside a rolled-back transaction tests disappearance and zero baseline.
  await db.exec('BEGIN; DELETE FROM fat_vendas WHERE sk_produto=1 AND id_data IN (SELECT id_data FROM dim_data WHERE ano=2025);');
  const [absent]=await rows('SELECT quantidade,diferenca_quantidade,quantidade_anterior FROM vw_bi_comparacao_produtos WHERE ano=2025 AND quadrimestre=0 AND id_loja=0 AND id_produto=1');
  assert.equal(Number(absent.quantidade),0);assert.equal(Number(absent.diferenca_quantidade),-Number(absent.quantidade_anterior));await db.exec('ROLLBACK');
  await db.exec('BEGIN; UPDATE fat_vendas SET valor_venda=0 WHERE id_data IN (SELECT id_data FROM dim_data WHERE ano=2024);');
  assert.equal((await rows('SELECT variacao_receita FROM vw_bi_resumo WHERE ano=2025 AND quadrimestre=0 AND id_loja=0'))[0].variacao_receita,null);await db.exec('ROLLBACK');
  // An obsolete SCD version remains in historical facts; current-only joins would lose it.
  await db.exec("BEGIN; UPDATE dim_produto SET flag_atual=false,data_fim='2026-01-01' WHERE sk_produto=1; INSERT INTO dim_produto(sk_produto,id_produto,produto,categoria,data_inicio) OVERRIDING SYSTEM VALUE VALUES (100,1,'Nova versão','Nova categoria','2026-01-01');");
  assert.equal((await rows('SELECT sum(itens)::int AS n FROM vw_bi_resumo WHERE quadrimestre=0 AND id_loja=0'))[0].n,6621);await db.exec('ROLLBACK');
  await db.exec('BEGIN; UPDATE fat_vendas SET quantidade=1,valor_venda=1;');
  const ranks=await rows('SELECT * FROM vw_bi_produtos WHERE ano=2025 AND quadrimestre=0 AND id_loja=0 ORDER BY receita DESC');
  for(let i=1;i<ranks.length;i++)if(ranks[i].receita===ranks[i-1].receita)assert.equal(ranks[i].ranking_receita,ranks[i-1].ranking_receita);await db.exec('ROLLBACK');
 }finally{await db.close();}
});
test('filtros e cenarios rejeitam valores invalidos',()=>{
 assert.deepEqual(parseFilters({},[2024,2025]),{ano:2025,quadrimestre:0,loja:0});
 assert.throws(()=>parseFilters({ano:'2026'},[2024,2025]));assert.throws(()=>parseFilters({loja:'-1'},[2025]));assert.throws(()=>parseFilters({quadrimestre:'4'},[2025]));
 assert.deepEqual(scenario(100,10),{base:100,percent:10,projected:110,difference:10});assert.equal(scenario(100,-100).projected,0);assert.throws(()=>scenario(100,-101));assert.throws(()=>scenario(NaN,5));
});
test('sessao assinada expira e rejeita adulteracao',()=>{
 const secret='s'.repeat(64),now=Date.now();const token=signSession(secret,now);
 assert.equal(verifySession(token,secret,now),true);assert.equal(verifySession(token+'x',secret,now),false);assert.equal(verifySession(token,'x'.repeat(64),now),false);assert.equal(verifySession(token,secret,now+SESSION_SECONDS*1000),false);assert.equal(verifySession(undefined,secret),false);
});
test('chat usa ferramentas restritas e calculo deterministico',async()=>{
 const f={ano:2025,quadrimestre:0,loja:0};
 const tool:Completion=async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'1',function:{name:'simular_receita',arguments:'{"percentual":10}'}}]}}]});
 const answer=await answerQuestion([{role:'user',content:'simule mais 10%'}],f,async()=>({receita:100}),tool);assert.match(answer,/110,00/);assert.match(answer,/não uma previsão/);
 await assert.rejects(()=>answerQuestion([{role:'user',content:'simule crescimento'}],f,async()=>({receita:100}),tool),/explicitamente/);
 const bad:Completion=async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'1',function:{name:'execute_sql',arguments:'{}'}}]}}]});
 await assert.rejects(()=>answerQuestion([{role:'user',content:'delete'}],f,async()=>null,bad),/não permitida/);
 await assert.rejects(()=>answerQuestion([{role:'user',content:'resumo'}],f,async()=>null,async()=>{throw new Error('429 limite');}),/429/);
});
