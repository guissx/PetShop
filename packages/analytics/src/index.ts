export type Filters = { ano: number; quadrimestre: number; loja: number };
export type Row = Record<string, string | number | null>;
export type DashboardData = {
 filters: Filters; anos: number[]; resumo: Row | null; evolucao: Row[];
 produtos: Row[]; categorias: Row[]; estados: Row[]; filiais: Row[];
 comparacao: Row[]; concorrencia: Row[]; chatAvailable: boolean;
};
export const stores = [
 { id: 1, name: 'Salvador', lon: -38.5014, lat: -12.9714 },
 { id: 2, name: 'Itabuna', lon: -39.28, lat: -14.7856 },
 { id: 3, name: 'Feira de Santana', lon: -38.9556, lat: -12.2664 },
] as const;
export function parseFilters(params: Record<string, string | undefined>, anos: number[]): Filters {
 const latest = Math.max(...anos);
 if (!Number.isFinite(latest)) throw new Error('Nenhum período disponível.');
 const ano = params.ano === undefined ? latest : Number(params.ano);
 const quadrimestre = params.quadrimestre === undefined ? 0 : Number(params.quadrimestre);
 const loja = params.loja === undefined ? 0 : Number(params.loja);
 if (!anos.includes(ano) || ![0,1,2,3].includes(quadrimestre) || ![0,1,2,3].includes(loja)) throw new Error('Filtros inválidos.');
 return {ano, quadrimestre, loja};
}
export function scenario(base: number, percent: number) {
 if (!Number.isFinite(base) || base < 0 || !Number.isFinite(percent) || percent < -100 || percent > 1000) throw new Error('Cenário inválido: variação entre -100% e 1000%.');
 const projected = Math.round(base * (1 + percent/100) * 100) / 100;
 return { base, percent, projected, difference: Math.round((projected-base)*100)/100 };
}
export const money = (n: unknown) => n === null || n === undefined ? 'Não disponível' : new Intl.NumberFormat('pt-BR', {style:'currency',currency:'BRL',maximumFractionDigits:2}).format(Number(n));
export const integer = (n: unknown) => new Intl.NumberFormat('pt-BR').format(Number(n ?? 0));
export const percent = (n: unknown) => n === null || n === undefined ? 'Sem base comparável' : `${Number(n)>0?'+':''}${Number(n).toLocaleString('pt-BR',{maximumFractionDigits:1})}%`;
export const periodLabel = (f: Filters) => `${f.quadrimestre ? `${f.quadrimestre}º quadrimestre de ` : ''}${f.ano}`;
export const storeLabel = (id: number) => stores.find(s=>s.id===id)?.name ?? 'Toda a rede';
