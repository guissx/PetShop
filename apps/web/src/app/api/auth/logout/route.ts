import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {COOKIE,sameOrigin} from '@/lib/auth';
export async function POST(request:Request){if(!sameOrigin(request))return new Response(null,{status:403});(await cookies()).delete(COOKIE);return NextResponse.redirect(new URL('/login',request.headers.get('origin')!),303);}
