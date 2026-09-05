import {z} from 'zod';
import {authenticated,sameOrigin} from '@/lib/auth';
import {readView} from '@/lib/data';
import {answerQuestion,type Completion} from '@petshop/analytics/assistant';
import {parseFilters} from '@petshop/analytics';
import {resolveChatFilters} from '@petshop/analytics/chat-context';
import {forecastIntent,forecastRevenue,conversationFilters} from '@petshop/analytics/forecast';
class ProviderError extends Error {
 constructor(message:string,readonly status:number){super(message);}
}
export const maxDuration=60;
const input=z.object({messages:z.array(z.discriminatedUnion('role',[
 z.object({role:z.literal('user'),content:z.string().min(1).max(1500)}),
 z.object({role:z.literal('assistant'),content:z.string().min(1).max(24000)})
])).min(1).max(10),filters:z.object({ano:z.number().int(),quadrimestre:z.number().int(),loja:z.number().int()})});
export async function POST(request:Request){
 if(!await authenticated())return Response.json({error:'Faça login.'},{status:401});
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const key=process.env.GROQ_API_KEY,model=process.env.GROQ_MODEL;
 if(!key||!model)return Response.json({error:'O assistente ainda não está disponível.'},{status:503});
 const text=await request.text();if(text.length>128000)return Response.json({error:'Conversa muito longa. Inicie uma nova consulta.'},{status:413});
 let body;try{body=input.parse(JSON.parse(text));if(body.messages.at(-1)?.role!=='user')throw new Error();}catch{return Response.json({error:'Pergunta inválida.'},{status:400});}
 const complete:Completion=async payload=>{
  const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,...(model.startsWith('openai/gpt-oss-')?{reasoning_effort:'low'}:{}),...payload}),signal:AbortSignal.timeout(18000)});
  if(response.status===429)throw new ProviderError('O limite da Groq foi atingido. Aguarde um pouco e tente novamente.',429);
  if(!response.ok){console.error('Groq completion failed',{status:response.status,model});throw new ProviderError('A Groq não conseguiu processar a consulta. Tente novamente em instantes.',502);}
  return response.json();
 };
 try{
  const periods=await readView('vw_bi_periodos');const years=periods.map(r=>Number(r.ano));
  const selected=parseFilters(Object.fromEntries(Object.entries(body.filters).map(([k,v])=>[k,String(v)])),years);
  const context=conversationFilters(body.messages.slice(0,-1),selected,years);
  const latest=body.messages.at(-1)!.content;
  const lastYear=Math.max(...years);
  let previousTargets:number[]=[];
  for(const message of body.messages.slice(0,-1))if(message.role==='user'){
   try{previousTargets=forecastIntent(message.content,lastYear,previousTargets)??previousTargets;}catch{/* Ignore rejected requests in history. */}
  }
  const targets=forecastIntent(latest,lastYear,previousTargets);
  if(targets!==null){
   const scope=resolveChatFilters(latest.replace(/\b20\d{2}\b/g,''),context,years);
   const rows=await readView('vw_bi_evolucao',{id_loja:scope.loja});
   return Response.json({answer:targets.map(target=>forecastRevenue(rows,lastYear,target,scope.loja)).join('\n\n──────────\n\n')},{headers:{'Cache-Control':'private, no-store'}});
  }
  const modelCheck=await fetch('https://api.groq.com/openai/v1/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000)});
  if(modelCheck.status===429)throw new ProviderError('O limite da Groq foi atingido. Aguarde um pouco e tente novamente.',429);
  if(!modelCheck.ok)return Response.json({error:'O modelo do assistente não está disponível para esta conta.'},{status:503});
  const models=await modelCheck.json() as {data?:{id:string;active?:boolean}[]};
  if(!models.data?.some(item=>item.id===model&&item.active!==false))return Response.json({error:'O modelo do assistente não está disponível para esta conta.'},{status:503});
  const f=resolveChatFilters(latest,context,years);
  const scope={ano:f.ano,quadrimestre:f.quadrimestre,id_loja:f.loja};
  const answer=await answerQuestion(body.messages,f,async topic=>{
   if(topic==='resumo')return (await readView('vw_bi_resumo',scope))[0]??null;
   if(topic==='produtos')return readView('vw_bi_produtos',scope);
   if(topic==='evolucao')return (await readView('vw_bi_evolucao',{ano:f.ano,id_loja:f.loja})).filter(row=>Number(row.quadrimestre)>0).sort((a,b)=>Number(b.receita)-Number(a.receita)||Number(a.quadrimestre)-Number(b.quadrimestre));
   if(f.loja)return {indisponivel:'Concorrência disponível somente para toda a rede.'};
   return readView('vw_bi_concorrencia',{ano:f.ano,quadrimestre:f.quadrimestre});
  },complete);
  return Response.json({answer},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(error instanceof ProviderError)return Response.json({error:error.message},{status:error.status});
  if(error instanceof Error&&/TimeoutError|AbortError/.test(error.name))return Response.json({error:'A consulta demorou além do limite. Tente novamente em instantes.'},{status:504});
  const known=error instanceof Error&&/Previsão:|Informe explicitamente|Não há receita|Consulta não permitida|muito ampla|Consulte um ano|ano informado|Filtros inválidos/.test(error.message);
  console.error('Chat request failed',{kind:error instanceof Error?error.name:'Unknown',validation:known});
  return Response.json({error:known?error.message:'Não foi possível concluir a consulta. Tente novamente em instantes.'},{status:known?400:502});
 }
}
