import {parseFilters,stores,type Filters} from './index';

// Only explicit, recognized entities may override the dashboard selection.
export function resolveChatFilters(question:string,selected:Filters,years:number[]):Filters {
 const text=question.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\bq*uadrimestre/g,'quadrimestre');
 const mentionedYears=[...new Set(text.match(/\b20\d{2}\b/g)??[])];
 const cities=stores.filter(store=>text.includes(store.name.toLowerCase()));
 if(mentionedYears.length>1||cities.length>1)throw new Error('Consulte um ano e uma filial por vez.');
 if(mentionedYears.some(year=>!years.includes(Number(year))))throw new Error('O ano informado não está disponível nos dados.');
 const quarter=text.match(/\b([123]|primeir[oa]|segund[oa]|terceir[oa])\s*(?:º|o|°)?\s*quadrimestre/);
 const ordinal=quarter?({primeiro:1,primeira:1,segundo:2,segunda:2,terceiro:3,terceira:3}[quarter[1]]??Number(quarter[1])):null;
 const compare=/qual\s+(?:foi\s+o\s+)?quadrimestre|(?:compar|evolu|todos|entre).*quadrimestre/.test(text);
 return parseFilters({
  ano:String(mentionedYears[0]??selected.ano),
  loja:String(/toda a rede|rede inteira/.test(text)?0:cities[0]?.id??selected.loja),
  quadrimestre:String(ordinal??(compare?0:selected.quadrimestre))
 },years);
}
