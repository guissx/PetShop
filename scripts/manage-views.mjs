import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import pg from 'pg';
try { loadEnvFile(new URL('../.env', import.meta.url)); } catch(e) { if(e.code!=='ENOENT') throw e; }
const ref='ahoxobyduzludlgxtpsx';
const apply=process.argv.includes('--apply');
if(!apply && !process.argv.includes('--check')) throw new Error('Use --check ou --apply.');
if(process.env.PETSHOP_SUPABASE_PROJECT_REF!==ref) throw new Error('Projeto de destino incorreto.');
let client;
async function query(sql, readOnly=true) {
 if(process.env.SUPABASE_ACCESS_TOKEN) {
  const response=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:sql,read_only:readOnly}),signal:AbortSignal.timeout(60000)});
  if(!response.ok) throw new Error(`Management API HTTP ${response.status}`);
  return response.json();
 }
 if(!client) {
  const url=new URL(process.env.DATABASE_URL);
  if(!(url.hostname===`db.${ref}.supabase.co` || (url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username)===`postgres.${ref}`))) throw new Error('DATABASE_URL aponta para outro projeto.');
  const response=await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt');
  if(!response.ok) throw new Error('Nao foi possivel obter a CA Supabase.');
  client=new pg.Client({connectionString:url.toString(),ssl:{ca:await response.text(),rejectUnauthorized:true},connectionTimeoutMillis:15000,statement_timeout:60000});
  await client.connect();
 }
 const result=await client.query(sql);return Array.isArray(result)?result.at(-1).rows:result.rows;
}
try {
 console.log('Destino:',ref);
 console.log(await query('SELECT count(*)::int AS linhas, sum(quantidade)::int AS quantidade, sum(valor_venda)::text AS receita FROM public.fat_vendas'));
 if(apply) {await query(await readFile(new URL('../sql/03_dashboard_views.sql',import.meta.url),'utf8'),false);console.log('Views aplicadas; fatos preservados.');}
 console.log(await query('SELECT ano, receita, quantidade FROM public.vw_bi_resumo WHERE quadrimestre=0 AND id_loja=0 ORDER BY ano'));
} catch(e) {console.error('Falha:',e.code??e.message);process.exitCode=1;} finally {await client?.end().catch(()=>{});}
