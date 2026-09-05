import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {constantEqual,signSession,SESSION_SECONDS} from '@petshop/analytics/session';
import {COOKIE,sameOrigin} from '@/lib/auth';
export async function POST(request:Request){
 if(!sameOrigin(request))return NextResponse.json({error:'Origem inválida.'},{status:403});
 const form=await request.formData();
 const normalizeUser=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').trim().toLowerCase();
 const username=normalizeUser(String(form.get('username')??''));const password=String(form.get('password')??'');
 const target=new URL('/login',request.headers.get('origin')!);
 if(!process.env.DEMO_USERNAME||!process.env.DEMO_PASSWORD||!process.env.SESSION_SECRET){target.searchParams.set('error','config');return NextResponse.redirect(target,303);}
 if(!constantEqual(username,normalizeUser(process.env.DEMO_USERNAME))||!constantEqual(password,process.env.DEMO_PASSWORD)){await new Promise(r=>setTimeout(r,500));target.searchParams.set('error','credentials');return NextResponse.redirect(target,303);}
 (await cookies()).set(COOKIE,signSession(process.env.SESSION_SECRET),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:SESSION_SECONDS});
 return NextResponse.redirect(new URL('/',request.headers.get('origin')!),303);
}
