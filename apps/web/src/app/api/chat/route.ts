import {z} from 'zod';
import {authenticated,sameOrigin} from '@/lib/auth';
import {readView} from '@/lib/data';
import {answerQuestion,type Completion} from '@petshop/analytics/assistant';
import {parseFilters} from '@petshop/analytics';
export const maxDuration=60;
const input=z.object({messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(1500)})).min(1).max(10),filters:z.object({ano:z.number().int(),quadrimestre:z.number().int(),loja:z.number().int()})});
export async function POST(request:Request){
 if(!await authenticated())return Response.json({error:'Faça login.'},{status:401});
 if(!sameOrigin(request))return Response.json({error:'Origem inválida.'},{status:403});
 const key=process.env.GROQ_API_KEY,model=process.env.GROQ_MODEL;
 if(!key||!model)return Response.json({error:'O assistente ainda não está disponível.'},{status:503});
 const text=await request.text();if(text.length>18000)return Response.json({error:'Mensagem muito longa.'},{status:413});
 let body;try{body=input.parse(JSON.parse(text));if(body.messages.at(-1)?.role!=='user')throw new Error();}catch{return Response.json({error:'Pergunta inválida.'},{status:400});}
 const complete:Completion=async payload=>{
  const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,...payload}),signal:AbortSignal.timeout(18000)});
  if(response.status===429)throw new Error('O limite do assistente foi atingido. Aguarde um pouco e tente novamente.');
  if(!response.ok)throw new Error('O assistente está indisponível no momento.');
  return response.json();
 };
 try{
  const modelCheck=await fetch('https://api.groq.com/openai/v1/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000)});
  if(!modelCheck.ok)return Response.json({error:'O modelo do assistente não está disponível para esta conta.'},{status:503});
  const models=await modelCheck.json() as {data?:{id:string;active?:boolean}[]};
  if(!models.data?.some(item=>item.id===model&&item.active!==false))return Response.json({error:'O modelo do assistente não está disponível para esta conta.'},{status:503});
  const periods=await readView('vw_bi_periodos');const f=parseFilters(Object.fromEntries(Object.entries(body.filters).map(([k,v])=>[k,String(v)])),periods.map(r=>Number(r.ano)));
  const scope={ano:f.ano,quadrimestre:f.quadrimestre,id_loja:f.loja};
  const answer=await answerQuestion(body.messages,f,async topic=>{
   if(topic==='resumo')return (await readView('vw_bi_resumo',scope))[0]??null;
   if(topic==='produtos')return readView('vw_bi_produtos',scope);
   if(f.loja)return {indisponivel:'Concorrência disponível somente para toda a rede.'};
   return readView('vw_bi_concorrencia',{ano:f.ano,quadrimestre:f.quadrimestre});
  },complete);
  return Response.json({answer},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){const known=error instanceof Error&&/limite|Informe explicitamente|Não há receita|Consulta não permitida|muito ampla/.test(error.message);return Response.json({error:known?error.message:'Não foi possível concluir a consulta. Tente novamente em instantes.'},{status:503});}
}
