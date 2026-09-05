import {authenticated} from '@/lib/auth';
import {getDashboard} from '@/lib/data';
export async function GET(request:Request){
 if(!await authenticated())return Response.json({error:'Faça login.'},{status:401});
 try {return Response.json(await getDashboard(Object.fromEntries(new URL(request.url).searchParams)),{headers:{'Cache-Control':'private, no-store'}});}
 catch{return Response.json({error:'Indicadores indisponíveis ou filtros inválidos.'},{status:503});}
}
