import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {extrairTudo} from '../../etl/extract.mjs';
import {conformarTudo} from '../../etl/conform.mjs';
import {lit} from '../../etl/emit.mjs';
import {fileURLToPath} from 'node:url';
export async function createFixture(){
 const db=new PGlite({extensions:{btree_gist}});
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
 await db.exec(await readFile(new URL('../../sql/01_dw_ddl.sql',import.meta.url),'utf8'));
 const c=conformarTudo(extrairTudo(fileURLToPath(new URL('../../data',import.meta.url))));
 const products=new Map(c.catalogo.map((p,i)=>[p.id_produto,i+1]));
 async function insert(table,cols,rows,override=''){
  for(let i=0;i<rows.length;i+=500)await db.exec(`INSERT INTO public.${table} (${cols.join(',')}) ${override} VALUES ${rows.slice(i,i+500).map(r=>'('+r.map(lit).join(',')+')').join(',')}`);
 }
 await insert('dim_produto',['sk_produto','id_produto','produto','categoria','data_inicio'],c.catalogo.map(p=>[products.get(p.id_produto),p.id_produto,p.produto,p.categoria,'2020-01-01']),'OVERRIDING SYSTEM VALUE');
 await insert('dim_loja',['sk_loja','id_loja','loja','cidade','estado','data_inicio'],c.lojas.map(l=>[l.id_loja,l.id_loja,l.loja,l.cidade,l.estado,'2020-01-01']),'OVERRIDING SYSTEM VALUE');
 await insert('dim_estado_civil',['id_estado_civil','estado_civil'],c.estadoCivil.dominio.map(e=>[e.id,e.rotulo]));
 await insert('dim_data',['id_data','ano','quadrimestre'],c.calendario.map(d=>[d.id_data,d.ano,d.quadrimestre]));
 await insert('fat_vendas',['id_venda','sk_produto','sk_loja','id_data','quantidade','valor_venda','id_estado_civil'],c.fatos.map(f=>[f.id_venda,products.get(f.id_produto),f.id_loja,f.id_data,f.quantidade,f.valor_venda,f.id_estado_civil]));
 await insert('fat_concorrente',['id_concorrente','id_data','sk_produto','quantidade','valor_venda'],c.concorrente.map(f=>[f.id_concorrente,f.id_data,products.get(f.id_produto),f.quantidade,f.valor_venda]));
 await db.exec('GRANT USAGE ON SCHEMA public TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;');
 await db.exec(await readFile(new URL('../../sql/03_dashboard_views.sql',import.meta.url),'utf8'));
 return db;
}
