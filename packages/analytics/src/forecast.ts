import {money,percent,storeLabel,type Row,type Filters} from './index';
import {resolveChatFilters} from './chat-context';
import type {ChatMessage} from './assistant';

export function forecastIntent(text:string,lastYear:number,previousTargets:number[]=[]):number[]|null {
 const normalized=text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
 if(/%/.test(text))return null;
 let years=[...new Set((text.match(/\b(?:19|20|21)\d{2}\b/g)??[]).map(Number))];
 const explicit=/previs|prever|proje[cç]|estimar|estimativa|como serao|proximos? anos?/.test(normalized);
 const following=/ano seguinte|ano depois|proximo ano/.test(normalized);
 const count=normalized.match(/proximos\s+(\d+)\s+anos/);
 // Inherit prediction intent only for a short continuation, never a new question.
 const shortYear=/^(?:e\s+)?(?:(?:em|para|no|o|ano|de)\s+)*(?:19|20|21)\d{2}\s*[?.!]*$/.test(normalized.trim());
 const newTopic=/produto|vendid|categoria|estado civil|unidades|quantidade/.test(normalized);
 if(!explicit&&!count&&(newTopic||(!years.some(year=>year>lastYear)&&!(previousTargets.length&&(following||shortYear)))))return null;
 const range=normalized.match(/\b((?:19|20|21)\d{2})\s*(?:a|ate|[-–])\s*((?:19|20|21)\d{2})\b/);
 if(range){
  const first=Number(range[1]),last=Number(range[2]);
  if(last<first||last-first>=20)throw new Error('Previsão: use um intervalo crescente de até 20 anos por consulta.');
  years=Array.from({length:last-first+1},(_,i)=>first+i);
 }
 if(count){const n=Number(count[1]);if(n<1||n>20)throw new Error('Previsão: consulte de 1 a 20 anos por vez.');years=Array.from({length:n},(_,i)=>lastYear+i+1);}
 if(!years.length)years=[following&&previousTargets.length?Math.max(...previousTargets)+1:lastYear+1];
 if(years.length>20)throw new Error('Previsão: consulte até 20 anos por vez.');
 if(/lucro|margem|cliente|ticket|unidades|quantidade/.test(normalized))throw new Error('Previsão: esta estimativa usa faturamento. Não estima lucro, margem, clientes ou unidades.');
 return years.sort((a,b)=>a-b);
}

export function conversationFilters(messages:ChatMessage[],selected:Filters,years:number[]):Filters {
 let current=selected;
 for(const message of messages){
  if(message.role!=='user')continue;
  // Future years name a prediction horizon, never a historical view filter.
  const question=message.content.replace(/\b20\d{2}\b/g,year=>years.includes(Number(year))?year:'');
  try{current=resolveChatFilters(question,current,years);}catch{/* An earlier rejected question must not poison the next request. */}
 }
 return current;
}

export function forecastRevenue(rows:Row[],lastYear:number,target:number,store:number):string {
 if(!Number.isInteger(target))throw new Error('Previsão: informe um ano válido.');
 const quarters=(year:number)=>[1,2,3].map(q=>{
  const matches=rows.filter(row=>Number(row.ano)===year&&Number(row.quadrimestre)===q&&Number(row.id_loja)===store);
  if(matches.length!==1||matches[0].receita==null||!Number.isFinite(Number(matches[0].receita))||Number(matches[0].receita)<0)throw new Error('Previsão: são necessários dois anos consecutivos completos, com três quadrimestres cada.');
  return Number(matches[0].receita);
 });
 if(target<=lastYear){
  const actual=quarters(target);
  return `Faturamento realizado em ${target} · ${storeLabel(store)}\n\n${actual.map((value,i)=>`${i+1}º quadrimestre: ${money(value)}`).join('\n')}\nTotal realizado: ${money(actual.reduce((a,b)=>a+b,0))}.\n\nEste ano já possui dados históricos; os valores são realizados, não previsões.`;
 }
 const previous=quarters(lastYear-1),latest=quarters(lastYear);
 const previousTotal=previous.reduce((a,b)=>a+b,0),latestTotal=latest.reduce((a,b)=>a+b,0);
 if(previousTotal<=0||latestTotal<=0)throw new Error('Previsão: a receita dos anos-base precisa ser maior que zero.');
 const rate=latestTotal/previousTotal-1;
 const horizon=target-lastYear;
 const projected=latest.map(value=>Math.round(value*Math.pow(1+rate,horizon)*100)/100);
 if(projected.some(value=>!Number.isSafeInteger(Math.round(value*100))))throw new Error('Previsão: o crescimento acumulado ultrapassa o limite numérico. Escolha um horizonte menor.');
 const labels=['1º quadrimestre (jan–abr)','2º quadrimestre (mai–ago)','3º quadrimestre (set–dez)'];
 return `Previsão exploratória de faturamento para ${target} · ${storeLabel(store)}\n\n${projected.map((value,i)=>`${labels[i]}: ${money(value)}`).join('\n')}\nTotal estimado: ${money(projected.reduce((a,b)=>a+b,0))}.\n\nMétodo: variação anual de ${percent(rate*100)} entre ${lastYear-1} (${money(previousTotal)}) e ${lastYear} (${money(latestTotal)}), acumulada por ${horizon} ano(s). Cada quadrimestre de ${lastYear} foi multiplicado por (1 + taxa anual) elevado a ${horizon}, sem arredondar a taxa no cálculo.\n\nEstimativa baseada em dois anos de histórico, preservando a distribuição quadrimestral. Quanto mais distante o ano, maior a incerteza: preços, demanda e concorrência podem mudar. Não é garantia de resultado e não há intervalo de confiança calculado.\n\nBase utilizada: ${lastYear-1}–${lastYear}; ${storeLabel(store)}.`;
}
