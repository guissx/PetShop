import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {parseFilters, type Filters, type Row, type DashboardData} from '@petshop/analytics';
const allowed = ['vw_bi_periodos','vw_bi_resumo','vw_bi_evolucao','vw_bi_produtos','vw_bi_categorias','vw_bi_estado_civil','vw_bi_filiais','vw_bi_comparacao_produtos','vw_bi_concorrencia'] as const;
type View=typeof allowed[number];
function db(){
 const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SECRET_KEY;
 if(!url||!key)throw new Error('Conexão indisponível.');
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,init)=>fetch(url,{...init,cache:'no-store',signal:AbortSignal.timeout(15000)})}});
}
export async function readView(view: View, filters: Record<string,number> = {}): Promise<Row[]> {
 if(!allowed.includes(view))throw new Error('Consulta não permitida.');
 let query=db().from(view).select('*');
 for(const [key,value]of Object.entries(filters))query=query.eq(key,value);
 // Each exposed result is bounded below the PostgREST page limit by contract.
 const {data,error}=await query.limit(1000);
 if(error) {console.error('Analytics view unavailable:',view,error.code);throw new Error('Não foi possível consultar os indicadores.');}
 if(data.length>=1000)throw new Error('Resultado excede o limite de consulta.');
 return data as Row[];
}
export async function getDashboard(params:Record<string,string|undefined>):Promise<DashboardData>{
 const periods=await readView('vw_bi_periodos');const anos=[...new Set(periods.map(r=>Number(r.ano)))].sort();
 const filters=parseFilters(params,anos);return loadDashboard(filters,anos);
}
export async function loadDashboard(filters:Filters,anos:number[]):Promise<DashboardData>{
 const {ano,quadrimestre,loja}=filters;const scope={ano,quadrimestre,id_loja:loja};
 const [resumo,evolucao,produtos,categorias,estados,filiais,comparacao,concorrencia]=await Promise.all([
  readView('vw_bi_resumo',scope),readView('vw_bi_evolucao',{id_loja:loja}),readView('vw_bi_produtos',scope),readView('vw_bi_categorias',scope),readView('vw_bi_estado_civil',scope),readView('vw_bi_filiais',{ano,quadrimestre}),readView('vw_bi_comparacao_produtos',scope),loja===0?readView('vw_bi_concorrencia',{ano}):Promise.resolve([])
 ]);
 return {filters,anos,resumo:resumo[0]??null,evolucao,produtos,categorias,estados,filiais,comparacao,concorrencia,chatAvailable:Boolean(process.env.GROQ_API_KEY&&process.env.GROQ_MODEL)};
}
