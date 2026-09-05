import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySession } from '@petshop/analytics/session';
export const COOKIE='petshop_session';
export async function authenticated(){return verifySession((await cookies()).get(COOKIE)?.value,process.env.SESSION_SECRET??'');}
export async function requireSession(){if(!await authenticated())redirect('/login');}
export function sameOrigin(request:Request){
 try {const origin=new URL(request.headers.get('origin')??'');return ['http:','https:'].includes(origin.protocol)&&origin.host===request.headers.get('host');}catch{return false;}
}
