import {notFound} from 'next/navigation';
import {requireSession} from '@/lib/auth';
import {getDashboard} from '@/lib/data';
import Dashboard from '@/components/dashboard';
export const dynamic='force-dynamic';
export default async function Page({params,searchParams}:{params:Promise<{section?:string[]}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await requireSession();const {section}=await params;const name=section?.join('/')??'visao-geral';
 if(!['visao-geral','produtos','filiais','concorrencia'].includes(name))notFound();
 const raw=await searchParams;const query=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,Array.isArray(v)?v[0]:v]));
 let data=null;try{data=await getDashboard(query);}catch{/* Render a recoverable state without fake production data. */}
 return <Dashboard section={name} data={data}/>;
}
